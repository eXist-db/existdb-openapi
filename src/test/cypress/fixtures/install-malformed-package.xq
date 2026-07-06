let $ver := "${app.version}"
let $pkg :=
    <package xmlns="http://expath.org/ns/pkg" name="http://example.com/badver" abbrev="badver" version="{$ver}" spec="1.0">
        <title>Bad Version Package</title>
    </package>
let $repo :=
    <meta xmlns="http://exist-db.org/xquery/repo">
        <description>Bad version repro</description>
        <type>library</type>
        <status>stable</status>
    </meta>
let $entries := (
    <entry name="expath-pkg.xml" type="xml">{$pkg}</entry>,
    <entry name="repo.xml" type="xml">{$repo}</entry>
)
let $zip := compression:zip($entries, true())
let $stored := xmldb:store("/db/system/repo", "badver-setup.xar", $zip, "application/zip")
return repo:install-and-deploy-from-db($stored, "https://exist-db.org/exist/apps/public-repo/find")/@target/string()
