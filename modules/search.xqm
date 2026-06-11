(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Sitewide search endpoint.
 : Queries the shared `site-content` Lucene field that content apps contribute to,
 : and returns an ES/Lucene-inspired response: relevance score, pagination, KWIC
 : highlighting (matched terms in <mark>), and facet counts (site-app, site-section)
 : for building a filter UI. Per-app vs site-wide is the same query with/without a
 : facet filter.
 :
 : Producers index a `site-content` field (+ optional `site-title`, `site-url`,
 : and `site-app`/`site-section` facets) on the element that represents one search
 : result. The field query is scoped to that field via the Lucene query string
 : (`site-content:(…)`); scoring requires a named-element or single-step axis, so
 : results are matched at the document-root level (collection(…)/*), not //*.
 :)
module namespace search="http://exist-db.org/api/search";

import module namespace site="http://exist-db.org/api/site" at "site.xqm";
(: FLS policy only (no ft:fields) — so /api/search compiles on a stock eXist :)
import module namespace fpol="http://exist-db.org/api/search/field-policy" at "field-policy.xqm";
import module namespace roaster="http://e-editiones.org/roaster";
import module namespace kwic="http://exist-db.org/xquery/kwic";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~ Characters of context kwic keeps on each side of a match. :)
declare variable $search:kwic-width := 40;

(:~ Maximum KWIC fragments returned per hit. :)
declare variable $search:max-fragments := 3;

(:~ Boost applied to title-field matches over body matches. :)
declare variable $search:title-boost := 3;

(:~
 : Escape Lucene QueryParser metacharacters so a user's query terms are treated
 : as literal text (a colon in `array:count` stays a literal, not a field
 : selector; `*`/`?` don't inject wildcards). Whitespace is preserved so
 : multi-term queries still split (combined per the default operator).
 :)
declare %private function search:escape($q as xs:string) as xs:string {
    replace($q, '([+\-&amp;|!(){}\[\]\^"~*?:\\/])', '\\$1')
};

(:~
 : Escape a Lucene FIELD NAME for use as a field selector in a query string. A
 : field name may itself contain a colon (e.g. the xqdoc:function discovery
 : fields); escape the colon and backslash so the parser reads the whole name as
 : the field, with the separating colon added by the caller.
 :)
declare %private function search:field-selector($field as xs:string) as xs:string {
    replace($field, '([:\\])', '\\$1')
};

(:~
 : Build KWIC highlight fragments for a single hit. Each fragment is a
 : well-formed XML string: a single <span> root with matched term(s) wrapped in
 : <mark>, centered on a match. Single-rooted, so a client can fn:parse-xml it
 : (no parse-xml-fragment) and it is valid HTML for innerHTML. Empty when the hit
 : carries no expandable matches, letting the caller fall back to a plain snippet.
 :)
declare %private function search:highlights($hit as node()) as xs:string* {
    (: Highlight the site-content FIELD (the matched, analyzed value) — not the
       node's element text via util:expand, which wouldn't carry the field
       match. ft:highlight-field-matches returns an <exist:field> with
       <exist:match> elements; kwic:summarize windows it. :)
    let $expanded :=
        try { ft:highlight-field-matches($hit, "site-content") } catch * { () }
    let $summaries :=
        if (exists($expanded))
        then try { kwic:summarize($expanded, <config xmlns="" width="{$search:kwic-width}"/>) } catch * { () }
        else ()
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

(:~ Convert an ft:facets() result map to a plain { value: count } map. :)
declare %private function search:facet-counts($hits as node()*, $dimension as xs:string) as map(*) {
    try { ft:facets($hits, $dimension, ()) } catch * { map {} }
};

(:~
 : Sitewide search over the shared `site-content` field.
 : GET /api/search?q=array:count&app=docs&section=functions&limit=20&offset=0
 :
 : Response:
 :   { query, total, offset, limit,
 :     facets: { site-app: {…counts}, site-section: {…counts} },
 :     results: [ { uri, path, title, app, url, score, snippet, highlights:[…] } ] }
 :
 : - results are ordered by descending relevance (ft:score), one per document
 : - snippet/highlights wrap matched terms in <mark> (well-formed <span> strings)
 : - app/section narrow the query via Lucene facet drill-down
 :)
declare function search:query($request as map(*)) {
    let $q := $request?parameters?q
    let $app-filter := $request?parameters?app
    let $section-filter := $request?parameters?section
    (: field: restrict the query to one named field (a /api/search/fields field
       value). scope: collection path(s) to search under, recursive (defaults to
       the sitewide /db/apps). Both optional; omitting them is today's behavior. :)
    let $field := $request?parameters?field[. ne ""]
    let $scope :=
        if (exists($request?parameters?scope[. ne ""]))
        then $request?parameters?scope[. ne ""]
        else "/db/apps"
    let $user := $request?user
    let $groups := ($user?groups, "guest")
    let $is-dba := ($user?dba, false())[1]
    let $limit := ($request?parameters?limit, 20)[1] cast as xs:integer
    let $offset := ($request?parameters?offset, 0)[1] cast as xs:integer
    return
        if (empty($q) or $q = "")
        then map { "error": "Missing required parameter: q" }
        else if (exists($field) and not(fpol:visible($field, $groups, $is-dba)))
        (: Field-level security: the same policy /api/search/fields applies — a
           field the caller may not see must not be queryable from this connection. :)
        then roaster:response(403, "application/json", map { "error": "Field not available: " || $field })
        else
            let $escaped := search:escape($q)
            (: Query string. With ?field, restrict to that one field; otherwise the
               default shared-field query (body + boosted title). :)
            let $query-string :=
                if (exists($field))
                then search:field-selector($field) || ":(" || $escaped || ")"
                else "site-content:(" || $escaped || ") OR site-title:(" || $escaped || ")^" || $search:title-boost
            (: Facet drill-down filters (app/section) — narrow without leaving
               the shared field; ES "filter context". :)
            let $facet-filter :=
                map:merge((
                    if (exists($app-filter) and $app-filter ne "") then map { "site-app": $app-filter } else (),
                    if (exists($section-filter) and $section-filter ne "") then map { "site-section": $section-filter } else ()
                ))
            let $options :=
                map:merge((
                    map {
                        "default-operator": "and",
                        "filter-rewrite": "yes",
                        (: load the producer's display fields so ft:field can return them :)
                        "fields": ("site-title", "site-url")
                    },
                    if (map:size($facet-filter) gt 0) then map { "facets": $facet-filter } else ()
                ))
            (: Match at document-root level (collection(…)/*) — a single-step
               axis preserves ft:score for field queries, unlike //*. Scope is the
               caller's ?scope (recursive) or the sitewide default. :)
            let $hits := collection($scope)/*[ft:query(., $query-string, $options)]
            (: Facet counts (computed while the Lucene context is intact). :)
            let $facets :=
                map {
                    "site-app": search:facet-counts($hits, "site-app"),
                    "site-section": search:facet-counts($hits, "site-section")
                }
            (: Rank by score, dedup per document (highest-scoring hit wins). :)
            let $ranked :=
                for $hit in $hits
                let $score := ft:score($hit)
                order by $score descending
                return map { "hit": $hit, "score": $score, "uri": document-uri(root($hit)) }
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
                "facets": $facets,
                "results": array {
                    for $m in $page
                    let $hit := $m?hit
                    let $doc-uri := $m?uri
                    let $app := replace($doc-uri, "^/db/apps/([^/]+)/.*$", "$1")
                    (: Prefer the producer's site-title/site-url fields; fall back
                       to a <title> child / a computed app-relative URL. :)
                    let $site-title := (ft:field($hit, "site-title", "xs:string"))[. ne ""][1]
                    let $site-url := (ft:field($hit, "site-url", "xs:string"))[. ne ""][1]
                    let $fragments := search:highlights($hit)
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
                        "title": ($site-title, string($hit/ancestor-or-self::*[title][1]/title)[. ne ""], "(untitled)")[1],
                        "app": $app,
                        "url": ($site-url, site:resolve-link($app, replace($doc-uri, "^/db/apps/[^/]+", "")))[1],
                        "score": $m?score,
                        "snippet": $snippet,
                        "highlights": array { $fragments }
                    }
                }
            }
};
