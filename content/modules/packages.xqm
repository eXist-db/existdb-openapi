xquery version "3.1";

(:~
 : Package management endpoints.
 : Install, remove, list, and check updates for EXPath packages.
 :)
module namespace packages="http://exist-db.org/api/packages";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";
declare namespace expath="http://expath.org/ns/pkg";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : List installed packages.
 : GET /api/packages
 :)
declare function packages:list($request as map(*)) {
    array {
        for $pkg in repo:list()
        let $desc := repo:get-resource($pkg, "expath-pkg.xml")
        let $meta :=
            if ($desc)
            then parse-xml(util:binary-to-string($desc))/expath:package
            else ()
        order by $pkg
        return map {
            "name": $pkg,
            "abbrev": string(($meta/@abbrev, "")[1]),
            "version": string(($meta/@version, "")[1]),
            "title": string(($meta/expath:title, "")[1])
        }
    }
};

(:~
 : Get package details.
 : GET /api/packages/{name}
 :)
declare function packages:get($request as map(*)) {
    let $name := $request?parameters?name
    return
        if (not($name = repo:list()))
        then map { "error": "Package not found: " || $name }
        else
            let $desc := repo:get-resource($name, "expath-pkg.xml")
            let $meta :=
                if ($desc)
                then parse-xml(util:binary-to-string($desc))/expath:package
                else ()
            let $repo-desc := repo:get-resource($name, "repo.xml")
            let $repo-meta :=
                if ($repo-desc)
                then parse-xml(util:binary-to-string($repo-desc))/*
                else ()
            return map {
                "name": $name,
                "abbrev": string(($meta/@abbrev, "")[1]),
                "version": string(($meta/@version, "")[1]),
                "title": string(($meta/expath:title, "")[1]),
                "description": string(($repo-meta/*:description, "")[1]),
                "authors": array {
                    for $author in $meta/expath:author
                    return string($author)
                },
                "license": string(($meta/expath:license, "")[1]),
                "website": string(($meta/expath:website, "")[1]),
                "dependencies": array {
                    for $dep in $meta/expath:dependency
                    return map {
                        "processor": string($dep/@processor),
                        "package": string($dep/@package),
                        "semver-min": string($dep/@semver-min)
                    }
                }
            }
};

(:~
 : Install package from URL.
 : POST /api/packages/install
 :)
declare function packages:install($request as map(*)) {
    let $body := $request?body
    let $url := $body?url
    return
        if (empty($url))
        then map { "error": "Missing required field: url" }
        else
            let $result := repo:install-and-deploy-from-db($url)
            return
                map { "installed": string($result) }
};

(:~
 : Remove package.
 : DELETE /api/packages/{name}
 :)
declare function packages:remove($request as map(*)) {
    let $name := $request?parameters?name
    return
        if (not($name = repo:list()))
        then map { "error": "Package not found: " || $name }
        else (
            repo:undeploy($name),
            repo:remove($name),
            map { "removed": $name }
        )
};

(:~
 : Check for package updates against public repository.
 : POST /api/packages/update-check
 :)
declare function packages:update-check($request as map(*)) {
    (: TODO: implement update checking against public repo :)
    map { "error": "Not yet implemented" }
};
