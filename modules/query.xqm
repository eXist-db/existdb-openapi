(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Query execution endpoints.
 : Wraps cursor:eval(), cursor:fetch(), cursor:close() Java functions as REST endpoints.
 :)
module namespace query="http://exist-db.org/api/query";

import module namespace cursor="http://exist-db.org/xquery/cursor";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : Build a serialization parameters map from a flat key→value source map.
 :
 : Recognises the standard W3C serialization parameters, using sensible
 : defaults (adaptive method, indented, XML declaration omitted).
 :
 : @param $params map of parameter names to values (strings or booleans)
 : @return serialization parameters map suitable for serialize() or cursor:fetch()
 :)
declare %private function query:serialization-params($params as map(*)) as map(*) {
    (: serialize() requires xs:boolean for boolean parameters, not "yes"/"no" strings :)
    map:merge((
        map { "method":               ($params?method,   "adaptive")[1] },
        map { "indent":               ($params?indent,   "yes")[1] = "yes" },
        map { "omit-xml-declaration": ($params?("omit-xml-declaration"), "yes")[1] = "yes" },
        if (exists($params?encoding))
            then map { "encoding": $params?encoding } else (),
        if (exists($params?("item-separator")))
            then map { "item-separator": $params?("item-separator") } else (),
        if (exists($params?("html-version")))
            then map { "html-version": xs:decimal($params?("html-version")) } else (),
        if (exists($params?("suppress-indentation")))
            then map { "suppress-indentation": $params?("suppress-indentation") } else ()
    ))
};

(:~
 : Execute a query and return a cursor for paginated retrieval.
 : POST /api/query
 :
 : @param $request the incoming request map from Roaster
 : @return map with cursor ID, item count, elapsed time, and timing breakdown
 :)
declare function query:execute($request as map(*)) {
    let $body := $request?body
    let $expression := $body?query
    let $module-load-path := $body?module-load-path
    let $context-item-xml := $body?context-item
    let $context-path := $body?context-path
    return
        if (empty($expression) or $expression = "")
        then
            map { "error": "Missing required field: query" }
        else
            (: context-path (a DB path the editor has open) takes precedence
             : over context-item (inline serialized XML). Either resolves to
             : the node `expression` will see as `.` / the focus of
             : unprefixed path expressions like `//foo`. :)
            try {
                let $context-item :=
                    if (exists($context-path) and $context-path != "") then
                        if (doc-available($context-path))
                        then doc($context-path)
                        else error(xs:QName("query:context-path-not-found"),
                                   "context-path not found: " || $context-path)
                    else if (exists($context-item-xml) and $context-item-xml != "") then
                        parse-xml($context-item-xml)
                    else
                        ()
                let $mlp := if ($module-load-path) then $module-load-path else ()
                return
                    if (exists($context-item)) then
                        cursor:eval($expression, $mlp, $context-item)
                    else if (exists($mlp)) then
                        cursor:eval($expression, $mlp)
                    else
                        cursor:eval($expression)
            } catch query:context-path-not-found {
                map { "error": $err:description }
            } catch * {
                map { "error": "Invalid context-item: " || $err:description }
            }
};

(:~
 : Fetch a page of results from an open cursor.
 : GET /api/query/{id}/results?start=1&count=10&method=adaptive&indent=yes
 :
 : @param $request the incoming request map
 : @return array of result item maps
 :)
declare function query:fetch($request as map(*)) {
    let $cursor-id := $request?parameters?id
    let $start  := ($request?parameters?start, 1)[1]  cast as xs:integer
    let $count  := ($request?parameters?count, 10)[1] cast as xs:integer
    (: cursor:fetch() expects string values for boolean params — keep as-is :)
    let $ser := map {
        "method": ($request?parameters?method, "adaptive")[1],
        "indent": ($request?parameters?indent, "yes")[1]
    }
    return
        cursor:fetch($cursor-id, $start, $count, $ser)
};

(:~
 : Close a cursor and release resources.
 : DELETE /api/query/{id}
 :
 : @param $request the incoming request map
 : @return map with status
 :)
declare function query:close($request as map(*)) {
    let $cursor-id := $request?parameters?id
    let $closed := cursor:close($cursor-id)
    return
        map { "closed": $closed }
};

(:~
 : Cancel a running query.
 : POST /api/query/{id}/cancel
 :
 : @param $request the incoming request map
 : @return map with status
 :)
declare function query:cancel($request as map(*)) {
    (: TODO: implement query cancellation :)
    map { "error": "Not yet implemented" }
};

(:~
 : Evaluate a query and return serialized results as plain text.
 : POST /api/eval
 :
 : Single-request alternative to the cursor API, suitable for interactive
 : try-it widgets. Accepts the same serialization parameters as the cursor
 : results endpoint (method, indent, omit-xml-declaration, etc.) plus a
 : count limit.
 :
 : @param $request the incoming request map from Roaster
 : @return serialized result string as text/plain
 :)
declare
    %output:method("text")
    %output:media-type("text/plain")
function query:eval($request as map(*)) {
    let $body       := $request?body
    let $expression := $body?query
    let $count      := xs:integer(($body?count, 50)[1])
    let $ser        := query:serialization-params($body)
    return
        if (empty($expression) or $expression = "") then
            "Error: missing required field: query"
        else
            try {
                let $result := util:eval($expression)
                let $items  := subsequence($result, 1, $count)
                let $total  := count($result)
                let $serialized :=
                    string-join(
                        $items ! serialize(., $ser),
                        "&#10;"
                    )
                return
                    if ($total > $count) then
                        $serialized || "&#10;&#10;(" || $total || " items total, showing first " || $count || ")"
                    else
                        $serialized
            } catch * {
                "Error: " || $err:description
            }
};
