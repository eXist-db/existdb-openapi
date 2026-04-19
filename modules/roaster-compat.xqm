xquery version "3.1";

(:~
 : Built-in compatibility module for Roaster's response API.
 :
 : Provides roaster:response() so that XQuery handler modules can set HTTP
 : status codes and content types without depending on the Roaster XAR package.
 : The OpenApiServlet recognizes response maps with "code", "type", "body",
 : and "headers" keys and translates them to HTTP responses.
 :
 : Apps that need full Roaster functionality (route(), auth middleware, etc.)
 : should install the Roaster XAR package. Apps that only use response() can
 : use this built-in module instead.
 :)
module namespace roaster = "http://e-editiones.org/roaster";

(:~
 : Create a response map with HTTP status code and body.
 : The OpenApiServlet (or any compatible router) reads the "code" and "body"
 : keys to set the HTTP response status and content.
 :
 : @param $code HTTP status code (e.g. 200, 400, 404)
 : @param $body response body (map, sequence, string, etc.)
 : @return a map with "code" and "body" keys
 :)
declare function roaster:response($code as xs:integer, $body as item()*) {
    map {
        "code": $code,
        "body": $body
    }
};

(:~
 : Create a response map with HTTP status code, media type, and body.
 :
 : @param $code HTTP status code
 : @param $media-type Content-Type for the response (e.g. "application/json")
 : @param $body response body
 : @return a map with "code", "type", and "body" keys
 :)
declare function roaster:response($code as xs:integer, $media-type as xs:string?, $body as item()*) {
    map {
        "code": $code,
        "type": $media-type,
        "body": $body
    }
};

(:~
 : Create a response map with HTTP status code, media type, body, and custom headers.
 :
 : @param $code HTTP status code
 : @param $media-type Content-Type for the response
 : @param $body response body
 : @param $headers map of custom HTTP headers
 : @return a map with "code", "type", "body", and "headers" keys
 :)
declare function roaster:response($code as xs:integer, $media-type as xs:string?, $body as item()*, $headers as map(*)?) {
    map {
        "code": $code,
        "type": $media-type,
        "body": $body,
        "headers": $headers
    }
};
