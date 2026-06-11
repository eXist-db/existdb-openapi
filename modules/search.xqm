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
(: Vector module (the embedding/kNN extension). Static dependency: this build
 : targets the vector-capable integration instance, not a stock eXist. :)
declare namespace vector="http://exist-db.org/xquery/vector";

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
 : Vector-similarity branch of /api/search.
 : GET /api/search?vector=<field>&similar=<text>&k=<n>[&scope=<path>]
 :
 : Discovery-driven: the field's embedding model is read from its ft:fields record
 : (the `model` property, present on text-embedding vector fields, per
 : eXist-db/exist#6459), so the client sends only {field, text}. The text is
 : embedded with that model and run as a kNN over the field; hits come back in the
 : same ES-shaped envelope as the keyword search, plus `field`/`model`/`max-score`.
 :
 : Notes:
 : - ft:query-field-vector is context-scoped (it resolves against the documents in
 :   the focus), so it is called as collection($scope)/ft:query-field-vector(...).
 : - the engine's k is a candidate-pool hint, not a hard limit, so k is enforced
 :   here via ft:score ordering + subsequence (same as keyword pagination).
 :)
declare %private function search:vector-query(
    $field as xs:string, $similar as xs:string?, $scope as xs:string+,
    $k as xs:integer, $groups as xs:string*, $is-dba as xs:boolean
) {
    if (empty($similar) or $similar = "")
    then roaster:response(400, "application/json",
        map { "error": "Missing required parameter for vector search: similar" })
    (: Field-level security: the same policy /api/search/fields applies. :)
    else if (not(fpol:visible($field, $groups, $is-dba)))
    then roaster:response(403, "application/json",
        map { "error": "Field not available: " || $field })
    else
        (: Resolve the field's embedding model from its ft:fields record. Bind $r
           explicitly (avoid ?key in a predicate — eXist mis-handles the cardinality
           for >1 item, XPTY0004). :)
        let $vrec := (for $r in ft:fields($scope) where $r?kind = "vector" and $r?field = $field return $r)[1]
        let $model := $vrec?model
        return
            if (empty($vrec))
            then roaster:response(404, "application/json",
                map { "error": "Vector field not found in scope: " || $field })
            else if (empty($model) or $model = "")
            then roaster:response(400, "application/json",
                map { "error": "Field '" || $field || "' has no embedding model; it cannot embed query text (index it with a model, or query with a precomputed vector)" })
            else
                let $vec := vector:embed($similar, $model)
                let $hits := collection($scope)/ft:query-field-vector($field, $vec, $k)
                let $ranked :=
                    for $h in $hits
                    let $score := ft:score($h)
                    order by $score descending
                    return map { "hit": $h, "score": $score, "uri": document-uri(root($h)) }
                let $top := subsequence($ranked, 1, $k)
                return map {
                    "query": $similar,
                    "field": $field,
                    "model": $model,
                    "total": count($ranked),
                    "k": $k,
                    "max-score": ($top[1]?score, 0)[1],
                    "results": array {
                        for $m in $top
                        let $hit := $m?hit
                        let $doc-uri := $m?uri
                        let $app := replace($doc-uri, "^/db/apps/([^/]+)/.*$", "$1")
                        return map {
                            "uri": $doc-uri,
                            "path": $doc-uri,
                            "title": (string($hit/ancestor-or-self::*[title][1]/title)[. ne ""], "(untitled)")[1],
                            "app": $app,
                            "url": site:resolve-link($app, replace($doc-uri, "^/db/apps/[^/]+", "")),
                            "score": $m?score,
                            "snippet": serialize(
                                <span>{ substring(string-join($hit//text(), " "), 1, 200) }</span>,
                                map { "method": "xml" })
                        }
                    }
                }
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
    (: roaster hands a repeatable (array-typed) query param back as an XQuery
       array(*) when several values are given, or an atomic when one is — unwrap
       to a plain sequence either way. :)
    let $scope-list := let $raw := $request?parameters?scope
                       return if ($raw instance of array(*)) then $raw?* else $raw
    let $scope :=
        if (exists($scope-list[. ne ""]))
        then $scope-list[. ne ""]
        else "/db/apps"
    let $user := $request?user
    let $groups := ($user?groups, "guest")
    let $is-dba := ($user?dba, false())[1]
    let $limit := ($request?parameters?limit, 20)[1] cast as xs:integer
    let $offset := ($request?parameters?offset, 0)[1] cast as xs:integer
    (: vector: switch to similarity search over a named vector field. similar: the
       query text to embed (server resolves the field's model). Mutually exclusive
       with the keyword path — when present, q is not required. :)
    let $vector-field := $request?parameters?vector[. ne ""]
    let $k := ($request?parameters?k, 10)[1] cast as xs:integer
    return
        if (exists($vector-field))
        then search:vector-query($vector-field, $request?parameters?similar, $scope, $k, $groups, $is-dba)
        else if (empty($q) or $q = "")
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
            (: Facet filter — ES post_filter semantics: selecting a value narrows the
               returned HITS but NOT the bucket counts, so the counts reflect the base
               query and stay stable as the user drills. Sources: ?facet=<dim>:<value>
               (repeatable; same dim -> OR, different dims -> AND) plus the app/section
               shortcuts (= site-app / site-section). :)
            let $facet-list := let $raw := $request?parameters?facet
                               return if ($raw instance of array(*)) then $raw?* else $raw
            let $facet-pairs := (
                for $f in $facet-list[. ne ""]
                let $d := substring-before($f, ":")
                let $v := substring-after($f, ":")
                where $d ne "" and $v ne ""
                return map { "d": $d, "v": $v },
                if (exists($app-filter) and $app-filter ne "") then map { "d": "site-app", "v": $app-filter } else (),
                if (exists($section-filter) and $section-filter ne "") then map { "d": "site-section", "v": $section-filter } else ()
            )
            (: group values by dimension. NB: avoid ?key in predicates/simple-maps
               (e.g. $pairs[?d = $x]) — eXist mis-handles the cardinality (fine for
               one item, XPTY0004 for several); bind $p and look up explicitly. :)
            let $facet-dims := distinct-values(for $p in $facet-pairs return $p?d)
            let $facet-filter :=
                map:merge(
                    for $d in $facet-dims
                    let $vals := distinct-values(for $p in $facet-pairs where $p?d eq $d return $p?v)
                    return map { $d: $vals }
                )
            let $base-options :=
                map {
                    "default-operator": "and",
                    "filter-rewrite": "yes",
                    (: load the producer's display fields so ft:field can return them :)
                    "fields": ("site-title", "site-url")
                }
            (: Base result set (no facet filter) — drives the stable facet counts.
               Match at document-root level (collection(…)/*): a single-step axis
               preserves ft:score for field queries, unlike //*. Scope is the caller's
               ?scope (recursive) or the sitewide default. :)
            let $base-hits := collection($scope)/*[ft:query(., $query-string, $base-options)]
            let $facets :=
                map {
                    "site-app": search:facet-counts($base-hits, "site-app"),
                    "site-section": search:facet-counts($base-hits, "site-section")
                }
            (: Post-filter: when a facet is selected, narrow the hits via Lucene
               drill-down; otherwise the hits are the base set. :)
            let $hits :=
                if (map:size($facet-filter) gt 0)
                then collection($scope)/*[ft:query(., $query-string, map:put($base-options, "facets", $facet-filter))]
                else $base-hits
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
