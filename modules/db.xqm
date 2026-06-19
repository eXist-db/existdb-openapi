(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Database management endpoints — thin roaster wrapper.
 :
 : Every handler unpacks the roaster $request, delegates to the roaster-independent
 : db-core module (which owns all naming correctness and domain logic), and maps a
 : typed db-core error to an HTTP status. There is intentionally no business logic
 : here: db-core is the single implementation, shared in-process by other apps
 : (e.g. eXide) that import it directly rather than calling these endpoints over
 : HTTP. Keep this layer purely about HTTP framing — request unpacking, status
 : codes, error-to-response mapping.
 :)
module namespace db="http://exist-db.org/api/db";

import module namespace dbc="http://exist-db.org/api/db-core" at "db-core.xqm";
import module namespace roaster="http://e-editiones.org/roaster";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";
declare namespace dberr="http://exist-db.org/api/db-core/error";
declare namespace response="http://exist-db.org/xquery/response";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : Map a typed db-core error to a roaster HTTP response. The error's local-name
 : selects the status; $err:description becomes the "error" message; $err:value
 : (a map) contributes any extra fields (e.g. move/copy partial-state hints). Any
 : error code that is not one of db-core's own falls through to 500.
 :)
declare %private function db:error-response(
    $code as xs:QName, $description as xs:string?, $value as item()*
) {
    let $status :=
        (map {
            "bad-request": 400,
            "forbidden": 403,
            "not-found": 404,
            "conflict": 409,
            "server-error": 500
        }(local-name-from-QName($code)), 500)[1]
    let $extra := if ($value instance of map(*)) then $value else map {}
    (: Pin the response media-type to application/json. Otherwise an error mapped to
       a status the route doesn't declare in api.json falls back to roaster's
       application/xml default, and the error map fails with SENR0001 ("cannot
       serialize a map with the XML output method"). See eeditiones/roaster#127. :)
    return roaster:response($status, "application/json",
        map:merge((map { "error": $description }, $extra)), ())
};

(:~
 : List collection contents.
 : GET /api/db?path=/db/apps&recursive=&depth=&glob=&collections-only=
 :)
declare function db:list($request as map(*)) {
    try {
        dbc:list(
            string(($request?parameters?path, "/db")[1]),
            map {
                "recursive": string($request?parameters?recursive) = "true",
                "depth": xs:integer(($request?parameters?depth, 0)[1]),
                "glob": $request?parameters?glob,
                "collections-only": string($request?parameters?collections-only) = "true",
                "start": $request?parameters?start,
                "count": $request?parameters?count
            }
        )
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Get a resource's content.
 : GET /api/db/resource?path=/db/apps/myapp/index.xq[&method&indent&…&download=true]
 :
 : Returns the raw content: a binary resource is streamed as-is; an XML/text
 : resource has no stored byte form, so it is serialized from its node tree honoring
 : the serialization parameters (db-core builds them). The body IS the content —
 : metadata is a separate concern (GET /api/db/properties). download=true sets
 : Content-Disposition: attachment so the browser saves rather than renders.
 :)
declare function db:get-resource($request as map(*)) {
    try {
        let $wire := $request?parameters?path
        return
            if (empty($wire) or $wire = "")
            then roaster:response(400, map { "error": "Missing required parameter: path" })
            else
                (: resolve-stored (not to-stored) so the existence check + binary
                   streaming below honor legacy full-encoded names, consistent with
                   dbc:get-resource / dbc:properties (read-compat for old clients). :)
                let $stored := dbc:resolve-stored($wire)
                return
                    if (not(doc-available($stored)) and not(util:binary-doc-available($stored)))
                    then roaster:response(404, map { "error": "Resource not found: " || dbc:to-display($stored) })
                    else
                        let $mime := xmldb:get-mime-type(xs:anyURI($stored))
                        (: download=true → Content-Disposition: attachment (a save, not the
                           "inline" that stream-binary's filename arg would set). Bound and
                           forced via [last()] so it is set before the body is streamed. :)
                        let $disp :=
                            if ($request?parameters?download = ("true", "yes", "1"))
                            then response:set-header("Content-Disposition",
                                'attachment; filename="' || replace(dbc:to-display($stored), "^.*/", "") || '"')
                            else ()
                        return
                            if (util:binary-doc-available($stored))
                            then ($disp, util:binary-doc($stored) => response:stream-binary($mime, ()))[last()]
                            else
                                (: XML/text: serialized from the node tree with the requested
                                   params. A serialization failure (e.g. an invalid param value)
                                   surfaces as a clean 400, not an opaque 500. :)
                                let $content :=
                                    try { dbc:get-resource($wire, $request?parameters)?content }
                                    catch * { map { "ser-error": $err:description } }
                                return
                                    if ($content instance of map(*))
                                    then roaster:response(400,
                                        map { "error": "Serialization failed (an unsupported parameter for this eXist?): " || $content?("ser-error") })
                                    else ($disp, util:string-to-binary($content) => response:stream-binary($mime, ()))[last()]
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Store a resource from a raw request body (binary-safe).
 : PUT /api/db/resource?path=/db/apps/myapp/data.bin[&mime=…]
 :
 : The path is a query param; the request body is the raw content (roaster hands a
 : non-json/xml body through unparsed). The stored mime comes from the optional
 : &mime query param when present, otherwise db-core infers it from the resource
 : name. The request's own Content-Type is transport only and not used as the
 : stored mime (HTTP clients send unpredictable defaults; an explicit &mime keeps
 : it deterministic and still lets a caller force a type, e.g. application/octet-
 : stream to store unparseable content as raw bytes). Returns { path } — 201
 : created / 200 overwritten — so the caller can reconcile name normalization.
 :)
declare function db:store-resource($request as map(*)) {
    try {
        let $path := $request?parameters?path
        return
            if (empty($path) or $path = "")
            then roaster:response(400, map { "error": "Missing required parameter: path" })
            else
                let $mime := $request?parameters?mime[. ne ""]
                let $result := dbc:store($path, $request?body, $mime)
                return roaster:response(
                    if ($result?created) then 201 else 200,
                    map { "path": $result?stored }
                )
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Remove resource.
 : DELETE /api/db/resource?path=...
 :)
declare function db:remove-resource($request as map(*)) {
    try {
        dbc:remove-resource($request?parameters?path)
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Create collection.
 : POST /api/db/collection
 :)
declare function db:create-collection($request as map(*)) {
    try {
        roaster:response(201, dbc:create-collection($request?body?path, $request?body?recursive = true()))
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Remove collection.
 : DELETE /api/db/collection?path=...&force=
 :)
declare function db:remove-collection($request as map(*)) {
    try {
        dbc:remove-collection(
            $request?parameters?path,
            string($request?parameters?force) = "true"
        )
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Move or rename a resource or collection.
 : POST /api/db/move  — body { source, parent?, name?, newName? }
 :)
declare function db:move($request as map(*)) {
    try {
        dbc:move($request?body)
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Copy a resource or collection.
 : POST /api/db/copy  — body { source, parent?, name?, newName? }
 :)
declare function db:copy($request as map(*)) {
    try {
        dbc:copy($request?body)
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Get properties of a resource or collection.
 : GET /api/db/properties?path=...
 :)
declare function db:properties($request as map(*)) {
    try {
        dbc:properties($request?parameters?path)
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Set permissions on a resource or collection.
 : POST /api/db/permissions  — body { path, owner?, group?, mode? }
 :)
declare function db:set-permissions($request as map(*)) {
    try {
        dbc:set-permissions($request?body)
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Sync tree with timestamps.
 : GET /api/db/sync?root=/db&timestamp=...
 :)
declare function db:sync($request as map(*)) {
    try {
        let $timestamp-param := $request?parameters?timestamp
        return dbc:sync(
            string(($request?parameters?root, "/db")[1]),
            if ($timestamp-param) then xs:dateTime($timestamp-param) else ()
        )
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Module discovery for IDE import assistance.
 : GET /api/modules?path=...&prefix=...&uri=...
 :)
declare function db:modules($request as map(*)) {
    try {
        dbc:modules(map {
            "path": $request?parameters?path,
            "prefix": $request?parameters?prefix,
            "uri": $request?parameters?uri
        })
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};
