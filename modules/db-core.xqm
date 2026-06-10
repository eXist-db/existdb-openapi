(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Database management — roaster-independent CORE.
 :
 : Plain collection/resource CRUD over the xmldb:* and sm:* broker functions,
 : with all resource-naming correctness (db-core:to-stored / db-core:to-display)
 : living here. Functions take ordinary arguments (a wire path + an options map)
 : and return plain maps; failures are signalled as TYPED ERRORS in the
 : http://exist-db.org/api/db-core/error namespace (see db-core:error), never as
 : HTTP responses. The roaster layer (db.xqm) is a thin wrapper that unpacks the
 : request, calls these functions, and maps a typed error to an HTTP status. eXide
 : (and any other in-process caller) imports this module directly — no HTTP hop,
 : no re-auth — and maps the same plain maps to its own response shape.
 :
 : This module imports NO roaster and emits NO HTTP semantics. The single source
 : of truth for naming and domain validation; the wrapper owns only HTTP framing.
 :)
module namespace dbc = "http://exist-db.org/api/db-core";

(: dbutils is imported by namespace (no `at` hint) so this module resolves both
 : when loaded relatively (inside existdb-openapi) and when loaded by a consumer
 : via db-core's public-module registration, where a relative hint has no base
 : URI. Both db-core and dbutils are registered as public XQuery modules in
 : xar-assembly.xml. :)
import module namespace dbutil="http://exist-db.org/api/dbutils";

declare namespace sm="http://exist-db.org/xquery/securitymanager";
declare namespace expath="http://expath.org/ns/pkg";
declare namespace dberr="http://exist-db.org/api/db-core/error";
declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

(:~ Protected paths that cannot be deleted. :)
declare variable $dbc:protected-paths := (
    "/", "/db", "/db/apps", "/db/system"
);

(:~
 : Raise a typed db-core error. The local-name is one of the documented codes
 : (bad-request, not-found, forbidden, conflict, server-error); the wrapper maps
 : it to an HTTP status. $data carries any extra fields the response should
 : include alongside "error" (e.g. move/copy partial-state hints); pass an empty
 : map when there are none.
 :)
declare %private function dbc:error($code as xs:string, $message as xs:string, $data as map(*)) {
    error(xs:QName("dberr:" || $code), $message, $data)
};

(:~
 : Resource-name encoding boundary.
 :
 : This API speaks DECODED UTF-8 on the wire, both directions: a client (and its
 : user) sees and sends "café.xml", never "caf%C3%A9.xml". But eXist stores names
 : percent-encoded, and doc()/collection()/xmldb:*-available plus the xmldb:* write
 : functions all resolve against that stored form. So names cross two boundaries:
 :
 :   - db-core:to-stored : an incoming wire path -> the stored form, applied once at
 :     the top of every operation before any database call. It uses fn:iri-to-uri,
 :     which is the SAME escaping eXist's storage layer applies (AnyURIValue /
 :     escape-uri with escape-reserved=false): it percent-encodes spaces and
 :     non-ASCII but leaves sub-delims (' & + @ ( )) and existing %XX untouched.
 :     That matters:
 :       * it exactly matches how xmldb:store wrote the name, so the round trip is
 :         lossless for non-ASCII AND for the literal-sub-delim names xmldb:store
 :         leaves un-encoded (e.g. "quote'name.xml"); and
 :       * it is idempotent on already-encoded input, so older clients that still
 :         send "caf%C3%A9.xml" keep working (no double-encoding).
 :     (This is intentionally NOT xmldb:encode/encode-uri, which would full RFC-3986
 :     encode the sub-delims and so fail to find names xmldb:store left literal.)
 :
 :   - db-core:to-display : a stored path/name -> the wire (decoded) form, applied to
 :     every name and path leaving the API. Inverse of the %XX encoding above.
 :)
declare function dbc:to-stored($path as xs:string?) as xs:string? {
    if (empty($path)) then $path else fn:iri-to-uri($path)
};

