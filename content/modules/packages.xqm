xquery version "3.1";

(:~
 : Package management endpoints.
 : Install, remove, list, and check updates for EXPath packages.
 : Modeled on xst's list-packages.xq, install-from-repo.xq, and uninstall.xq.
 :)
module namespace packages="http://exist-db.org/api/packages";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";
declare namespace expath="http://expath.org/ns/pkg";
declare namespace repo="http://exist-db.org/xquery/repo";
declare namespace exist-pkg="http://exist-db.org/ns/expath-pkg";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : Safely read and parse a package descriptor resource.
 : Returns the parsed document-node or empty sequence on failure.
 :)
declare %private function packages:get-package-meta(
    $package-uri as xs:string, $resource as xs:string
) as document-node()? {
    try {
        repo:get-resource($package-uri, $resource)
        => util:binary-to-string()
        => parse-xml()
    }
    catch * {
        ()
    }
};

(:~
 : Format a dependency element as a map.
 : Handles both processor and package dependencies.
 :)
declare %private function packages:dependency(
    $dep as element(expath:dependency)?
) as map(*) {
    map {
        "name": ($dep/(@package|@processor))[1]/string(),
        "semverMin": $dep/@semver-min/string(),
        "semverMax": $dep/@semver-max/string(),
        "semver": $dep/@semver/string(),
        "versions": array { tokenize($dep/@versions, ' ') }
    }
};

(:~
 : Extract the namespace/import-uri/public-uri from a component element.
 :)
declare %private function packages:component(
    $component as element()
) as xs:string {
    $component/(expath:namespace|expath:import-uri|expath:public-uri)/string()
};

(:~
 : Extract all metadata from expath-pkg.xml and exist.xml.
 : Returns name, abbrev, version, title, processor, dependencies, and components.
 :)
