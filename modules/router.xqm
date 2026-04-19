xquery version "3.1";

(:~
 : Lightweight built-in router for the eXist-db Platform API.
 :
 : Replaces Roaster's roaster:route() for exist-api specifically.
 : Reads the OpenAPI api.json spec, matches the incoming request to a route,
 : extracts path/query parameters, builds the $request map, and invokes the
 : handler function via the lookup function.
 :
 : This is intentionally simpler than full Roaster — no middleware pipeline,
 : no auth hooks, no multipart body parsing. For apps that need those,
 : install the Roaster XAR package.
 :)
module namespace router = "http://exist-db.org/api/router";

declare namespace output = "http://www.w3.org/2010/xslt-xquery-serialization";

(:~
 : Route an incoming HTTP request based on an OpenAPI spec.
 :
 : @param $api-json-path path to the api.json file (relative to app collection)
 : @param $lookup function that resolves operationId → handler function
 : @return the handler's return value (typically a map or sequence)
 :)
declare function router:route($api-json-paths as item()*, $lookup as function(*)) {
    router:route-specs(
        if ($api-json-paths instance of array(*)) then $api-json-paths?*
        else if ($api-json-paths instance of xs:string*) then $api-json-paths
        else for $p in $api-json-paths return string($p),
        $lookup
    )
};

