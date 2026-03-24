xquery version "3.1";

(:~
 : Roaster-based REST API entry point for the eXist-db Platform API.
 :
 : Routes incoming requests to module handlers based on the OpenAPI spec.
 :)

import module namespace roaster="http://e-editiones.org/roaster";
import module namespace rutil="http://e-editiones.org/roaster/util";

(: Import API modules — each handles a group of endpoints :)
import module namespace query="http://exist-db.org/api/query" at "modules/query.xqm";
import module namespace lsp="http://exist-db.org/api/lsp" at "modules/lsp.xqm";
import module namespace db="http://exist-db.org/api/db" at "modules/db.xqm";
import module namespace users="http://exist-db.org/api/users" at "modules/users.xqm";
import module namespace packages="http://exist-db.org/api/packages" at "modules/packages.xqm";
import module namespace search="http://exist-db.org/api/search" at "modules/search.xqm";
import module namespace site="http://exist-db.org/api/site" at "modules/site.xqm";

(:~
 : Main entry: route the request according to api.json spec.
 :)
roaster:router(
    "api.json",
    map {
        "auth": function ($request as map(*)) {
            (: Rely on eXist-db's built-in authentication via HTTP Basic/session :)
            $request
        }
    }
)
