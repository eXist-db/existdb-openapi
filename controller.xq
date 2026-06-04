(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : URL rewriting controller for the existdb-openapi package.
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

else if (matches($exist:path, "^/+api/db/resource/.+")) then
    (: Path-in-URL variant: raw bytes streaming via eXist's REST servlet.
     :
     : Use this for binary uploads/downloads (PDFs, images, fonts, zips)
     : and for any text upload where the JSON envelope's buffering would
     : be wasteful and the metadata it bundles isn't needed. The bare
     : /api/db/resource endpoint (path-in-JSON-body) stays the canonical
     : metadata-bundled path for editors that want signature + mime +
     : content in a single roundtrip.
     :
     : Forwarding via controller.xq is an internal servlet dispatch —
     : the original request's headers, auth context, and body all flow
     : through unchanged. Crucially, /exist/rest's RESTServer streams
     : the body straight to broker.storeDocument(InputSource) without
     : materializing it in JVM memory, so this path is suitable for
     : large binaries that would OOM Roaster's parse-the-body pipeline. :)
    let $db-path := replace($exist:path, "^/+api/db/resource", "")
    return
        <dispatch xmlns="http://exist.sourceforge.net/NS/exist">
            <forward url="/rest{$db-path}" absolute="yes">
                <set-header name="Access-Control-Allow-Origin" value="*"/>
                <set-header name="Access-Control-Allow-Methods" value="GET, PUT, DELETE, HEAD, OPTIONS"/>
                <set-header name="Access-Control-Allow-Headers" value="Content-Type, Authorization"/>
            </forward>
        </dispatch>

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