declare %private function router:route-specs($api-json-paths as xs:string*, $lookup as function(*)) {
    let $method := lower-case(request:get-method())

    (: Handle CORS preflight :)
    return if ($method eq "options") then
        <rest:response xmlns:rest="http://exquery.org/ns/restxq">
            <http:response xmlns:http="http://expath.org/ns/http-client" status="204">
                <http:header name="Access-Control-Allow-Origin" value="*"/>
                <http:header name="Access-Control-Allow-Methods" value="GET, POST, PUT, DELETE, PATCH, OPTIONS"/>
                <http:header name="Access-Control-Allow-Headers" value="Content-Type, Authorization"/>
            </http:response>
        </rest:response>
    else

    (: Resolve the api.json path(s) relative to the app's db collection :)
    let $controller := request:get-attribute("$exist:controller")
    let $root := request:get-attribute("$exist:root")
    let $app-collection :=
        if (starts-with($controller, "/db/")) then
            $controller
        else
            replace($root, "^xmldb:exist://", "") || $controller
    (: Merge all API specs into one combined paths map :)
    let $spec := map {
        "paths": map:merge(
            for $path in $api-json-paths
            let $spec-path := $app-collection || "/" || $path
            let $s := json-doc($spec-path)
            return if (exists($s?paths)) then $s?paths else map {}
        )
    }
    let $request-path := request:get-attribute("$exist:path")

    (: Match the request to a route in the spec :)
    let $match := router:match-route($spec, $method, $request-path)

    return if (empty($match)) then
        (response:set-status-code(404),
         map { "error": "No route found for " || upper-case($method) || " " || $request-path })
    else
        let $operation-id := $match?operationId
        let $handler := $lookup($operation-id)
        return if (empty($handler)) then
            (response:set-status-code(501),
             map { "error": "Handler not found for operationId: " || $operation-id })
        else
            let $request := router:build-request($match, $method)
            let $result :=
                try {
                    $handler($request)
                } catch * {
                    (: Map roaster-style error QNames to HTTP status codes :)
                    let $status :=
                        switch (string($err:code))
                        case "errors:UNAUTHORIZED_401" return 401
                        case "errors:FORBIDDEN_403" return 403
                        case "errors:NOT_FOUND_404" return 404
                        case "errors:OPERATION" return 400
                        default return 500
                    return map {
                        "code": $status,
                        "body": map {
                            "error": $err:description,
                            "code": string($err:code),
                            "line": $err:line-number,
                            "column": $err:column-number,
                            "module": $err:module
                        }
                    }
                }
            return router:send-response($result)
};

(:~
 : Process a handler's return value. If it's a response map (from roaster:response
 : or similar), extract the status code and set it on the HTTP response.
 : Returns the body for serialization.
 :)
declare %private function router:send-response($result as item()*) as item()* {
    if ($result instance of map(*) and map:contains($result, "code")) then
        let $code := $result?code
        let $body := ($result?body, $result)[1]
        let $media-type := ($result?type, "application/json")[1]
        return (
            response:set-status-code($code),
            response:set-header("Content-Type", $media-type),
            if ($body instance of map(*) or $body instance of array(*)) then
                serialize($body, map { "method": "json", "media-type": "application/json" })
            else
                $body
        )
    else if ($result instance of map(*) or $result instance of array(*)) then
        (: Handler returned a data structure — serialize as JSON :)
        (
            response:set-header("Content-Type", "application/json"),
            serialize($result, map { "method": "json", "media-type": "application/json" })
        )
    else
        $result
};

(:~
 : Match a request path + method against the OpenAPI spec paths.
 : Returns a map with operationId, path parameters, and matched pattern,
 : or empty sequence if no match.
 :)
declare %private function router:match-route($spec as map(*), $method as xs:string, $path as xs:string) as map(*)? {
    let $paths := $spec?paths
    return if (empty($paths)) then () else

    (: Try exact match first, then pattern match :)
    let $exact := $paths($path)
    return if (exists($exact) and exists($exact($method))) then
        map {
            "operationId": $exact($method)?operationId,
            "pathParams": map {},
            "pattern": $path
        }
    else
        (: Try pattern matching with path parameters like {id} :)
        let $patterns := map:keys($paths)
        let $match :=
            for $pattern in $patterns
            where exists($paths($pattern)($method))
            let $result := router:match-pattern($pattern, $path)
            where exists($result)
            return map {
                "operationId": $paths($pattern)($method)?operationId,
                "pathParams": $result,
                "pattern": $pattern
            }
        return $match[1]
};

(:~
 : Match a path against an OpenAPI pattern with {param} placeholders.
 : Returns a map of parameter name → value if matched, empty if not.
 :)
declare %private function router:match-pattern($pattern as xs:string, $path as xs:string) as map(*)? {
    let $pattern-parts := tokenize($pattern, "/")
    let $path-parts := tokenize($path, "/")
    return if (count($pattern-parts) ne count($path-parts)) then ()
    else
        let $matched :=
            every $i in 1 to count($pattern-parts)
            satisfies
                let $pp := $pattern-parts[$i]
                let $vp := $path-parts[$i]
                return starts-with($pp, "{") or $pp eq $vp
        return if (not($matched)) then ()
        else
            map:merge(
                for $i in 1 to count($pattern-parts)
                let $pp := $pattern-parts[$i]
                let $vp := $path-parts[$i]
                where starts-with($pp, "{") and ends-with($pp, "}")
                return map { substring($pp, 2, string-length($pp) - 2): $vp }
            )
};

(:~
 : Build the $request map passed to handler functions.
 : Compatible with Roaster's request map format.
 :)
declare %private function router:build-request($match as map(*), $method as xs:string) as map(*) {
    let $path-params := $match?pathParams
    let $query-params :=
        map:merge(
            for $name in request:get-parameter-names()
            return map { $name: request:get-parameter($name, ()) }
        )
    let $all-params := map:merge(($query-params, $path-params))

    (: Parse JSON body for POST/PUT/PATCH :)
    let $body :=
        if ($method = ("post", "put", "patch")) then
            let $content-type := (request:get-header("Content-Type"), "")[1]
            let $data := request:get-data()
            return
                if (contains($content-type, "json")) then
                    if ($data instance of map(*)) then
                        $data  (: already parsed by framework :)
                    else if ($data instance of xs:string) then
                        try { parse-json($data) } catch * { $data }
                    else if ($data instance of document-node()) then
                        try { parse-json(serialize($data)) } catch * { $data }
                    else if (exists($data)) then
                        (: eXist returns JSON POST body as xs:base64Binary :)
                        try { parse-json(util:binary-to-string($data)) } catch * { $data }
                    else
                        map {}
                else
                    $data
        else ()

    return map {
        "method": $method,
        "path": request:get-uri(),
        "parameters": $all-params,
        "body": $body
    }
};
