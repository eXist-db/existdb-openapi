xquery version "3.1";

(:~
 : Sitewide search endpoint.
 : Queries site-* indexed fields across all installed apps.
 :)
module namespace search="http://exist-db.org/api/search";

import module namespace kwic="http://exist-db.org/xquery/kwic";
import module namespace site="http://exist-db.org/api/site" at "site.xqm";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";
declare namespace ft="http://exist-db.org/xquery/lucene";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : Search across all installed apps.
 : GET /api/search?q=FLWOR&app=docs&limit=20
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
            let $hits := $scope//ft:field-contains("site-content", $q)
            return map {
                "query": $q,
                "total": count($hits),
                "results": array {
                    for $hit in subsequence($hits, 1, $limit)
                    let $title := ft:field($hit, "site-title")
                    let $app := ft:field($hit, "site-app")
                    let $section := ft:field($hit, "site-section")
                    return map {
                        "title": string(($title, "(untitled)")[1]),
                        "snippet": string-join(
                            kwic:summarize($hit, <config width="80"/>)//text(), " "
                        ),
                        "app": string(($app, "")[1]),
                        "section": string(($section, "")[1]),
                        "url": site:resolve-link(string(($app, "")[1]), document-uri(root($hit)))
                    }
                }
            }
};
