(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : URL rewriting controller for the exist-api package.
 : Routes /api/* requests to the Roaster-based API entry point.
 :)

import module namespace login="http://exist-db.org/xquery/login"
    at "resource:org/exist/xquery/modules/persistentlogin/login.xql";

declare variable $exist:path external;
declare variable $exist:resource external;
declare variable $exist:controller external;
declare variable $exist:prefix external;
declare variable $exist:root external;

(: Process persistent login on every request :)
let $_ := login:set-user("org.exist.login", xs:dayTimeDuration("P7D"), false())

return
if ($exist:path eq "") then
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <redirect url="{request:get-uri()}/"/>
    </dispatch>

else if (matches($exist:path, "^/+modules/.*\.json$")) then
    (: serve OpenAPI spec files directly :)
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist"/>

else if (starts-with($exist:path, "/api")) then
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <forward url="{$exist:controller}/modules/api.xq">
            <set-header name="Access-Control-Allow-Origin" value="*"/>
            <set-header name="Access-Control-Allow-Methods" value="GET, POST, DELETE, PUT, PATCH, OPTIONS"/>
            <set-header name="Access-Control-Allow-Headers" value="Content-Type, Authorization"/>
            <set-header name="Cache-Control" value="no-cache"/>
        </forward>
    </dispatch>

else
    <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
        <cache-control cache="yes"/>
    </dispatch>
