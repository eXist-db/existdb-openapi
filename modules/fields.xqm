(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Sitewide search — field discovery (Phase 2).
 :
 : Answers "what can I search here, and what is each field's contract?" for a
 : consumer (e.g. the Oxygen plugin's field picker) before it issues a query.
 :
 : Two layers, deliberately separate (the Elasticsearch model — see the
 : broaden-/api/search design):
 :   1. CATALOG — the full set of configured fields/facets under a scope, from the
 :      native ft:fields($scope). It reads the resolved Lucene index config via the
 :      broker, is permission-AGNOSTIC, and is callable by any user (it does NOT
 :      require the caller to read the admin-only /db/system/config).
 :   2. FLS — a group->fields policy decides which catalog entries THIS caller may
 :      see, applied after the (permission-agnostic) catalog read. Field access
 :      lives in the policy, never as an ACL on the field. Document-level security
 :      is already enforced underneath by ft:query-scope/ft:search-scope node
 :      materialization; this is the field-level layer on top.
 :)
module namespace fields = "http://exist-db.org/api/search/fields";

declare namespace output = "http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~ Default scope when the caller doesn't specify one. :)
declare variable $fields:default-scope as xs:string := "/db/apps";

(:~
 : FLS policy.
 :  - $fields:public    : visible to everyone, including the unauthenticated guest.
 :  - $fields:restricted: field -> the group(s) (any one grants) that may see it;
 :                        a dba always may.
 :  - any field that is neither public nor restricted is visible to any
 :    AUTHENTICATED (non-guest) caller.
 : This is the single place "who sees what" is decided — there are no per-field
 : ACLs in the index. Tune here as new fields/consumers appear.
 :)
declare variable $fields:public as xs:string+ :=
    ("site-content", "site-title", "site-url", "site-app", "site-section");
declare variable $fields:restricted as map(*) :=
    map { (: "internal-notes": ("editors", "dba") :) };

(:~ All descendant collections of $col (inclusive), for cross-collection union. :)
declare %private function fields:descendant-collections($col as xs:string) as xs:string* {
    if (xmldb:collection-available($col))
    then ($col, for $child in xmldb:get-child-collections($col)
                return fields:descendant-collections($col || "/" || $child))
    else ()
};

(:~
 : CATALOG — the full field/facet set configured under $scope, via native
 : ft:fields. Returns one map per configured field/facet OCCURRENCE:
 :   { field, element, kind: "field"|"facet", analyzer?, type?, returnable? }
 : (analyzer/type/returnable on fields only). Permission-agnostic.
 :
 : NOTE: ft:fields resolves the SINGLE config for a given collection/doc-set; it
 : does NOT aggregate across sub-collections (ft:fields("/db/apps") is empty when
 : the configs live on each app's data collection, and a sequence scope resolves
 : to only the first collection's config). For site-wide discovery we therefore
 : union ft:fields over every descendant collection in scope. If ft:fields gains
 : native cross-collection aggregation, this collapses to a single ft:fields($scope).
 :)
declare %private function fields:catalog($scope as xs:string*) as map(*)* {
    for $col in distinct-values($scope ! fields:descendant-collections(.))
    (: ft:fields also emits element-level text-index records (a plain <text qname>
       with no named <field> yields a map with only "element"); those aren't
       named, field:(...)-queryable fields, so drop them from the catalog. :)
    return ft:fields($col)[exists(?field)]
};

(:~
 : Collapse the per-occurrence catalog to one record per (field, kind), keeping
 : the distinct elements it is indexed on AND the distinct analyzers used. A
 : shared field can be indexed with different analyzers on different elements
 : (e.g. site-content uses StandardAnalyzer on most elements but SimpleAnalyzer on
 : the docs xqdoc elements); surfacing both as a list reveals that variance rather
 : than hiding it behind whichever occurrence happened to come first.
 :)
declare %private function fields:dedup($cat as map(*)*) as map(*)* {
    let $sep := codepoints-to-string(9)
    for $key in distinct-values($cat ! (?field || $sep || ?kind))
    let $g := $cat[(?field || $sep || ?kind) = $key]
    let $first := $g[1]
    let $analyzers := distinct-values($g ! ?analyzer)[. ne ""]
    return map:merge((
        map {
            "field": $first?field,
            "kind": $first?kind,
            "elements": array { distinct-values($g ! ?element) }
        },
        if ($first?kind = "field") then map {
            "analyzer": (if (count($analyzers) gt 1) then array { $analyzers } else ($analyzers, ())[1]),
            "type": $first?type,
            "returnable": $first?returnable
        } else ()
    ))
};

(:~ FLS: may a caller with these groups (and dba flag) see $field? :)
declare %private function fields:visible(
    $field as xs:string, $groups as xs:string*, $is-dba as xs:boolean
) as xs:boolean {
    if ($is-dba) then true()
    else if (map:contains($fields:restricted, $field))
    then (some $g in $groups satisfies $g = $fields:restricted($field))
    else if ($field = $fields:public) then true()
    else (: neither public nor restricted -> any authenticated (non-guest) caller :)
        exists($groups[. ne "guest"])
};

(:~
 : Discover the searchable fields under $scope visible to $user.
 : @param $scope one or more collection paths (document paths, recursive)
 : @param $user  the caller identity map (e.g. $request?user): { name, groups, dba }
 :)
declare function fields:discover($scope as xs:string*, $user as map(*)?) as map(*) {
    let $name := ($user?name, "guest")[1]
    let $groups := ($user?groups, "guest")
    let $is-dba := ($user?dba, false())[1]
    let $catalog := fields:dedup(fields:catalog($scope))
    let $visible := $catalog[fields:visible(?field, $groups, $is-dba)]
    return map {
        "scope": array { $scope },
        "user": $name,
        "total": count($visible),
        "fields": array {
            for $e in $visible
            order by $e?kind, $e?field
            return $e
        }
    }
};

(:~
 : GET /api/search/fields?scope=/db/apps[&field=site-content]
 : Lists the searchable fields/facets the caller may see; with ?field, returns just
 : that field's contract.
 :)
declare function fields:list($request as map(*)) {
    let $scope := ($request?parameters?scope[. ne ""], $fields:default-scope)
    let $field := $request?parameters?field
    let $result := fields:discover($scope, $request?user)
    return
        if (exists($field) and $field ne "")
        then map:merge((
            map:remove($result, "fields"),
            map { "fields": array { $result?fields?*[?field = $field] } }
        ))
        else $result
};
