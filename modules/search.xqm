(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Sitewide search endpoint.
 : Queries the full-text indexes of all installed apps and returns an
 : ES/Lucene-inspired response shape: relevance score, pagination, and
 : KWIC highlighting (matched terms wrapped in <mark>, each fragment centered
 : on a match rather than the document's leading characters).
 :
 : Highlighting is field-agnostic: it expands the matched nodes (util:expand)
 : and summarizes them with the eXist kwic module, so it works with whatever
 : text index an app defines.
 :)
module namespace search="http://exist-db.org/api/search";

import module namespace site="http://exist-db.org/api/site" at "site.xqm";
import module namespace kwic="http://exist-db.org/xquery/kwic";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~ Characters of context kwic keeps on each side of a match. :)
declare variable $search:kwic-width := 40;

(:~ Maximum KWIC fragments returned per hit. :)
declare variable $search:max-fragments := 3;

(:~
 : Build KWIC highlight fragments for a single hit. Each fragment is a
 : well-formed XML string: a single <span> root containing the fragment text
 : with matched term(s) wrapped in <mark>, centered on a match. Being
 : single-rooted, a client can parse it with plain fn:parse-xml (no
 : parse-xml-fragment needed); it is also valid HTML for direct innerHTML use.
 : Returns the empty sequence when the hit carries no expandable matches (e.g.
 : the match is in an attribute), letting the caller fall back to a plain
 : snippet.
 :)
declare %private function search:highlights($hit as node()) as xs:string* {
    let $summaries :=
        try {
            kwic:summarize(util:expand($hit), <config xmlns="" width="{$search:kwic-width}"/>)
        }
        catch * { () }
    for $p in subsequence($summaries, 1, $search:max-fragments)
    return
        serialize(
            <span>{
                for $span in $p/*
                return
                    if ($span/@class = "hi")
                    then <mark>{ $span/string() }</mark>
                    else text { $span/string() }
            }</span>,
            map { "method": "xml" }
        )
};

(:~
 : Search across all installed apps using a full-text query.
 : GET /api/search?q=FLWOR&app=docs&limit=20&offset=0
 :
 : Response shape:
 :   { query, total, offset, limit,
 :     results: [ { uri, path, title, app, url, score, snippet, highlights:[…] } ] }
 :
 : - results are ordered by descending relevance (ft:score)
 : - snippet is the first KWIC fragment (matched terms in <mark>); highlights is
 :   the full array of fragments. path/uri is the canonical identifier a client
 :   opens over exist:.
 :)
declare function search:query($request as map(*)) {
    let $q := $request?parameters?q
    let $app-filter := $request?parameters?app
    let $limit := ($request?parameters?limit, 20)[1] cast as xs:integer
    let $offset := ($request?parameters?offset, 0)[1] cast as xs:integer
    return
        if (empty($q) or $q = "")
        then map { "error": "Missing required parameter: q" }
        else
            let $scope :=
                if ($app-filter)
                then collection("/db/apps/" || $app-filter)
                else collection("/db/apps")
            (: ft:query with a Lucene query string — works with any text index.
               Score is captured in-context during ranking. :)
            let $ranked :=
                for $hit in $scope//*[ft:query(., $q)]
                let $score := ft:score($hit)
                order by $score descending
                return map { "hit": $hit, "score": $score, "uri": document-uri(root($hit)) }
            (: One result per document: ft:query matches nested elements, so a
               document yields many hits. Keep the highest-scoring hit per uri —
               the list is already score-descending, so the first occurrence of
               each uri is the best. :)
            let $unique :=
                fold-left($ranked, map { "seen": map {}, "out": () },
                    function($acc, $m) {
                        if (map:contains($acc?seen, $m?uri))
                        then $acc
                        else map {
                            "seen": map:put($acc?seen, $m?uri, true()),
                            "out": ($acc?out, $m)
                        }
                    }
                )?out
            let $total := count($unique)
            let $page := subsequence($unique, $offset + 1, $limit)
            return map {
                "query": $q,
                "total": $total,
                "offset": $offset,
                "limit": $limit,
                "results": array {
                    for $m in $page
                    let $hit := $m?hit
                    let $doc-uri := $m?uri
                    (: Extract app name from path: /db/apps/{app}/... :)
                    let $app := replace($doc-uri, "^/db/apps/([^/]+)/.*$", "$1")
                    let $fragments := search:highlights($hit)
                    (: snippet is always a well-formed <span> string (with or
                       without <mark>), so clients can fn:parse-xml it uniformly. :)
                    let $snippet :=
                        if (exists($fragments))
                        then $fragments[1]
                        else serialize(
                            <span>{ substring(string-join($hit//text(), " "), 1, 200) }</span>,
                            map { "method": "xml" }
                        )
                    return map {
                        "uri": $doc-uri,
                        "path": $doc-uri,
                        "title": string(($hit/ancestor-or-self::*[title][1]/title, "(untitled)")[1]),
                        "app": $app,
                        "url": site:resolve-link($app, replace($doc-uri, "^/db/apps/[^/]+", "")),
                        "score": $m?score,
                        "snippet": $snippet,
                        "highlights": array { $fragments }
                    }
                }
            }
};
