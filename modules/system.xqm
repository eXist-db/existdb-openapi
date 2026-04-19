xquery version "3.1";

(:~
 : System information endpoints.
 : Replaces xst's info.xq module.
 :)
module namespace system-api="http://exist-db.org/api/system";

import module namespace roaster="http://e-editiones.org/roaster" at "roaster-compat.xqm";
import module namespace test="http://exist-db.org/xquery/xqsuite"
    at "resource:org/exist/xquery/lib/xqsuite/xqsuite.xql";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";
declare namespace scheduler="http://exist-db.org/xquery/scheduler";

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

(:~
 : Get scheduled jobs.
 : GET /api/system/scheduler
 :
 : Returns the list of scheduled jobs from scheduler:get-scheduled-jobs().
 : Used by Dashboard's System tab to display scheduler information.
 :)
declare function system-api:scheduler($request as map(*)) {
    let $jobs := scheduler:get-scheduled-jobs()
    return map {
        "jobs": array {
            for $group in $jobs//scheduler:group
            let $group-name := string($group/@name)
            for $job in $group/scheduler:job
            return map {
                "name": string($job/@name),
                "group": $group-name,
                "triggerState": string($job/scheduler:trigger/@state),
                "start": string($job/scheduler:trigger/scheduler:start),
                "end": string($job/scheduler:trigger/scheduler:end),
                "previous": string($job/scheduler:trigger/scheduler:previous),
                "next": string($job/scheduler:trigger/scheduler:next),
                "expression": string($job/scheduler:trigger/scheduler:expression)
            }
        }
    }
};

(:~
 : Run XQSuite tests.
 : POST /api/test
 :
 : Accepts { "source": "/db/apps/myapp/test/suite.xql" } and runs
 : test:suite() on the module. Returns the XQSuite results.
 :)
declare function system-api:test($request as map(*)) {
    let $source := $request?body?source
    return
        if (empty($source))
        then roaster:response(400, map { "error": "Missing required field: source" })
        else if (not(util:binary-doc-available(xs:anyURI("xmldb:exist://" || $source))))
        then roaster:response(404, map { "error": "Test module not found: " || $source })
        else
            let $functions := inspect:module-functions(xs:anyURI("xmldb:exist://" || $source))
            let $results := test:suite($functions)
            return map {
                "source": $source,
                "tests": count($results//testcase),
                "failures": count($results//testcase/failure),
                "errors": count($results//testcase/error),
                "pending": count($results//testcase[@pending = 'true']),
                "results": serialize($results)
            }
};
