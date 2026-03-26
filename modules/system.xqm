xquery version "3.1";

(:~
 : System information endpoints.
 : Replaces xst's info.xq module.
 :)
module namespace system-api="http://exist-db.org/api/system";

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
