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
    return roaster:response($status, map:merge((map { "error": $description }, $extra)))
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
                "collections-only": string($request?parameters?collections-only) = "true"
            }
        )
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Get resource content.
 : GET /api/db/resource?path=/db/apps/myapp/index.xq
 :)
declare function db:get-resource($request as map(*)) {
    try {
        dbc:get-resource($request?parameters?path)
    } catch * {
        db:error-response($err:code, $err:description, $err:value)
    }
};

(:~
 : Store resource.
 : PUT /api/db/resource
 :)
declare function db:store-resource($request as map(*)) {
    try {
        let $body := $request?body
        let $result := dbc:store($body?path, $body?content, $body?mime-type)
        return roaster:response(
            if ($result?created) then 201 else 200,
            map:remove($result, "created")
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
        roaster:response(201, dbc:create-collection($request?body?path))
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
