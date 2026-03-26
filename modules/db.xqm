xquery version "3.1";

(:~
 : Database management endpoints.
 : Collection and resource CRUD operations.
 :)
module namespace db="http://exist-db.org/api/db";

import module namespace dbutil="http://exist-db.org/api/dbutils" at "dbutils.xqm";
import module namespace roaster="http://e-editiones.org/roaster";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";
declare namespace sm="http://exist-db.org/xquery/securitymanager";
declare namespace expath="http://expath.org/ns/pkg";

declare option output:method "json";
declare option output:media-type "application/json";

(:~ Protected paths that cannot be deleted. :)
declare variable $db:protected-paths := (
    "/", "/db", "/db/apps", "/db/system"
);

(:~
 : Convert a glob pattern to a regex.
 : Supports *, ?, and character classes [...].
 :)
declare %private function db:glob-to-regex($glob as xs:string) as xs:string {
    let $escaped := replace($glob, "([\.\+\^\$\{\}\(\)\|\\])", "\\$1")
    let $stars := replace($escaped, "\*", ".*")
    let $questions := replace($stars, "\?", ".")
    return "^" || $questions || "$"
};

(:~
 : Get permissions metadata for a path using sm:get-permissions().
 : Returns map with mode, owner, group.
 :)
declare %private function db:get-permissions($path as xs:string) as map(*) {
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
declare %private function db:get-collection-info($path as xs:string) as map(*) {
    let $name := replace($path, "^.*/", "")
    let $perms := db:get-permissions($path)
    return map {
        "type": "collection",
        "name": $name,
        "path": $path,
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
declare %private function db:get-resource-info($collection as xs:string, $resource as xs:string) as map(*) {
    let $path := $collection || "/" || $resource
    let $perms := db:get-permissions($path)
    return map {
        "type": "resource",
        "name": $resource,
        "path": $path,
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
 : @param $path collection path
 : @param $depth current depth (1-based)
 : @param $max-depth max depth (0 = unlimited)
 : @param $glob-regex regex pattern for filtering resource names (empty string = no filter)
 : @param $collections-only if true, only list collections
 : @return map with collection info and children array
 :)
declare %private function db:list-recursive(
    $path as xs:string,
    $depth as xs:integer,
    $max-depth as xs:integer,
    $glob-regex as xs:string,
    $collections-only as xs:boolean
) as map(*) {
    let $info := db:get-collection-info($path)
    let $child-collections :=
        for $child in xmldb:get-child-collections($path)
        let $child-path := $path || "/" || $child
        order by $child
        return
            if ($max-depth eq 0 or $depth lt $max-depth)
            then db:list-recursive($child-path, $depth + 1, $max-depth, $glob-regex, $collections-only)
            else db:get-collection-info($child-path)
    let $resources :=
        if ($collections-only)
        then ()
        else
            for $resource in xmldb:get-child-resources($path)
            where $glob-regex eq "" or matches($resource, $glob-regex)
            order by $resource
            return db:get-resource-info($path, $resource)
    return map:merge((
        $info,
        map {
            "children": array { $child-collections, $resources }
        }
    ))
};

(:~
 : List collection contents.
 : GET /api/db?path=/db/apps
 :
 : Parameters:
 :   path           - collection path (default: /db)
 :   recursive      - list recursively (default: false)
 :   depth          - max recursion depth, 0 = unlimited (default: 0)
 :   glob           - glob pattern filter for resource names (e.g., "*.xq")
 :   collections-only - only list collections (default: false)
 :)
declare function db:list($request as map(*)) {
    let $path := string(($request?parameters?path, "/db")[1])
    let $recursive := string($request?parameters?recursive) = "true"
    let $depth := xs:integer(($request?parameters?depth, 0)[1])
    let $glob := $request?parameters?glob
    let $collections-only := string($request?parameters?collections-only) = "true"
    let $glob-regex := if (exists($glob) and $glob ne "") then db:glob-to-regex($glob) else ""
    return
        if (not(xmldb:collection-available($path)))
        then roaster:response(404, map { "error": "Collection not found: " || $path })
        else if ($recursive)
        then db:list-recursive($path, 1, $depth, $glob-regex, $collections-only)
        else
            let $info := db:get-collection-info($path)
            let $child-collections :=
                for $child in xmldb:get-child-collections($path)
                order by $child
                return db:get-collection-info($path || "/" || $child)
            let $resources :=
                if ($collections-only)
                then ()
                else
                    for $resource in xmldb:get-child-resources($path)
                    where $glob-regex eq "" or matches($resource, $glob-regex)
                    order by $resource
                    return db:get-resource-info($path, $resource)
            return map:merge((
                $info,
                map {
                    "children": array { $child-collections, $resources }
                }
            ))
};

(:~
 : Get resource content.
 : GET /api/db/resource?path=/db/apps/myapp/index.xq
 :)
declare function db:get-resource($request as map(*)) {
    let $path := $request?parameters?path
    return
        if (empty($path))
        then map { "error": "Missing required parameter: path" }
        else if (not(doc-available($path)) and not(util:binary-doc-available($path)))
        then roaster:response(404, map { "error": "Resource not found: " || $path })
        else if (util:binary-doc-available($path))
        then
            let $data := util:binary-doc($path)
            return map {
                "path": $path,
                "binary": true(),
                "content": util:binary-to-string($data),
                "mime-type": xmldb:get-mime-type(xs:anyURI($path))
            }
        else
            let $doc := doc($path)
            return map {
                "path": $path,
                "binary": false(),
                "content": serialize($doc),
                "mime-type": xmldb:get-mime-type(xs:anyURI($path))
            }
};

(:~
 : Store resource.
 : PUT /api/db/resource
 :)
(:~
 : Fix permissions for newly stored XQuery files.
 : Sets execute permission on XQuery resources.
 :)
declare %private function db:fix-permissions($path as xs:string) {
    let $mime := xmldb:get-mime-type(xs:anyURI($path))
    return
        if ($mime eq "application/xquery")
        then sm:chmod(xs:anyURI($path), "u+x,g+x,o+x")
        else ()
};

(:~
 : Get the run path (URL to execute a stored resource).
 :)
declare %private function db:get-run-path($path as xs:string) as xs:string {
    let $app-root := repo:get-root()
    return
        if (starts-with($path, $app-root))
        then "/exist/apps/" || substring-after($path, $app-root)
        else "/exist/rest" || $path
};

declare function db:store-resource($request as map(*)) {
    let $body := $request?body
    let $path := $body?path
    let $content := $body?content
    let $mime-type := ($body?mime-type, "application/xml")[1]
    return
        if (empty($path) or empty($content))
        then roaster:response(400, map { "error": "Missing required fields: path, content" })
        else
            let $collection := replace($path, "/[^/]+$", "")
            let $resource := replace($path, "^.*/", "")
            let $is-new := not(doc-available($path)) and not(util:binary-doc-available($path))
            return
                try {
                    let $stored :=
                        if (util:binary-doc-available($path))
                        then xmldb:store-as-binary($collection, $resource, $content)
                        else if ($mime-type)
                        then xmldb:store($collection, $resource, $content, $mime-type)
                        else xmldb:store($collection, $resource, $content)
                    let $_ := if ($is-new) then db:fix-permissions($stored) else ()
                    return roaster:response(
                        if ($is-new) then 201 else 200,
                        map {
                            "stored": $stored,
                            "runPath": db:get-run-path($stored)
                        }
                    )
                } catch * {
                    (: Fall back to binary store for HTML that isn't well-formed :)
                    if ($mime-type = "text/html")
                    then
                        let $stored := xmldb:store-as-binary($collection, $resource, $content)
                        let $_ := if ($is-new) then db:fix-permissions($stored) else ()
                        return roaster:response(
                            if ($is-new) then 201 else 200,
                            map {
                                "stored": $stored,
                                "runPath": db:get-run-path($stored)
                            }
                        )
                    else
                        roaster:response(400, map {
                            "error": replace(replace($err:description, "^.*XMLDBException:", ""), "\[at.*\]$", "")
                        })
                }
};

(:~
 : Check if a path is protected from deletion.
 :)
declare %private function db:is-protected($path as xs:string) as xs:boolean {
    $path = $db:protected-paths
    or
    starts-with($path, "/db/system/")
};

(:~
 : Remove resource.
 : DELETE /api/db/resource?path=...
 :)
declare function db:remove-resource($request as map(*)) {
    let $path := $request?parameters?path
    return
        if (empty($path))
        then roaster:response(400, map { "error": "Missing required parameter: path" })
        else if (db:is-protected($path))
        then roaster:response(403, map { "error": "Cannot delete protected path: " || $path })
        else if (not(doc-available($path)) and not(util:binary-doc-available($path)))
        then roaster:response(404, map { "error": "Resource not found: " || $path })
        else
            let $collection := replace($path, "/[^/]+$", "")
            let $resource := replace($path, "^.*/", "")
            let $_ := xmldb:remove($collection, $resource)
            return map { "removed": $path }
};

(:~
 : Create collection.
 : POST /api/db/collection
 :)
declare function db:create-collection($request as map(*)) {
    let $path := $request?body?path
    return
        if (empty($path))
        then roaster:response(400, map { "error": "Missing required field: path" })
        else
            let $parent := replace($path, "/[^/]+$", "")
            let $name := replace($path, "^.*/", "")
            let $created := xmldb:create-collection($parent, $name)
            return roaster:response(201, map { "created": $created })
};

(:~
 : Remove collection.
 : DELETE /api/db/collection?path=...
 :
 : Parameters:
 :   path  - collection path (required)
 :   force - if true, delete even if non-empty (default: false)
 :)
declare function db:remove-collection($request as map(*)) {
    let $path := $request?parameters?path
    let $force := string($request?parameters?force) = "true"
    return
        if (empty($path))
        then roaster:response(400, map { "error": "Missing required parameter: path" })
        else if (db:is-protected($path))
        then roaster:response(403, map { "error": "Cannot delete protected path: " || $path })
        else if (not(xmldb:collection-available($path)))
        then roaster:response(404, map { "error": "Collection not found: " || $path })
        else
            let $has-children :=
                exists(xmldb:get-child-collections($path))
                or exists(xmldb:get-child-resources($path))
            return
                if ($has-children and not($force))
                then roaster:response(409, map { "error": "Collection is not empty: " || $path || ". Use force=true to delete recursively." })
                else
                    let $_ := xmldb:remove($path)
                    return map { "removed": $path }
};

(:~
 : Move resource or collection.
 : POST /api/db/move
 :)
declare function db:move($request as map(*)) {
    let $body := $request?body
    let $source := $body?source
    let $target := $body?target
    return
        if (empty($source) or empty($target))
        then map { "error": "Missing required fields: source, target" }
        else if (xmldb:collection-available($source))
        then
            let $_ := xmldb:move($source, $target)
            return map { "moved": $source, "to": $target }
        else
            let $src-collection := replace($source, "/[^/]+$", "")
            let $src-resource := replace($source, "^.*/", "")
            let $_ := xmldb:move($src-collection, $target, $src-resource)
            return map { "moved": $source, "to": $target }
};

(:~
 : Copy resource or collection.
 : POST /api/db/copy
 :)
declare function db:copy($request as map(*)) {
    let $body := $request?body
    let $source := $body?source
    let $target := $body?target
    return
        if (empty($source) or empty($target))
        then map { "error": "Missing required fields: source, target" }
        else if (xmldb:collection-available($source))
        then
            let $_ := xmldb:copy-collection($source, $target)
            return map { "copied": $source, "to": $target }
        else
            let $src-collection := replace($source, "/[^/]+$", "")
            let $src-resource := replace($source, "^.*/", "")
            let $_ := xmldb:copy-resource($src-collection, $src-resource, $target, $src-resource)
            return map { "copied": $source, "to": $target }
};

(:~
 : Get properties of a resource or collection.
 : GET /api/db/properties?path=...
 :)
declare function db:properties($request as map(*)) {
    let $path := $request?parameters?path
    return
        if (empty($path))
        then roaster:response(400, map { "error": "Missing required parameter: path" })
        else if (xmldb:collection-available($path))
        then
            let $perms := db:get-permissions($path)
            return map {
                "path": $path,
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
            let $perms := db:get-permissions($path)
            return
                map {
                    "path": $path,
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
            roaster:response(404, map { "error": "Not found: " || $path })
};

(:~
 : Set permissions on a resource or collection.
 : POST /api/db/permissions
 :)
declare function db:set-permissions($request as map(*)) {
    let $body := $request?body
    let $path := $body?path
    return
        if (empty($path))
        then roaster:response(400, map { "error": "Missing required field: path" })
        else
            let $_ := (
                if ($body?owner) then sm:chown(xs:anyURI($path), $body?owner) else (),
                if ($body?group) then sm:chgrp(xs:anyURI($path), $body?group) else (),
                if ($body?mode) then sm:chmod(xs:anyURI($path), $body?mode) else ()
            )
            return map { "updated": $path }
};

(:~
 : Sync tree with timestamps.
 : GET /api/db/sync?root=/db&timestamp=...
 :
 : Returns a collection tree with lastModified timestamps.
 : When timestamp is provided, only returns resources modified after that time.
 :)
declare function db:sync($request as map(*)) {
    let $root := string(($request?parameters?root, "/db")[1])
    let $timestamp-param := $request?parameters?timestamp
    let $timestamp :=
        if ($timestamp-param)
        then xs:dateTime($timestamp-param)
        else ()
    return
        if (not(xmldb:collection-available($root)))
        then roaster:response(404, map { "error": "Collection not found: " || $root })
        else
            map {
                "root": $root,
                "timestamp": string(current-dateTime()),
                "children": db:sync-collection(xs:anyURI($root), $timestamp)
            }
};

(:~
 : Recursively build sync tree for a collection.
 :)
declare %private function db:sync-collection(
    $root as xs:anyURI, $timestamp as xs:dateTime?
) as array(*) {
    array {
        for $child in xmldb:get-child-collections($root)
        let $path := $root || "/" || $child
        order by $child
        return map {
            "path": $child,
            "lastModified": string(xmldb:created($path)),
            "children": db:sync-collection(xs:anyURI($path), $timestamp)
        },
        for $resource in xmldb:get-child-resources($root)
        let $last-modified :=
            try { xmldb:last-modified($root, $resource) }
            catch * { current-dateTime() }
        where empty($timestamp) or ($last-modified > $timestamp)
        order by $resource
        return map {
            "path": $resource,
            "lastModified": string($last-modified)
        }
    }
};

(:~
 : Module discovery for IDE import assistance.
 : GET /api/modules?path=...&prefix=...&uri=...
 :
 : Returns importable modules from package-local files, mapped modules,
 : and registered built-in modules.
 :)
declare function db:modules($request as map(*)) {
    let $path := $request?parameters?path
    let $prefix := $request?parameters?prefix
    let $imported-param := $request?parameters?uri
    let $imported :=
        if ($imported-param)
        then tokenize($imported-param, ",")
        else ()
    let $path :=
        if (starts-with($path, "xmldb:exist://"))
        then substring-after($path, "xmldb:exist://")
        else $path
    let $pkg-root := db:get-package-root($path)
    let $pkg-root := if ($pkg-root) then $pkg-root else replace($path, "/[^/]+$", "")
    return array {
        (: Package-local XQuery modules :)
        for $info in db:scan-local-modules($pkg-root, $prefix, $imported)
        order by $info?prefix, $info?namespace
        return $info,
        (: Mapped and registered built-in modules :)
        for $info in db:mapped-modules($prefix, $imported)
        order by $info?prefix, $info?namespace
        return $info
    }
};

(:~
 : Find the package root for a given path.
 :)
declare %private function db:get-package-root($path as xs:string) as xs:string? {
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
declare %private function db:scan-local-modules(
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
declare %private function db:mapped-modules(
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
