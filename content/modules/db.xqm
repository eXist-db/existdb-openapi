xquery version "3.1";

(:~
 : Database management endpoints.
 : Collection and resource CRUD operations.
 :)
module namespace db="http://exist-db.org/api/db";

import module namespace dbutil="http://exist-db.org/api/dbutils" at "dbutils.xqm";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : List collection contents.
 : GET /api/db?path=/db/apps
 :)
declare function db:list($request as map(*)) {
    let $path := ($request?parameters?path, "/db")[1]
    return
        if (not(xmldb:collection-available($path)))
        then map { "error": "Collection not found: " || $path }
        else
            map {
                "path": $path,
                "collections": array {
                    for $child in xmldb:get-child-collections($path)
                    order by $child
                    return $child
                },
                "resources": array {
                    for $resource in xmldb:get-child-resources($path)
                    order by $resource
                    return map {
                        "name": $resource,
                        "mime-type": xmldb:get-mime-type(xs:anyURI($path || "/" || $resource)),
                        "size": xmldb:size($path, $resource),
                        "last-modified": string(xmldb:last-modified($path, $resource))
                    }
                }
            }
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
        then map { "error": "Resource not found: " || $path }
        else if (util:binary-doc-available($path))
        then
            let $data := util:binary-doc($path)
            return map {
                "path": $path,
                "binary": true,
                "content": util:binary-to-string($data),
                "mime-type": xmldb:get-mime-type(xs:anyURI($path))
            }
        else
            let $doc := doc($path)
            return map {
                "path": $path,
                "binary": false,
                "content": serialize($doc),
                "mime-type": xmldb:get-mime-type(xs:anyURI($path))
            }
};

(:~
 : Store resource.
 : PUT /api/db/resource
 :)
declare function db:store-resource($request as map(*)) {
    let $body := $request?body
    let $path := $body?path
    let $content := $body?content
    let $mime-type := ($body?mime-type, "application/xml")[1]
    return
        if (empty($path) or empty($content))
        then map { "error": "Missing required fields: path, content" }
        else
            let $collection := replace($path, "/[^/]+$", "")
            let $resource := replace($path, "^.*/", "")
            let $stored := xmldb:store($collection, $resource, $content, $mime-type)
            return
                map { "stored": $stored }
};

(:~
 : Remove resource.
 : DELETE /api/db/resource?path=...
 :)
declare function db:remove-resource($request as map(*)) {
    let $path := $request?parameters?path
    return
        if (empty($path))
        then map { "error": "Missing required parameter: path" }
        else
            let $collection := replace($path, "/[^/]+$", "")
            let $resource := replace($path, "^.*/", "")
            return (
                xmldb:remove($collection, $resource),
                map { "removed": $path }
            )
};

(:~
 : Create collection.
 : POST /api/db/collection
 :)
declare function db:create-collection($request as map(*)) {
    let $path := $request?body?path
    return
        if (empty($path))
        then map { "error": "Missing required field: path" }
        else
            let $parent := replace($path, "/[^/]+$", "")
            let $name := replace($path, "^.*/", "")
            let $created := xmldb:create-collection($parent, $name)
            return
                map { "created": $created }
};

(:~
 : Remove collection recursively.
 : DELETE /api/db/collection?path=...
 :)
declare function db:remove-collection($request as map(*)) {
    let $path := $request?parameters?path
    return
        if (empty($path))
        then map { "error": "Missing required parameter: path" }
        else (
            xmldb:remove($path),
            map { "removed": $path }
        )
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
        then (
            xmldb:move($source, $target),
            map { "moved": $source, "to": $target }
        )
        else
            let $src-collection := replace($source, "/[^/]+$", "")
            let $src-resource := replace($source, "^.*/", "")
            return (
                xmldb:move($src-collection, $target, $src-resource),
                map { "moved": $source, "to": $target }
            )
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
        then (
            xmldb:copy-collection($source, $target),
            map { "copied": $source, "to": $target }
        )
        else
            let $src-collection := replace($source, "/[^/]+$", "")
            let $src-resource := replace($source, "^.*/", "")
            return (
                xmldb:copy-resource($src-collection, $src-resource, $target, $src-resource),
                map { "copied": $source, "to": $target }
            )
};

(:~
 : Get properties of a resource or collection.
 : GET /api/db/properties?path=...
 :)
declare function db:properties($request as map(*)) {
    let $path := $request?parameters?path
    return
        if (empty($path))
        then map { "error": "Missing required parameter: path" }
        else if (xmldb:collection-available($path))
        then
            map {
                "path": $path,
                "type": "collection",
                "owner": xmldb:get-owner($path),
                "group": xmldb:get-group($path),
                "permissions": xmldb:permissions-to-string(xmldb:get-permissions($path)),
                "created": string(xmldb:created($path))
            }
        else
            let $collection := replace($path, "/[^/]+$", "")
            let $resource := replace($path, "^.*/", "")
            return
                map {
                    "path": $path,
                    "type": "resource",
                    "owner": xmldb:get-owner($collection, $resource),
                    "group": xmldb:get-group($collection, $resource),
                    "permissions": xmldb:permissions-to-string(xmldb:get-permissions($collection, $resource)),
                    "mime-type": xmldb:get-mime-type(xs:anyURI($path)),
                    "size": xmldb:size($collection, $resource),
                    "created": string(xmldb:created($collection, $resource)),
                    "last-modified": string(xmldb:last-modified($collection, $resource))
                }
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
        then map { "error": "Missing required field: path" }
        else (
            if ($body?owner) then sm:chown(xs:anyURI($path), $body?owner) else (),
            if ($body?group) then sm:chgrp(xs:anyURI($path), $body?group) else (),
            if ($body?mode) then sm:chmod(xs:anyURI($path), $body?mode) else (),
            map { "updated": $path }
        )
};
