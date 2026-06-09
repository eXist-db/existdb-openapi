(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Sitewide search — field discovery (Phase 2, prototype).
 :
 : Enumerates the searchable fields and facets configured across a collection
 : scope, and filters them by a field-level-security (FLS) policy keyed off the
 : caller's identity. Lets a consumer (e.g. the Oxygen plugin) ask "what can I
 : search here?" and "what is this field's contract?" before issuing a query.
 :
 : Two layers, deliberately separated (the ES model — see the broaden-/api/search
 : design):
 :   1. CATALOG — the full set of configured fields/facets, read with privilege.
 :      collection.xconf lives under /db/system/config (not caller-readable), and
 :      the index schema is system-managed, so the catalog read is privileged and
 :      permission-AGNOSTIC. This XQuery xconf-parser is a STAND-IN for the native
 :      ft:fields($scope) (which reads the resolved LuceneConfig via the broker and
 :      sidesteps the /db/system/config read-permission issue entirely — the
 :      concrete reason that function is worth building natively).
 :   2. FLS — the policy that decides which catalog entries THIS caller may see,
 :      applied after the privileged read. Field access lives in the policy (keyed
 :      by group), never as an ACL on the field itself (the Elasticsearch lesson).
 :)
module namespace fields = "http://exist-db.org/api/search/fields";

declare namespace ccc = "http://exist-db.org/collection-config/1.0";
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

(:~
 : CATALOG — parse the collection.xconf docs governing $scope into one record per
 : configured field/facet. Privileged read; returns the FULL set (FLS applied
 : later). Stand-in for ft:fields($scope).
 :
 : @param $scope a collection path, e.g. "/db/apps"
 : @return one map per field/facet: { field, kind, element, analyzer?, type?, returnable? }
 :)
declare %private function fields:catalog($scope as xs:string) as map(*)* {
    let $config-root := "/db/system/config" || $scope
    let $read :=
        function() {
            for $t in collection($config-root)//ccc:text
            let $on := (string($t/@qname), string($t/@match))[. ne ""][1]
            let $analyzer :=
                ( string($t/@analyzer),
                  string(($t/ancestor::ccc:lucene[1]/ccc:analyzer[not(@id)])[1]/@class),
                  string(($t/ancestor::ccc:lucene[1]/ccc:analyzer)[1]/@class) )[. ne ""][1]
            return (
                for $f in $t/ccc:field
                return map {
                    "field": string($f/@name),
                    "kind": "field",
                    "element": $on,
                    "analyzer": ($analyzer[. ne ""], "(default)")[1],
                    "type": (string($f/@type)[. ne ""], "xs:string")[1],
                    "returnable": not(string($f/@store) = "no")
                },
                for $fa in $t/ccc:facet
                return map { "field": string($fa/@dimension), "kind": "facet", "element": $on }
            )
        }
    return
        (: PROTOTYPE: configs are admin-only; read with privilege. The production
           form is ft:fields($scope), which reads the resolved config natively via
           the broker and needs no credential here. :)
        system:as-user("admin", "", $read())
};

(:~ Dedup the catalog by (field, kind) — a shared field (site-content) appears in
 :  many app configs; collapse to one record, keeping the distinct elements it is
 :  indexed on. :)
declare %private function fields:dedup($cat as map(*)*) as map(*)* {
    for $key in distinct-values($cat ! (?field || "\t" || ?kind))
    let $group := $cat[(?field || "\t" || ?kind) = $key]
    let $first := $group[1]
    return map:merge((
        $first,
        map { "elements": array { distinct-values($group ! ?element) } }
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
        exists($groups[. ne "guest"]) or (exists($groups) and not($groups = "guest"))
};

(:~
 : Discover the searchable fields under $scope visible to $user.
 : @param $scope a collection path
 : @param $user  the caller identity map (e.g. $request?user): { name, groups, dba }
 :)
declare function fields:discover($scope as xs:string, $user as map(*)?) as map(*) {
    let $name := ($user?name, "guest")[1]
    let $groups := ($user?groups, "guest")
    let $is-dba := ($user?dba, false())[1]
    let $catalog := fields:dedup(fields:catalog($scope))
    let $visible := $catalog[fields:visible(?field, $groups, $is-dba)]
    return map {
        "scope": $scope,
        "user": $name,
        "total": count($visible),
        "fields": array {
            for $e in $visible
            order by $e?kind, $e?field
            return map:remove($e, "element")
        }
    }
};

(:~
 : GET /api/search/fields?scope=/db/apps[&field=site-content]
 : Lists the searchable fields/facets the caller may see; with ?field, returns just
 : that field's contract.
 :)
declare function fields:list($request as map(*)) {
    let $scope := ($request?parameters?scope[. ne ""], $fields:default-scope)[1]
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
