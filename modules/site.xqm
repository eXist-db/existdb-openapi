xquery version "3.1";

(:~
 : Site utility endpoints.
 : Resolve cross-app links and list installed applications.
 :)
module namespace site="http://exist-db.org/api/site";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";
declare namespace repo="http://exist-db.org/xquery/repo";
declare namespace expath="http://expath.org/ns/pkg";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : List installed applications with metadata.
 : GET /api/site/apps
 :)
declare function site:apps($request as map(*)) {
    array {
        for $pkg in repo:list()
        let $desc := repo:get-resource($pkg, "expath-pkg.xml")
        where exists($desc)
        let $meta := parse-xml(util:binary-to-string($desc))/expath:package
        let $repo-desc := repo:get-resource($pkg, "repo.xml")
        let $repo-meta :=
            if (exists($repo-desc))
            then parse-xml(util:binary-to-string($repo-desc))/*
            else ()
        (: Only include applications, not libraries :)
        where string($repo-meta/*:type) = "application"
        let $abbrev := string(($meta/@abbrev, "")[1])
        order by $abbrev
        return map {
            "name": $pkg,
            "abbrev": $abbrev,
            "title": string(($meta/expath:title, $abbrev)[1]),
            "version": string(($meta/@version, "")[1]),
            "url": "/exist/apps/" || $abbrev || "/",
            (: TODO: replace with repo:resource-available($pkg, "icon.png") once
             : eXist-db PR #6184 is merged and released.
             : See https://github.com/eXist-db/exist/issues/3904 :)
            "icon":
                if (try { exists(repo:get-resource($pkg, "icon.png")) } catch * { false() })
                then "/exist/apps/" || $abbrev || "/icon.png"
                else ""
        }
    }
};

(:~
 : Resolve a cross-app link.
 : GET /api/site/resolve?app=docs&path=/getting-started
 :
 : Returns the URL for the given app + path. Falls back to exist-db.org
 : if the app is not installed locally.
 :)
declare function site:resolve($request as map(*)) {
    let $app := $request?parameters?app
    let $path := $request?parameters?path
    return
        if (empty($app) or empty($path))
        then map { "error": "Missing required parameters: app, path" }
        else
            map {
                "url": site:resolve-link($app, $path)
            }
};

(:~
 : Internal helper: resolve a link to an app + path.
 : Returns local URL if installed, otherwise falls back to exist-db.org.
 :)
declare function site:resolve-link($app as xs:string, $path as xs:string) as xs:string {
    if (xmldb:collection-available("/db/apps/" || $app))
    then "/exist/apps/" || $app || "/" || replace($path, "^/", "")
    else "https://exist-db.org/" || $app || "/" || replace($path, "^/", "")
};
