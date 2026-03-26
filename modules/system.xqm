xquery version "3.1";

(:~
 : System information endpoints.
 : Replaces xst's info.xq module.
 :)
module namespace system-api="http://exist-db.org/api/system";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : Get system information.
 : GET /api/system/info
 :
 : Returns database, Java, and OS information.
 : No authentication required.
 :)
declare function system-api:info($request as map(*)) {
    map {
        "db": map {
            "name": system:get-product-name(),
            "version": system:get-version(),
            "git": system:get-revision()
        },
        "java": map {
            "version": util:system-property("java.version"),
            "vendor": util:system-property("java.vendor")
        },
        "os": map {
            "name": util:system-property("os.name"),
            "version": util:system-property("os.version"),
            "arch": util:system-property("os.arch")
        }
    }
};
