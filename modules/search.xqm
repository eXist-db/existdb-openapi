xquery version "3.1";

(:~
 : Sitewide search endpoint.
 : Queries site-* indexed fields across all installed apps.
 :
 : NOTE: This module requires apps to define Lucene field indexes
 : named "site-content", "site-title", "site-app", and "site-section"
 : in their collection.xconf files. Without these indexes, search
 : will return empty results.
 :)
module namespace search="http://exist-db.org/api/search";

import module namespace site="http://exist-db.org/api/site" at "site.xqm";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : Search across all installed apps using full-text query.
 : GET /api/search?q=FLWOR&app=docs&limit=20
 :
 : Falls back to a basic ft:query() if field indexes are not configured.
 :)
declare function search:query($request as map(*)) {
    let $q := $request?parameters?q
    let $app-filter := $request?parameters?app
    let $limit := ($request?parameters?limit, 20)[1] cast as xs:integer
    return
        if (empty($q) or $q = "")
        then map { "error": "Missing required parameter: q" }
        else
            let $scope :=
                if ($app-filter)
                then collection("/db/apps/" || $app-filter)
                else collection("/db/apps")
            (: Use ft:query with a Lucene query string — works with any text index :)
            let $hits := $scope//*[ft:query(., $q)]
            return map {
                "query": $q,
                "total": count($hits),
                "results": array {
                    for $hit in subsequence($hits, 1, $limit)
                    let $root := root($hit)
                    let $doc-uri := document-uri($root)
                    (: Extract app name from path: /db/apps/{app}/... :)
                    let $app := replace($doc-uri, "^/db/apps/([^/]+)/.*$", "$1")
                    return map {
                        "title": string(($hit/ancestor-or-self::*[title][1]/title, "(untitled)")[1]),
                        "snippet": substring(string-join($hit//text(), " "), 1, 200),
                        "app": $app,
                        "path": $doc-uri,
                        "url": site:resolve-link($app, replace($doc-uri, "^/db/apps/[^/]+", ""))
                    }
                }
            }
};
