xquery version "3.1";

(:~
 : REST API entry point for the eXist-db Platform API.
 :
 : Routes incoming requests to module handlers based on the OpenAPI spec.
 : Uses the built-in router module instead of Roaster.
 :)

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

import module namespace router="http://exist-db.org/api/router" at "router.xqm";

(: Import API modules — each handles a group of endpoints :)
import module namespace system-api="http://exist-db.org/api/system" at "system.xqm";
import module namespace query="http://exist-db.org/api/query" at "query.xqm";
import module namespace lspapi="http://exist-db.org/api/lsp" at "lsp.xqm";
import module namespace db="http://exist-db.org/api/db" at "db.xqm";
import module namespace users="http://exist-db.org/api/users" at "users.xqm";
import module namespace packages="http://exist-db.org/api/packages" at "packages.xqm";
import module namespace search="http://exist-db.org/api/search" at "search.xqm";
import module namespace site="http://exist-db.org/api/site" at "site.xqm";

(:~
 : Lookup function: resolves operationId strings to XQuery functions.
 : Called by the router with each operationId from api.json.
 :)
declare function local:lookup($operationId as xs:string) as function(*)? {
    function-lookup(xs:QName($operationId), 1)
};

(:~
 : Main entry: route the request according to api.json spec.
 :)
router:route("modules/api.json", local:lookup#1)
