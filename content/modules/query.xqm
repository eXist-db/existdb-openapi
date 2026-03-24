xquery version "3.1";

(:~
 : Query execution endpoints.
 : Wraps lsp:eval(), lsp:fetch(), lsp:close() Java functions as REST endpoints.
 :)
module namespace query="http://exist-db.org/api/query";

import module namespace lsp="http://exist-db.org/xquery/lsp";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

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
    return
        if (empty($expression) or $expression = "")
        then
            map { "error": "Missing required field: query" }
        else
            let $result :=
                if ($module-load-path)
                then lsp:eval($expression, $module-load-path)
                else lsp:eval($expression)
            return $result
};

(:~
 : Fetch a page of results from an open cursor.
 : GET /api/query/{id}/results?start=1&count=10&method=adaptive&indent=yes
 :
 : @param $request the incoming request map
 : @return array of result item maps
 :)
declare function query:fetch($request as map(*)) {
    let $cursor := $request?parameters?id
    let $start := ($request?parameters?start, 1)[1] cast as xs:integer
    let $count := ($request?parameters?count, 10)[1] cast as xs:integer
    let $method := ($request?parameters?method, "adaptive")[1]
    let $indent := ($request?parameters?indent, "yes")[1]
    let $serialization := map {
        "method": $method,
        "indent": $indent
    }
    return
        lsp:fetch($cursor, $start, $count, $serialization)
};

(:~
 : Close a cursor and release resources.
 : DELETE /api/query/{id}
 :
 : @param $request the incoming request map
 : @return map with status
 :)
declare function query:close($request as map(*)) {
    let $cursor := $request?parameters?id
    let $closed := lsp:close($cursor)
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
