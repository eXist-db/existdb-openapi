(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Recursive collection and resource utility functions.
 : Ported from eXide's dbutils.xqm.
 :)
module namespace dbutil="http://exist-db.org/api/dbutils";

(:~
 : Recursively scan a collection tree, applying a function to each collection.
 :
 : @param $root the root collection path
 : @param $func function to apply to each collection path
 : @return concatenated results of applying $func
 :)
declare function dbutil:scan-collections($root as xs:anyURI, $func as function(xs:anyURI) as item()*) as item()* {
    $func($root),
    for $child in xmldb:get-child-collections($root)
    return
        dbutil:scan-collections(xs:anyURI($root || "/" || $child), $func)
};

(:~
 : Recursively scan all resources in a collection tree.
 :
 : @param $root the root collection path
 : @param $func function to apply to each (collection, resource) pair
 : @return concatenated results
 :)
declare function dbutil:scan-resources($root as xs:anyURI, $func as function(xs:anyURI, xs:string) as item()*) as item()* {
    for $resource in xmldb:get-child-resources($root)
    return
        $func($root, $resource),
    for $child in xmldb:get-child-collections($root)
    return
        dbutil:scan-resources(xs:anyURI($root || "/" || $child), $func)
};

(:~
 : Find all resources matching a pattern in a collection tree.
 :
 : @param $root the root collection
 : @param $pattern resource name pattern (glob)
 : @return sequence of matching resource paths
 :)
declare function dbutil:find-by-name($root as xs:anyURI, $pattern as xs:string) as xs:string* {
    dbutil:scan-resources($root, function($collection, $resource) {
        if (matches($resource, $pattern))
        then $collection || "/" || $resource
        else ()
    })
};

(:~
 : Get the total size of all resources in a collection tree.
 :
 : @param $root the root collection
 : @return total size in bytes
 :)
declare function dbutil:collection-size($root as xs:anyURI) as xs:long {
    sum(
        dbutil:scan-resources($root, function($collection, $resource) {
            xmldb:size($collection, $resource)
        })
    )
};

(:~
 : Count all resources in a collection tree.
 :
 : @param $root the root collection
 : @return total count
 :)
declare function dbutil:resource-count($root as xs:anyURI) as xs:integer {
    count(
        dbutil:scan-resources($root, function($collection, $resource) {
            true()
        })
    )
};
