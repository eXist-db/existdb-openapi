(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Field-level-security policy — the SINGLE source of truth for "who may see /
 : query which search field". Deliberately has NO dependency on ft:fields (or any
 : optional core function): it must be importable by /api/search, which has to
 : compile on a stock eXist that lacks the ft:fields function (eXist-db/exist#6459).
 : The discovery endpoint (fields.xqm, which does use ft:fields) and the search
 : endpoint (search.xqm) both import this module so they enforce one policy.
 :
 :  - $fpol:public     : visible to everyone, including the unauthenticated guest.
 :  - $fpol:restricted : field -> the group(s) (any one grants) that may see it;
 :                       a dba always may.
 :  - any field that is neither public nor restricted is visible to any
 :    AUTHENTICATED (non-guest) caller.
 : There are no per-field ACLs in the index; tune here as new fields/consumers
 : appear.
 :)
module namespace fpol = "http://exist-db.org/api/search/field-policy";

declare variable $fpol:public as xs:string+ :=
    ("site-content", "site-title", "site-url", "site-app", "site-section");

declare variable $fpol:restricted as map(*) :=
    map { (: "internal-notes": ("editors", "dba") :) };

(:~ May a caller with these groups (and dba flag) see/query $field? :)
declare function fpol:visible(
    $field as xs:string, $groups as xs:string*, $is-dba as xs:boolean
) as xs:boolean {
    if ($is-dba) then true()
    else if (map:contains($fpol:restricted, $field))
    then (some $g in $groups satisfies $g = $fpol:restricted($field))
    else if ($field = $fpol:public) then true()
    else (: neither public nor restricted -> any authenticated (non-guest) caller :)
        exists($groups[. ne "guest"])
};
