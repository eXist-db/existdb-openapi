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
import module namespace roaster="http://e-editiones.org/roaster";

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
 : Determine the user-relative error coordinates — the position in the client's
 : submitted query, the frame an editor needs to place a marker.
 :
 : eXist surfaces the position two different ways depending on the error:
 :   - Parse errors (XPST0003) embed it in the description as "[at line N,
 :     column M]" — and there $err:line-number/$err:column-number are instead the
 :     wrapper-module call site (useless), so the embedded value is authoritative.
 :   - Other errors (XPST0008, XPTY0004, XPST0017, …) leave the description
 :     position-free and put the user-relative position directly in
 :     $err:line-number/$err:column-number.
 : So: prefer the embedded "[at line …]" when present, else fall back to the
 : $err: variables. Returns an empty map when neither yields a position (e.g. a
 : parse-xml content error, which has no location in the query).
 :
 : Note we only ever see the user-relative embedded location here: Roaster
 : appends a second, wrapper-relative "[at line X column Y in module unknown]"
 : when it serializes an *uncaught* error, but catching here means we never do.
 :
 : @param $description the raw $err:description
 : @param $line the $err:line-number
 : @param $column the $err:column-number
 : @return map { "line": xs:integer, "column": xs:integer } or map {}
 :)
declare %private function query:error-coordinates(
    $description as xs:string?, $line as xs:integer?, $column as xs:integer?
) as map(*) {
    let $match := analyze-string(($description, "")[1],
        "\[at line\s+(\d+),?\s+column\s+(\d+)")//fn:match[1]
    return
        if (exists($match))
        then map {
            "line":   xs:integer($match/fn:group[@nr = "1"]),
            "column": xs:integer($match/fn:group[@nr = "2"])
        }
        else if (exists($line) and $line gt 0)
        then map { "line": $line, "column": $column }
        else map {}
};

(:~
 : Strip eXist's framing from an error description, leaving just the human
 : message: the trailing "[at line ...]" location, any leaked Java exception
 : class name, a repeated "err:CODE" token, and the leading W3C normative
 : boilerplate (identical for every instance of a given error code). Best-effort
 : — the unmodified text is always preserved in the envelope's "raw" field — but
 : it cleans the eXist shapes editor clients care about (XPST*, XPTY*, FO*).
 :
 : @param $description the raw $err:description
 : @return the cleaned, single-line message
 :)
declare %private function query:clean-message($description as xs:string?) as xs:string? {
    if (empty($description)) then $description
    else
        let $no-location := replace($description, "\s*\[at line\s[\s\S]*$", "")
        let $no-class    := replace($no-location, "\s*(org\.exist\.[\w.]+|java\.[\w.]+):\s*", " ")
        let $no-code     := replace($no-class, "err:[A-Z][A-Z0-9]+\s+", "")
        let $no-boiler   := replace($no-code, "^It is (a|an) [\s\S]*? error[\s\S]*?\.\s+", "")
        (: never strip down to nothing — fall back to the pre-boilerplate text :)
        let $message     := if (normalize-space($no-boiler) = "") then $no-code else $no-boiler
        return normalize-space($message)
};

(:~
 : Build the JSON error envelope for a failed query evaluation. Exposes
 : user-relative line/column at the top level, a clean human message, the
 : err: code, and the unmodified description under "raw" so no detail is lost.
 : Standard XPath/XQuery errors (the xqt-errors namespace) mean the submitted
 : query is at fault and map to HTTP 400; anything else is an internal failure
 : and maps to 500.
 :
 : @param $code the $err:code QName
 : @param $description the raw $err:description
 : @param $line the $err:line-number
 : @param $column the $err:column-number
 : @return a Roaster response with the appropriate status
 :)
declare %private function query:error-response(
    $code as xs:QName?, $description as xs:string?,
    $line as xs:integer?, $column as xs:integer?
) {
    let $coordinates := query:error-coordinates($description, $line, $column)
    let $is-query-error :=
        exists($code) and namespace-uri-from-QName($code) = "http://www.w3.org/2005/xqt-errors"
    return roaster:response(
        if ($is-query-error) then 400 else 500,
        "application/json",
        map {
            "code":    if ($is-query-error) then "err:" || local-name-from-QName($code)
                       else if (exists($code)) then string($code) else (),
            "message": query:clean-message($description),
            "line":    $coordinates?line,
            "column":  $coordinates?column,
            "raw":     $description
        }
    )
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
    (: Optional external-variable bindings: a map of name → value, each bound to a
     : `declare variable $name external;` in the expression. :)
    let $variables := $body?variables
    return
        if (empty($expression) or $expression = "")
        then
            roaster:response(400, "application/json",
                map { "error": "Missing required field: query" })
        else
            (: context-path (a DB path the editor has open) takes precedence
             : over context-item (inline serialized XML). Either resolves to
             : the node `expression` will see as `.` / the focus of
             : unprefixed path expressions like `//foo`. :)
            let $context-item := query:resolve-context-item($context-path, $context-item-xml)
            return
                if ($context-item instance of map(*) and exists($context-item?error))
                then
                    roaster:response($context-item?status, "application/json",
                        map { "error": $context-item?error })
                else
                    let $mlp := if ($module-load-path) then $module-load-path else ()
                    return
                        (: Catch the user's query errors here rather than letting them
                         : propagate to Roaster: by the time Roaster serializes an uncaught
                         : error the top-level line/column have been rewritten to the
                         : cursor:eval call site (useless for an editor marker). Caught here,
                         : the description still carries the user-relative position. :)
                        try {
                            if ($variables instance of map(*) and map:size($variables) gt 0) then
                                cursor:eval($expression, $mlp, $context-item, $variables)
                            else if (exists($context-item)) then
                                cursor:eval($expression, $mlp, $context-item)
                            else if (exists($mlp)) then
                                cursor:eval($expression, $mlp)
                            else
                                cursor:eval($expression)
                        }
                        catch * {
                            query:error-response($err:code, $err:description,
                                $err:line-number, $err:column-number)
                        }
};

(:~
 : Resolve the optional context item for query:execute. Returns a node()
 : on success, an error map { status, error } if context-path is missing
 : or context-item is malformed XML, or empty-sequence if neither is
 : supplied. The error map is wrapped here rather than propagating an
 : XPath error so cursor:eval's own errors (the user's XQuery has bugs)
 : pass through unmodified and Roaster gives them a proper HTTP status.
 :)
declare %private function query:resolve-context-item(
    $context-path as xs:string?,
    $context-item-xml as xs:string?
) {
    if (exists($context-path) and $context-path != "") then
        if (doc-available($context-path))
        then doc($context-path)
        else map { "status": 404, "error": "context-path not found: " || $context-path }
    else if (exists($context-item-xml) and $context-item-xml != "") then
        try {
            parse-xml($context-item-xml)
        } catch * {
            map { "status": 400, "error": "Invalid context-item: " || $err:description }
        }
    else
        ()
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