declare function dbc:to-display($path as xs:string?) as xs:string? {
    if (empty($path)) then $path
    else string-join(
        for $segment in tokenize($path, "/")
        return
            if ($segment eq "") then ""
            (: xmldb:decode-uri form-decodes "+" to a space (the x-www-form-urlencoded
             : convention; eXist-db/exist#1824), but a "+" in a STORED name is always a
             : literal "+" -- spaces are stored as %20. Protect literal "+" as %2B so it
             : decodes back to "+", staying symmetric with db-core:to-stored /
             : fn:iri-to-uri, which leaves "+" untouched on the encode side. This mirrors
             : what URIUtils.decodeForURI (the core fix in eXist-db/exist#6451) does,
             : applied at the API layer so it is correct independent of the core build. :)
            else xmldb:decode-uri(xs:anyURI(replace($segment, "\+", "%2B"))),
        "/"
    )
};

(:~
 : Convert a glob pattern to a regex.
 : Supports *, ?, and character classes [...].
 :)
declare %private function dbc:glob-to-regex($glob as xs:string) as xs:string {
    let $escaped := replace($glob, "([\.\+\^\$\{\}\(\)\|\\])", "\\$1")
    let $stars := replace($escaped, "\*", ".*")
    let $questions := replace($stars, "\?", ".")
    return "^" || $questions || "$"
};

(:~
 : Get permissions metadata for a path using sm:get-permissions().
 : Returns map with mode, owner, group.
 :)
declare %private function dbc:get-permissions($path as xs:string) as map(*) {
    let $perm := sm:get-permissions(xs:anyURI($path))/sm:permission
    return map {
        "mode": $perm/@mode/string(),
        "owner": $perm/@owner/string(),
        "group": $perm/@group/string(),
        "acl": array {
            for $ace in $perm/sm:acl/sm:ace
            return map {
                "target": string($ace/@target),
                "who": string($ace/@who),
                "access": string($ace/@access_type),
                "mode": string($ace/@mode)
            }
        }
    }
};

(:~
 : Get full metadata for a collection.
 :)
declare %private function dbc:get-collection-info($path as xs:string) as map(*) {
    let $name := replace($path, "^.*/", "")
    let $perms := dbc:get-permissions($path)
    return map {
        "type": "collection",
        "name": dbc:to-display($name),
        "path": dbc:to-display($path),
        (: writable: can THIS caller write here? — a file-browser affordance,
         : evaluated authoritatively (mode + ACL + dba) by sm:has-access rather
         : than left for the client to derive from the mode bits. :)
        "writable": sm:has-access(xs:anyURI($path), "w"),
        "mode": $perms?mode,
        "owner": $perms?owner,
        "group": $perms?group,
        "acl": $perms?acl,
        "size": 0,
        "modified": string(xmldb:created($path)),
        "created": string(xmldb:created($path))
    }
};

(:~
 : Get full metadata for a resource.
 :)
declare %private function dbc:get-resource-info($collection as xs:string, $resource as xs:string) as map(*) {
    let $path := $collection || "/" || $resource
    let $perms := dbc:get-permissions($path)
    return map {
        "type": "resource",
        "name": dbc:to-display($resource),
        "path": dbc:to-display($path),
        (: see db-core:get-collection-info for the writable rationale :)
        "writable": sm:has-access(xs:anyURI($path), "w"),
        "mime-type": xmldb:get-mime-type(xs:anyURI($path)),
        "mode": $perms?mode,
        "owner": $perms?owner,
        "group": $perms?group,
        "acl": $perms?acl,
        "size": xmldb:size($collection, $resource),
        "modified": string(xmldb:last-modified($collection, $resource)),
        "created": string(xmldb:created($collection, $resource))
    }
};

(:~
 : List collection contents recursively.
 : @param $path collection path (stored form)
 : @param $depth current depth (1-based)
 : @param $max-depth max depth (0 = unlimited)
 : @param $glob-regex regex pattern for filtering resource names (empty string = no filter)
 : @param $collections-only if true, only list collections
 : @return map with collection info and children array
 :)
declare %private function dbc:list-recursive(
    $path as xs:string,
    $depth as xs:integer,
    $max-depth as xs:integer,
    $glob-regex as xs:string,
    $collections-only as xs:boolean
) as map(*) {
    let $info := dbc:get-collection-info($path)
    let $child-collections :=
        for $child in xmldb:get-child-collections($path)
        let $child-path := $path || "/" || $child
        order by $child
        return
            if ($max-depth eq 0 or $depth lt $max-depth)
            then dbc:list-recursive($child-path, $depth + 1, $max-depth, $glob-regex, $collections-only)
            else dbc:get-collection-info($child-path)
    let $resources :=
        if ($collections-only)
        then ()
        else
            for $resource in xmldb:get-child-resources($path)
            where $glob-regex eq "" or matches($resource, $glob-regex)
            order by $resource
            return dbc:get-resource-info($path, $resource)
    return map:merge((
        $info,
        map {
            "children": array { $child-collections, $resources }
        }
    ))
};

(:~
 : List collection contents.
 : @param $wire-path collection path (wire/decoded form)
 : @param $opts { recursive: xs:boolean, depth: xs:integer (0 = unlimited),
 :                glob: xs:string?, collections-only: xs:boolean,
 :                start: xs:integer? (1-based page offset, default 1),
 :                count: xs:integer? (page size, default = all) }
 : Every listed item carries a `writable` flag. The flat (non-recursive) listing
 : carries pagination fields on the envelope — `total` (full child count before
 : slicing), `start` (1-based offset of this page) and `count` (items in this
 : page) — child collections then resources, sliced by start/count. Pagination
 : does not apply to a recursive (tree) listing.
 : @error not-found if the collection does not exist
 :)
declare function dbc:list($wire-path as xs:string, $opts as map(*)) as map(*) {
    let $path := dbc:to-stored($wire-path)
    let $recursive := $opts?recursive
    let $depth := $opts?depth
    let $glob := $opts?glob
    let $collections-only := $opts?collections-only
    let $glob-regex := if (exists($glob) and $glob ne "") then dbc:glob-to-regex($glob) else ""
    return
        if (not(xmldb:collection-available($path)))
        then dbc:error("not-found", "Collection not found: " || dbc:to-display($path), map {})
        else if ($recursive)
        then dbc:list-recursive($path, 1, $depth, $glob-regex, $collections-only)
        else
            let $info := dbc:get-collection-info($path)
            let $child-collections :=
                for $child in xmldb:get-child-collections($path)
                order by $child
                return dbc:get-collection-info($path || "/" || $child)
            let $resources :=
                if ($collections-only)
                then ()
                else
                    for $resource in xmldb:get-child-resources($path)
                    where $glob-regex eq "" or matches($resource, $glob-regex)
                    order by $resource
                    return dbc:get-resource-info($path, $resource)
            (: Pagination over the full ordered child sequence (collections then
             : resources). start is 1-based; count defaults to "all" when absent. :)
            let $all-children := ($child-collections, $resources)
            let $total := count($all-children)
            let $start := xs:integer(($opts?start, 1)[1])
            let $count := $opts?count
            let $page :=
                if (exists($count))
                then subsequence($all-children, $start, xs:integer($count))
                else subsequence($all-children, $start)
            return map:merge((
                $info,
                map {
                    "total": $total,
                    "start": $start,
                    "count": count($page),
                    "children": array { $page }
                }
            ))
};

(:~
 : Resource metadata (permissions + size/timestamps), excluding the path and
 : mime-type that the content result already carries. These are the same keys
 : db-core:properties returns for a resource, so a single metadata parser works
 : across both /properties and a `meta=full` content read.
 :)
declare %private function dbc:resource-metadata($path as xs:string) as map(*) {
    let $collection := replace($path, "/[^/]+$", "")
    let $resource := replace($path, "^.*/", "")
    let $perms := dbc:get-permissions($path)
    return map {
        "owner": $perms?owner,
        "group": $perms?group,
        "mode": $perms?mode,
        "acl": $perms?acl,
        "size": xmldb:size($collection, $resource),
        "created": string(xmldb:created($collection, $resource)),
        "last-modified": string(xmldb:last-modified($collection, $resource))
    }
};

(:~
 : Get resource content.
 : @param $wire-path resource path (wire/decoded form)
 : @param $opts { meta: "full"? } — when meta = "full", the resource's metadata
 :        (owner, group, mode, acl, size, created, last-modified) is flattened
 :        into the result alongside the content, sparing a second /properties
 :        round trip. The result always carries `runPath` (the URL to execute a
 :        stored resource).
 : @error not-found if the resource does not exist
 :)
declare function dbc:get-resource($wire-path as xs:string?, $opts as map(*)) as map(*) {
    let $path := dbc:to-stored($wire-path)
    return
        if (empty($path))
        then dbc:error("bad-request", "Missing required parameter: path", map {})
        else if (not(doc-available($path)) and not(util:binary-doc-available($path)))
        then dbc:error("not-found", "Resource not found: " || dbc:to-display($path), map {})
        else
            let $ser := dbc:serialization-params($opts)
            let $base :=
                if (util:binary-doc-available($path))
                then map {
                    "path": dbc:to-display($path),
                    "binary": true(),
                    "content": util:binary-to-string(util:binary-doc($path)),
                    "mime-type": xmldb:get-mime-type(xs:anyURI($path)),
                    "runPath": dbc:get-run-path($path)
                }
                else map {
                    "path": dbc:to-display($path),
                    "binary": false(),
                    "content":
                        if (exists($ser))
                        then serialize(doc($path), $ser)
                        else serialize(doc($path)),
                    "mime-type": xmldb:get-mime-type(xs:anyURI($path)),
                    "runPath": dbc:get-run-path($path)
                }
            return
                if ($opts?meta = "full")
                then map:merge(($base, dbc:resource-metadata($path)))
                else $base
};

(:~
 : Build an output:serialization-parameters element from the W3C serialization
 : parameters present in $opts, or the empty sequence when none are given (so the
 : caller falls back to a bare serialize() = the conf.xml serializer defaults;
 : today's behavior, unchanged). Only keys the caller explicitly supplied are
 : emitted, so omitted parameters keep deferring to conf.xml. Boolean params
 : accept yes/no (the cursor query-results vocabulary) and tolerate true/false.
 :
 : NOTE: eXist's `expand-xincludes` serializer extension is deliberately NOT
 : handled here. As of eXist 7.0.0-beta3 it cannot be honored for node->string
 : serialization in XQuery (fn:serialize always expands; util:serialize was
 : removed; the REST layer hard-codes expand-xincludes=yes). Advertising it while
 : silently expanding would give clients a false guarantee and risk destroying
 : <xi:include> on save. Tracked separately pending an eXist-core fix.
 :)
declare %private function dbc:serialization-params($opts as map(*)) as element(output:serialization-parameters)? {
    let $children := (
        if (exists($opts?method))
            then <output:method>{$opts?method}</output:method> else (),
        if (exists($opts?indent))
            then <output:indent>{dbc:yes-no($opts?indent)}</output:indent> else (),
        if (exists($opts?("omit-xml-declaration")))
            then <output:omit-xml-declaration>{dbc:yes-no($opts?("omit-xml-declaration"))}</output:omit-xml-declaration> else (),
        if (exists($opts?encoding))
            then <output:encoding>{$opts?encoding}</output:encoding> else (),
        if (exists($opts?("media-type")))
            then <output:media-type>{$opts?("media-type")}</output:media-type> else (),
        if (exists($opts?("item-separator")))
            then <output:item-separator>{$opts?("item-separator")}</output:item-separator> else ()
    )
    return
        if (empty($children))
        then ()
        else <output:serialization-parameters>{$children}</output:serialization-parameters>
};

(:~ Normalize a boolean serialization value to the W3C "yes"/"no" form. :)
declare %private function dbc:yes-no($value as xs:string) as xs:string {
    if (lower-case($value) = ("yes", "true", "1")) then "yes" else "no"
};

(:~
 : Fix permissions for newly stored XQuery files.
 : Sets execute permission on XQuery resources.
 :)
declare %private function dbc:fix-permissions($path as xs:string) {
    let $mime := xmldb:get-mime-type(xs:anyURI($path))
    return
        if ($mime eq "application/xquery")
        then sm:chmod(xs:anyURI($path), "u+x,g+x,o+x")
        else ()
};

(:~
 : Get the run path (URL to execute a stored resource).
 :)
declare %private function dbc:get-run-path($path as xs:string) as xs:string {
    let $app-root := repo:get-root()
    return
        if (starts-with($path, $app-root))
        then "/exist/apps/" || substring-after($path, $app-root)
        else "/exist/rest" || $path
};

(:~
 : Store a resource.
 : @param $wire-path target path (wire/decoded form)
 : @param $content resource content
 : @param $mime explicit mime type, or empty to let eXist infer from the name
 : @return { stored, runPath, created } — `created` is true when the resource did
 :         not previously exist (the wrapper maps it to HTTP 201 vs 200)
 : @error bad-request on missing fields, a path outside /db, or a store failure
 :)
declare function dbc:store($wire-path as xs:string?, $content as item()?, $mime as xs:string?) as map(*) {
    let $path := dbc:to-stored($wire-path)
    (: Explicit mime from the client wins. When omitted we pass through to
     : the 3-arg xmldb:store, which calls MimeTable.getContentTypeFor() on
     : the resource name internally (see XMLDBStore.java lines 152-154 in
     : eXist core) — so the server's mime-types.xml is the single source
     : of truth. The pre-fix code defaulted to "application/xml", which
     : routed .xq / .xqm / image content into the XML parser and either
     : failed (XPST0003 / "Content is not allowed in prolog") or stored
     : with the wrong content type. :)
    return
        if (empty($path) or empty($content))
        then dbc:error("bad-request", "Missing required fields: path, content", map {})
        else if (not(dbc:under-db($path)))
        then dbc:error("bad-request", "Path must be under /db: " || dbc:to-display($path), map {})
        else
            let $collection := replace($path, "/[^/]+$", "")
            let $resource := replace($path, "^.*/", "")
            let $is-new := not(doc-available($path)) and not(util:binary-doc-available($path))
            return
                try {
                    let $stored :=
                        if (util:binary-doc-available($path))
                        then xmldb:store-as-binary($collection, $resource, $content)
                        else if (exists($mime))
                        then xmldb:store($collection, $resource, $content, $mime)
                        else xmldb:store($collection, $resource, $content)
                    let $_ := if ($is-new) then dbc:fix-permissions($stored) else ()
                    return map {
                        "stored": dbc:to-display($stored),
                        "runPath": dbc:get-run-path($stored),
                        "created": $is-new
                    }
                } catch * {
                    (: The store failed — most commonly because the content
                     : wasn't well-formed XML and the target mime was an
                     : XML-class type (application/xml, text/html,
                     : application/xhtml+xml, …). Surface the parse error
                     : as a bad-request with the eXist message; clients who
                     : want the raw bytes preserved can re-send with an
                     : explicit `mime-type: application/octet-stream`, which
                     : routes around the XML parser. :)
                    dbc:error("bad-request",
                        replace(replace($err:description, "^.*XMLDBException:", ""), "\[at.*\]$", ""),
                        map {})
                }
};

(:~
 : Check if a path is protected from deletion.
 :)
declare %private function dbc:is-protected($path as xs:string) as xs:boolean {
    $path = $dbc:protected-paths
    or
    starts-with($path, "/db/system/")
};

(:~
 : Guard: a write target must live in the database — i.e. be "/db" itself or a
 : descendant ("/db/…"). Rejects sibling-looking paths such as "/dbfoo" that
 : start with "/db" textually but are not under the /db root. Interim band-aid
 : at the API boundary pending the eXist-core resource-naming work.
 :)
declare function dbc:under-db($path as xs:string?) as xs:boolean {
    exists($path) and ($path = "/db" or starts-with($path, "/db/"))
};

(:~
 : Remove a resource.
 : @param $wire-path resource path (wire/decoded form)
 : @error bad-request outside /db, forbidden on a protected path, not-found if absent
 :)
declare function dbc:remove-resource($wire-path as xs:string?) as map(*) {
    let $path := dbc:to-stored($wire-path)
    return
        if (empty($path))
        then dbc:error("bad-request", "Missing required parameter: path", map {})
        else if (not(dbc:under-db($path)))
        then dbc:error("bad-request", "Path must be under /db: " || dbc:to-display($path), map {})
        else if (dbc:is-protected($path))
        then dbc:error("forbidden", "Cannot delete protected path: " || dbc:to-display($path), map {})
        else if (not(doc-available($path)) and not(util:binary-doc-available($path)))
        then dbc:error("not-found", "Resource not found: " || dbc:to-display($path), map {})
        else
            let $collection := replace($path, "/[^/]+$", "")
            let $resource := replace($path, "^.*/", "")
            let $_ := xmldb:remove($collection, $resource)
            return map { "removed": dbc:to-display($path) }
};

(:~
 : Create a collection.
 : @param $wire-path collection path (wire/decoded form)
 : @error bad-request on a missing path or a path outside /db
 :)
declare function dbc:create-collection($wire-path as xs:string?) as map(*) {
    let $path := dbc:to-stored($wire-path)
    return
        if (empty($path))
        then dbc:error("bad-request", "Missing required field: path", map {})
        else if (not(dbc:under-db($path)))
        then dbc:error("bad-request", "Path must be under /db: " || dbc:to-display($path), map {})
        else
            let $parent := replace($path, "/[^/]+$", "")
            let $name := replace($path, "^.*/", "")
            let $created := xmldb:create-collection($parent, $name)
            return map { "created": dbc:to-display($created) }
};

(:~
 : Remove a collection.
 : @param $wire-path collection path (wire/decoded form)
 : @param $force if true, delete even if non-empty
 : @error bad-request outside /db, forbidden on a protected path, not-found if
 :        absent, conflict if non-empty and not forced
 :)
declare function dbc:remove-collection($wire-path as xs:string?, $force as xs:boolean) as map(*) {
    let $path := dbc:to-stored($wire-path)
    return
        if (empty($path))
        then dbc:error("bad-request", "Missing required parameter: path", map {})
        else if (not(dbc:under-db($path)))
        then dbc:error("bad-request", "Path must be under /db: " || dbc:to-display($path), map {})
        else if (dbc:is-protected($path))
        then dbc:error("forbidden", "Cannot delete protected path: " || dbc:to-display($path), map {})
        else if (not(xmldb:collection-available($path)))
        then dbc:error("not-found", "Collection not found: " || dbc:to-display($path), map {})
        else
            let $has-children :=
                exists(xmldb:get-child-collections($path))
                or exists(xmldb:get-child-resources($path))
            return
                if ($has-children and not($force))
                then dbc:error("conflict", "Collection is not empty: " || dbc:to-display($path) || ". Use force=true to delete recursively.", map {})
                else
                    let $_ := xmldb:remove($path)
                    return map { "removed": dbc:to-display($path) }
};

(:~ Does a stored path resolve to an existing collection or document? :)
declare %private function dbc:exists-at($path as xs:string?) as xs:boolean {
    exists($path)
    and string-length($path) gt 0
    and (
        xmldb:collection-available($path)
        or doc-available($path)
        or util:binary-doc-available($path)
    )
};

(:~
 : Move or rename a resource or collection.
 :
 : Two call shapes (mirrors eXist's XML-RPC moveResource/moveCollection
 : signature — explicit destination parent collection + optional new leaf name):
 :   1. {source, parent, name?}  — move `source` into the existing collection
 :      `parent`. If `name` is given, the moved item takes that leaf name;
 :      otherwise it keeps source's leaf.
 :   2. {source, newName}        — friendlier shortcut for in-place rename.
 : Either `parent` or `newName` is required. `parent`, if supplied, must refer to
 : an existing collection.
 :
 : @param $args { source, parent?, name?, newName? } (wire/decoded form)
 : @error bad-request on missing/invalid fields, not-found on a missing source,
 :        conflict if the destination already exists, server-error mid-operation
 :)
declare function dbc:move($args as map(*)) as map(*) {
    let $source := dbc:to-stored($args?source)
    let $parent := dbc:to-stored($args?parent)
    let $name := dbc:to-stored($args?name)
    let $newName := dbc:to-stored($args?newName)
    let $src-parent := if (exists($source)) then replace($source, "/[^/]+$", "") else ()
    let $src-leaf := if (exists($source)) then replace($source, "^.*/", "") else ()
    let $dest-parent := ($parent, $src-parent)[1]
    let $dest-name := ($name, $newName, $src-leaf)[1]
    let $dest-path :=
        if (exists($dest-parent) and exists($dest-name))
        then $dest-parent || "/" || $dest-name
        else ()
    return
        if (empty($source)) then
            dbc:error("bad-request", "Missing required field: source", map {})
        else if (not(dbc:under-db($source))) then
            dbc:error("bad-request", "Path must be under /db: " || dbc:to-display($source), map {})
        else if (not(dbc:exists-at($source))) then
            dbc:error("not-found", "Source not found: " || dbc:to-display($source), map {})
        else if (empty($parent) and empty($newName)) then
            dbc:error("bad-request", "Missing required field: parent or newName", map {})
        else if (exists($parent) and not(dbc:under-db($parent))) then
            dbc:error("bad-request", "Path must be under /db: " || dbc:to-display($parent), map {})
        else if (exists($parent) and not(xmldb:collection-available($parent))) then
            dbc:error("bad-request", "Destination parent collection does not exist: " || dbc:to-display($parent), map {})
        else if (
            $dest-path ne $source
            and (
                xmldb:collection-available($dest-path)
                or doc-available($dest-path)
                or util:binary-doc-available($dest-path)
            )
        ) then
            (: Refuse to overwrite an existing destination. eXist's xmldb:move
             : silently replaces whatever is at the target, which can delete
             : unrelated data — surface this as a conflict so the client can
             : confirm before destroying it. Closes the silent-overwrite branch
             : of #37. :)
            dbc:error("conflict",
                "Destination already exists: " || dbc:to-display($dest-path) ||
                ". Remove it first or choose a different name.", map {})
        else
            (: Wrap the broker calls so a mid-operation xmldb:move failure
             : surfaces as a clean server-error with a message — not an
             : unhandled exception that obscures the state of source vs
             : destination. :)
            try {
                if (xmldb:collection-available($source)) then
                    let $_ := if ($dest-parent ne $src-parent)
                              then xmldb:move($source, $dest-parent)
                              else ()
                    let $intermediate :=
                        if ($dest-parent ne $src-parent)
                        then $dest-parent || "/" || $src-leaf
                        else $source
                    let $_ := if ($dest-name ne $src-leaf)
                              then xmldb:rename($intermediate, $dest-name)
                              else ()
                    return map { "moved": dbc:to-display($source), "to": dbc:to-display($dest-path) }
                else
                    let $_ := if ($dest-parent ne $src-parent)
                              then xmldb:move($src-parent, $dest-parent, $src-leaf)
                              else ()
                    let $_ := if ($dest-name ne $src-leaf)
                              then xmldb:rename($dest-parent, $src-leaf, $dest-name)
                              else ()
                    return map { "moved": dbc:to-display($source), "to": dbc:to-display($dest-path) }
            } catch * {
                dbc:error("server-error", "Move failed mid-operation: " || $err:description, map {
                    "source": dbc:to-display($source),
                    "attempted-destination": dbc:to-display($dest-path),
                    "note": "Inspect source and destination paths — partial state may exist."
                })
            }
};

(:~
 : Copy a resource or collection.
 :
 : Two call shapes (mirrors eXist's XML-RPC copyResource/copyCollection
 : signature — explicit destination parent collection + optional new leaf name):
 :   1. {source, parent, name?}  — copy `source` into the existing collection
 :      `parent`. If `name` is given, the copy takes that leaf name; otherwise it
 :      keeps source's leaf.
 :   2. {source, newName}        — friendlier shortcut for duplicate-in-place.
 : Either `parent` or `newName` is required. `parent`, if supplied, must refer to
 : an existing collection.
 :
 : For collections, xmldb:copy-collection takes a target *parent* collection (no
 : rename arg) and refuses to copy into the source's own parent (it would
 : name-collide). When the destination would collide with the source — same
 : parent, same leaf — we use a disposable staging collection: copy in, rename
 : inside, move back, remove stager.
 :
 : @param $args { source, parent?, name?, newName? } (wire/decoded form)
 : @error bad-request on missing/invalid fields, not-found on a missing source,
 :        conflict if the destination already exists, server-error mid-operation
 :)
declare function dbc:copy($args as map(*)) as map(*) {
    let $source := dbc:to-stored($args?source)
    let $parent := dbc:to-stored($args?parent)
    let $name := dbc:to-stored($args?name)
    let $newName := dbc:to-stored($args?newName)
    let $src-parent := replace($source, "/[^/]+$", "")
    let $src-leaf := replace($source, "^.*/", "")
    let $source-exists :=
        xmldb:collection-available($source)
        or doc-available($source)
        or util:binary-doc-available($source)
    return
        if (empty($source)) then
            dbc:error("bad-request", "Missing required field: source", map {})
        else if (not(dbc:under-db($source))) then
            dbc:error("bad-request", "Path must be under /db: " || dbc:to-display($source), map {})
        else if (not($source-exists)) then
            dbc:error("not-found", "Source not found: " || dbc:to-display($source), map {})
        else if (empty($parent) and empty($newName)) then
            dbc:error("bad-request", "Missing required field: parent or newName", map {})
        else if (exists($parent) and not(dbc:under-db($parent))) then
            dbc:error("bad-request", "Path must be under /db: " || dbc:to-display($parent), map {})
        else if (exists($parent) and not(xmldb:collection-available($parent))) then
            dbc:error("bad-request", "Destination parent collection does not exist: " || dbc:to-display($parent), map {})
        else
            let $dest-parent := if (exists($parent)) then $parent else $src-parent
            let $dest-name := (
                $name[exists($name)],
                $newName[exists($newName)],
                $src-leaf
            )[1]
            let $dest-path := $dest-parent || "/" || $dest-name
            let $collides := $dest-parent eq $src-parent and $dest-name eq $src-leaf
            let $dest-exists :=
                not($collides)
                and (
                    xmldb:collection-available($dest-path)
                    or doc-available($dest-path)
                    or util:binary-doc-available($dest-path)
                )
            return
                if ($collides) then
                    dbc:error("bad-request", "Destination matches source — supply a new name to duplicate in place", map {})
                else if ($dest-exists) then
                    (: Refuse to overwrite an existing destination. eXist's
                     : xmldb:copy-collection / xmldb:copy-resource silently merge
                     : or replace, which can destroy unrelated data — surface
                     : this as a conflict so the client can confirm before
                     : proceeding. :)
                    dbc:error("conflict",
                        "Destination already exists: " || dbc:to-display($dest-path) ||
                        ". Remove it first or choose a different name.", map {})
                else
                    try {
                        if (xmldb:collection-available($source)) then
                            if ($dest-parent ne $src-parent) then
                                let $_ := xmldb:copy-collection($source, $dest-parent)
                                let $_ := if ($dest-name ne $src-leaf)
                                          then xmldb:rename($dest-parent || "/" || $src-leaf, $dest-name)
                                          else ()
                                return map { "copied": dbc:to-display($source), "to": dbc:to-display($dest-path) }
                            else
                                (: Same-parent collection copy: stage → rename → move back. :)
                                let $stage-name := "__copy-stage-" || util:uuid()
                                let $stage := $src-parent || "/" || $stage-name
                                let $_ := xmldb:create-collection($src-parent, $stage-name)
                                let $_ := xmldb:copy-collection($source, $stage)
                                let $_ := xmldb:rename($stage || "/" || $src-leaf, $dest-name)
                                let $_ := xmldb:move($stage || "/" || $dest-name, $src-parent)
                                let $_ := xmldb:remove($stage)
                                return map { "copied": dbc:to-display($source), "to": dbc:to-display($dest-path) }
                        else
                            let $_ := xmldb:copy-resource($src-parent, $src-leaf, $dest-parent, $dest-name)
                            return map { "copied": dbc:to-display($source), "to": dbc:to-display($dest-path) }
                    } catch * {
                        dbc:error("server-error", "Copy failed mid-operation: " || $err:description, map {
                            "source": dbc:to-display($source),
                            "attempted-destination": dbc:to-display($dest-path),
                            "note": "Inspect destination path — partial state may exist."
                        })
                    }
};

(:~
 : Get properties of a resource or collection.
 : @param $wire-path path (wire/decoded form)
 : @error not-found if neither a collection nor a document exists at the path
 :)
declare function dbc:properties($wire-path as xs:string?) as map(*) {
    let $path := dbc:to-stored($wire-path)
    return
        if (empty($path))
        then dbc:error("bad-request", "Missing required parameter: path", map {})
        else if (xmldb:collection-available($path))
        then
            let $perms := dbc:get-permissions($path)
            return map {
                "path": dbc:to-display($path),
                "type": "collection",
                "owner": $perms?owner,
                "group": $perms?group,
                "mode": $perms?mode,
                "acl": $perms?acl,
                "created": string(xmldb:created($path))
            }
        else if (doc-available($path) or util:binary-doc-available($path))
        then
            let $collection := replace($path, "/[^/]+$", "")
            let $resource := replace($path, "^.*/", "")
            let $perms := dbc:get-permissions($path)
            return
                map {
                    "path": dbc:to-display($path),
                    "type": "resource",
                    "owner": $perms?owner,
                    "group": $perms?group,
                    "mode": $perms?mode,
                    "acl": $perms?acl,
                    "mime-type": xmldb:get-mime-type(xs:anyURI($path)),
                    "size": xmldb:size($collection, $resource),
                    "created": string(xmldb:created($collection, $resource)),
                    "last-modified": string(xmldb:last-modified($collection, $resource))
                }
        else
            dbc:error("not-found", "Not found: " || dbc:to-display($path), map {})
};

(:~
 : Set permissions (and optionally the MIME type) on a resource or collection.
 : @param $args { path, owner?, group?, mode?, mime? } (wire/decoded form)
 :        `mime` sets the resource's content type (xmldb:set-mime-type); applies
 :        to resources, not collections.
 :)
declare function dbc:set-permissions($args as map(*)) as map(*) {
    let $path := dbc:to-stored($args?path)
    return
        if (empty($path))
        then dbc:error("bad-request", "Missing required field: path", map {})
        else
            (: A bad owner/group, malformed mode, or a mime incompatible with the
             : resource's storage class (eXist only lets an XML-stored resource take
             : an XML-class mime, and a binary resource a binary-class mime) makes
             : the broker call throw — surface that as a clean bad-request rather
             : than letting it become an undeclared 500. :)
            try {
                let $_ := (
                    if ($args?owner) then sm:chown(xs:anyURI($path), $args?owner) else (),
                    if ($args?group) then sm:chgrp(xs:anyURI($path), $args?group) else (),
                    if ($args?mode) then sm:chmod(xs:anyURI($path), $args?mode) else (),
                    if ($args?mime) then xmldb:set-mime-type(xs:anyURI($path), $args?mime) else ()
                )
                return map { "updated": dbc:to-display($path) }
            } catch * {
                dbc:error("bad-request", $err:description, map {})
            }
};

(:~
 : Sync tree with timestamps.
 : @param $wire-root root collection (wire/decoded form)
 : @param $timestamp only return resources modified after this time (or empty for all)
 : @error not-found if the root collection does not exist
 :)
declare function dbc:sync($wire-root as xs:string, $timestamp as xs:dateTime?) as map(*) {
    let $root := dbc:to-stored($wire-root)
    return
        if (not(xmldb:collection-available($root)))
        then dbc:error("not-found", "Collection not found: " || dbc:to-display($root), map {})
        else
            map {
                "root": dbc:to-display($root),
                "timestamp": string(current-dateTime()),
                "children": dbc:sync-collection(xs:anyURI($root), $timestamp)
            }
};

(:~
 : Recursively build sync tree for a collection.
 :)
declare %private function dbc:sync-collection(
    $root as xs:anyURI, $timestamp as xs:dateTime?
) as array(*) {
    array {
        for $child in xmldb:get-child-collections($root)
        let $path := $root || "/" || $child
        order by $child
        return map {
            "path": dbc:to-display($child),
            "lastModified": string(xmldb:created($path)),
            "children": dbc:sync-collection(xs:anyURI($path), $timestamp)
        },
        for $resource in xmldb:get-child-resources($root)
        let $last-modified :=
            try { xmldb:last-modified($root, $resource) }
            catch * { current-dateTime() }
        where empty($timestamp) or ($last-modified > $timestamp)
        order by $resource
        return map {
            "path": dbc:to-display($resource),
            "lastModified": string($last-modified)
        }
    }
};

(:~
 : Module discovery for IDE import assistance.
 : @param $args { path, prefix?, uri? } — `uri` is a comma-separated list of
 :        already-imported namespaces to exclude
 : @return importable modules from package-local files, mapped modules, and
 :         registered built-in modules
 :)
declare function dbc:modules($args as map(*)) as array(*) {
    let $path := dbc:to-stored($args?path)
    let $prefix := $args?prefix
    let $imported-param := $args?uri
    let $imported :=
        if ($imported-param)
        then tokenize($imported-param, ",")
        else ()
    let $path :=
        if (starts-with($path, "xmldb:exist://"))
        then substring-after($path, "xmldb:exist://")
        else $path
    let $pkg-root := dbc:get-package-root($path)
    let $pkg-root := if ($pkg-root) then $pkg-root else replace($path, "/[^/]+$", "")
    return array {
        (: Package-local XQuery modules :)
        for $info in dbc:scan-local-modules($pkg-root, $prefix, $imported)
        order by $info?prefix, $info?namespace
        return $info,
        (: Mapped and registered built-in modules :)
        for $info in dbc:mapped-modules($prefix, $imported)
        order by $info?prefix, $info?namespace
        return $info
    }
};

(:~
 : Find the package root for a given path.
 :)
declare %private function dbc:get-package-root($path as xs:string) as xs:string? {
    (
        for $pkg in collection(repo:get-root())/expath:package
        let $col := util:collection-name($pkg)
        where starts-with($path, $col)
        return $col
    )[1]
};

(:~
 : Scan for local XQuery library modules in a package.
 :)
declare %private function dbc:scan-local-modules(
    $pkg-root as xs:string, $prefix as xs:string?, $imported as xs:string*
) as map(*)* {
    dbutil:scan-resources(xs:anyURI($pkg-root), function($collection, $resource) {
        let $path := $collection || "/" || $resource
        where xmldb:get-mime-type(xs:anyURI($path)) = "application/xquery"
        return
            try {
                let $data := util:binary-doc($path)
                let $source := util:base64-decode($data)
                where matches($source, "^module\s+namespace", "m")
                let $match :=
                    analyze-string($source, "^module\s+namespace\s+([^\s=]+)\s*=\s*['\x22]([^'\x22]+)['\x22]", "m")//fn:match
                let $ns := $match/fn:group[2]/string()
                let $pfx := $match/fn:group[1]/string()
                where not($ns = $imported)
                where empty($prefix) or $pfx = $prefix
                return map {
                    "prefix": $pfx,
                    "namespace": $ns,
                    "source": $path,
                    "ref": "package"
                }
            } catch * { () }
    })
};

(:~
 : Get mapped and registered built-in modules.
 :)
declare %private function dbc:mapped-modules(
    $prefix as xs:string?, $imported as xs:string*
) as map(*)* {
    for $uri in (util:registered-modules(), util:mapped-modules())
    where not($uri = $imported)
    let $module :=
        try { inspect:inspect-module-uri(xs:anyURI($uri)) }
        catch * { () }
    where exists($module)
    where empty($prefix) or $module/@prefix = $prefix
    return map {
        "prefix": string($module/@prefix),
        "namespace": string($module/@uri),
        "source": string($module/@location),
        "ref": "global"
    }
};