declare %private function packages:expath-meta(
    $package-uri as xs:string
) as map(*) {
    let $expath := packages:get-package-meta($package-uri, "expath-pkg.xml")
    let $extra := packages:get-package-meta($package-uri, "exist.xml")

    let $jars :=
        if (exists($extra))
        then map { "jar": array { $extra//exist-pkg:jar/string() } }
        else ()

    let $components :=
        map {
            "xslt": array { for-each($expath//expath:xslt, packages:component#1) },
            "xquery": array {
                for-each($expath//expath:xquery, packages:component#1),
                if (exists($extra))
                then $extra//exist-pkg:java/exist-pkg:namespace/string()
                else ()
            },
            "xproc": array { for-each($expath//expath:xproc, packages:component#1) },
            "xsd": array { for-each($expath//expath:xsd, packages:component#1) },
            "rng": array { for-each($expath//expath:rng, packages:component#1) },
            "schematron": array { for-each($expath//expath:schematron, packages:component#1) },
            "nvdl": array { for-each($expath//expath:nvdl, packages:component#1) },
            "resource": array { for-each($expath//expath:resource, packages:component#1) }
        }

    return
        map {
            "name": $expath//@name/string(),
            "abbrev": $expath//@abbrev/string(),
            "version": $expath//expath:package/@version/string(),
            "title": $expath//expath:title/text(),
            "processor": array {
                for-each($expath//expath:dependency[@processor], packages:dependency#1)
            },
            "dependencies": array {
                for-each($expath//expath:dependency[@package], packages:dependency#1)
            },
            "components": map:merge(($components, $jars))
        }
};

(:~
 : Extract all metadata from repo.xml.
 : Returns website, description, license, authors, type, and target.
 :)
declare %private function packages:repo-meta(
    $package-uri as xs:string
) as map(*) {
    let $repo := packages:get-package-meta($package-uri, "repo.xml")

    return
        map {
            "website": $repo//repo:website/text(),
            "description": $repo//repo:description/text(),
            "license": $repo//repo:license/text(),
            "authors": array { $repo//repo:author/text() },
            "type": $repo//repo:type/text(),
            "target": $repo//repo:target/text()
        }
};

(:~
 : Get the deployment date for a package.
 : Looks in the app target collection first, then the system repo.
 :)
declare %private function packages:get-deployment-date(
    $expath as map(*), $repo as map(*)
) as xs:string? {
    let $doc :=
        if ($repo?target)
        then doc('/db/apps/' || $repo?target || '/repo.xml')
        else doc('/db/system/repo/' || $expath?abbrev || '-' || $expath?version || '/repo.xml')

    return $doc//repo:deployed/text()
};

(:~
 : Build full metadata for a single package URI.
 : Merges expath-pkg.xml, exist.xml, and repo.xml data.
 :)
declare %private function packages:full-meta(
    $package-uri as xs:string
) as map(*) {
    let $expath := packages:expath-meta($package-uri)
    let $repo := packages:repo-meta($package-uri)
    let $date := packages:get-deployment-date($expath, $repo)

    return map:merge((
        map { "uri": $package-uri, "date": $date },
        $expath,
        $repo
    ))
};

(:~
 : Resolve a name-or-abbrev to a package URI.
 : Checks the installed package list by URI first, then scans
 : expath-pkg.xml descriptors for a matching @abbrev.
 : Returns the package URI or empty sequence if not found.
 :)
declare %private function packages:resolve-name(
    $name-or-abbrev as xs:string
) as xs:string? {
    let $list := repo:list()
    return
        if ($name-or-abbrev = $list)
        then $name-or-abbrev
        else
            let $expaths :=
                for-each($list, packages:get-package-meta(?, "expath-pkg.xml"))
            let $match :=
                filter($expaths, function ($expath) {
                    $expath//@abbrev = $name-or-abbrev
                })
            return $match[1]//@name/string()
};

(:~
 : List installed packages.
 : GET /api/packages
 :)
declare function packages:list($request as map(*)) {
    array {
        for-each(repo:list(), packages:full-meta#1)
    }
};

(:~
 : Get package details.
 : GET /api/packages/{name}
 : Accepts package name (URI) or abbreviation.
 :)
declare function packages:get($request as map(*)) {
    let $name-or-abbrev := $request?parameters?name
    let $name := packages:resolve-name($name-or-abbrev)
    return
        if (empty($name))
        then map { "error": "Package not found: " || $name-or-abbrev }
        else packages:full-meta($name)
};

(:~
 : Install package from public registry.
 : POST /api/packages/install
 : Request body: { "name": "...", "url": "...", "version": "..." }
 :   name    - package name (URI) to install
 :   url     - registry find URL (e.g., "https://exist-db.org/exist/apps/public-repo/find")
 :   version - specific version (omit or empty string for latest)
 :)
declare function packages:install($request as map(*)) {
    let $body := $request?body
    let $package-name := $body?name
    let $registry-url := $body?url
    let $version := ($body?version, "")[1]
    let $latest := $version eq ''
    return
        if (empty($package-name) or empty($registry-url))
        then map { "error": "Missing required fields: name, url" }
        else
            try {
                (: Remove existing installation first, like xst does :)
                let $guard :=
                    if (not($package-name = repo:list()))
                    then ()
                    else if (
                        repo:undeploy($package-name)/@result = "ok"
                        and repo:remove($package-name)
                    )
                    then ()
                    else error(
                        xs:QName("packages:REMOVE_FAILED"),
                        "Existing installation of " || $package-name ||
                            " could not be removed"
                    )

                let $installation :=
                    if ($latest)
                    then repo:install-and-deploy($package-name, $registry-url)
                    else repo:install-and-deploy(
                        $package-name, $version, $registry-url
                    )

                return map {
                    "success": ($installation/@result = "ok"),
                    "result": map {
                        "name": $package-name,
                        "version": $version,
                        "target": $installation/@target/string()
                    }
                }
            }
            catch * {
                map {
                    "success": false(),
                    "error": map {
                        "code": $err:code,
                        "description": $err:description,
                        "value": $err:value
                    }
                }
            }
};

(:~
 : Remove package.
 : DELETE /api/packages/{name}
 : Accepts package name (URI) or abbreviation.
 :)
declare function packages:remove($request as map(*)) {
    let $name-or-abbrev := $request?parameters?name
    let $force := string($request?parameters?force) = "true"
    let $name := packages:resolve-name($name-or-abbrev)
    return
        if (empty($name))
        then map { "error": "Package not found: " || $name-or-abbrev }
        else
            (: Check for dependent packages unless force=true :)
            let $dependents :=
                if ($force) then ()
                else packages:find-dependents($name)
            return
                if (exists($dependents) and not($force))
                then map {
                    "error": "Cannot remove: other packages depend on " || $name,
                    "dependents": array { $dependents },
                    "hint": "Use force=true to remove anyway"
                }
                else
                    let $undeploy := repo:undeploy($name)/@result = "ok"
                    let $remove := repo:remove($name)
                    return map {
                        "name": $name,
                        "undeploy": $undeploy,
                        "remove": $remove
                    }
};

(:~
 : Find packages that depend on the given package.
 : Used by remove() for dependency safety check.
 : Modeled on xst's uninstall.xq dependency analysis.
 :)
declare %private function packages:find-dependents($name as xs:string) as xs:string* {
    for $pkg in repo:list()
    where $pkg ne $name
    let $desc := packages:get-package-meta($pkg, "expath-pkg.xml")
    where exists($desc)
    where $desc//expath:dependency[@package = $name]
    return $pkg
};

(:~
 : Check for package updates against public repository.
 : POST /api/packages/update-check
 :)
declare function packages:update-check($request as map(*)) {
    (: TODO: implement update checking against public repo :)
    map { "error": "Not yet implemented" }
};
