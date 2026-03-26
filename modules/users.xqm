xquery version "3.1";

(:~
 : User and group management endpoints.
 : Admin-only operations using sm:* functions.
 :)
module namespace users="http://exist-db.org/api/users";

import module namespace roaster="http://e-editiones.org/roaster";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : Get the current user's real username.
 :)
declare %private function users:current-user() as xs:string {
    sm:id()//sm:real/sm:username/string()
};

(:~
 : Get current user identity.
 : GET /api/users/whoami
 :)
declare function users:whoami($request as map(*)) {
    let $id := sm:id()
    let $real := $id//sm:real
    let $effective := $id//sm:effective
    return map {
        "real": map {
            "user": string($real/sm:username),
            "groups": array { $real/sm:groups/sm:group/string() }
        },
        "effective": map {
            "user": string(($effective/sm:username, $real/sm:username)[1]),
            "groups": array { ($effective/sm:groups, $real/sm:groups)[1]/sm:group/string() }
        }
    }
};

(:~
 : List all users.
 : GET /api/users
 :)
declare function users:list($request as map(*)) {
    array {
        for $user in sm:list-users()
        order by $user
        return map {
            "name": $user,
            "groups": array { sm:get-user-groups($user) },
            "enabled": sm:is-account-enabled($user)
        }
    }
};

(:~
 : Get user details.
 : GET /api/users/{name}
 :)
declare function users:get($request as map(*)) {
    let $name := $request?parameters?name
    return
        if (not($name = sm:list-users()))
        then roaster:response(404, map { "error": "User not found: " || $name })
        else
            map {
                "name": $name,
                "groups": array { sm:get-user-groups($name) },
                "primaryGroup": sm:get-user-primary-group($name),
                "enabled": sm:is-account-enabled($name),
                "umask": sm:get-umask($name),
                "metadata": array {
                    for $key in sm:get-account-metadata-keys($name)
                    return map {
                        "key": $key,
                        "value": sm:get-account-metadata($name, $key)
                    }
                }
            }
};

(:~
 : Create user.
 : POST /api/users
 :)
declare function users:create($request as map(*)) {
    let $body := $request?body
    let $name := $body?name
    let $password := $body?password
    let $groups := $body?groups
    return
        if (empty($name) or empty($password))
        then roaster:response(400, map { "error": "Missing required fields: name, password" })
        else
            let $_ := sm:create-account($name, $password, $name,
                if (exists($groups)) then $groups?* else ())
            return roaster:response(201, map { "created": $name })
};

(:~
 : Update user.
 : PUT /api/users/{name}
 :
 : Supports: password, groups, primaryGroup, enabled, metadata
 :)
declare function users:update($request as map(*)) {
    let $name := $request?parameters?name
    let $body := $request?body
    return
        if (not($name = sm:list-users()))
        then roaster:response(404, map { "error": "User not found: " || $name })
        else
            let $_ := (
                if ($body?password)
                then sm:passwd($name, $body?password)
                else (),
                if (exists($body?groups))
                then
                    for $group in $body?groups?*
                    return
                        if (not($group = sm:get-user-groups($name)))
                        then sm:add-group-member($group, $name)
                        else ()
                else (),
                if ($body?primaryGroup)
                then sm:set-user-primary-group($name, $body?primaryGroup)
                else (),
                if (exists($body?enabled))
                then sm:set-account-enabled($name, $body?enabled)
                else (),
                if (exists($body?metadata))
                then
                    for $entry in $body?metadata?*
                    return sm:set-account-metadata($name, $entry?key, $entry?value)
                else ()
            )
            return map { "updated": $name }
};

(:~
 : Remove user.
 : DELETE /api/users/{name}
 :)
declare function users:remove($request as map(*)) {
    let $name := $request?parameters?name
    let $current := users:current-user()
    return
        if ($name = $current)
        then roaster:response(403, map { "error": "Cannot delete your own account" })
        else if (not($name = sm:list-users()))
        then roaster:response(404, map { "error": "User not found: " || $name })
        else
            let $_ := sm:remove-account($name)
            return map { "removed": $name }
};

(:~
 : List all groups.
 : GET /api/groups
 :)
declare function users:list-groups($request as map(*)) {
    array {
        for $group in sm:list-groups()
        order by $group
        return map {
            "name": $group,
            "managers": array { sm:get-group-managers($group) },
            "members": array { sm:get-group-members($group) }
        }
    }
};

(:~
 : Get group details.
 : GET /api/groups/{name}
 :)
declare function users:get-group($request as map(*)) {
    let $name := $request?parameters?name
    return
        if (not($name = sm:list-groups()))
        then roaster:response(404, map { "error": "Group not found: " || $name })
        else
            map {
                "name": $name,
                "managers": array { sm:get-group-managers($name) },
                "members": array { sm:get-group-members($name) },
                "metadata": array {
                    for $key in sm:get-group-metadata-keys($name)
                    return map {
                        "key": $key,
                        "value": sm:get-group-metadata($name, $key)
                    }
                }
            }
};

(:~
 : Create group.
 : POST /api/groups
 :)
declare function users:create-group($request as map(*)) {
    let $body := $request?body
    let $name := $body?name
    let $managers := $body?managers
    return
        if (empty($name))
        then roaster:response(400, map { "error": "Missing required field: name" })
        else
            let $_ := sm:create-group($name)
            let $_ :=
                if (exists($managers))
                then
                    for $mgr in $managers?*
                    return sm:add-group-manager($name, $mgr)
                else ()
            return roaster:response(201, map { "created": $name })
};

(:~
 : Remove group.
 : DELETE /api/groups/{name}
 :)
declare function users:remove-group($request as map(*)) {
    let $name := $request?parameters?name
    let $current := users:current-user()
    return
        if (not($name = sm:list-groups()))
        then roaster:response(404, map { "error": "Group not found: " || $name })
        else if ($current = sm:get-group-members($name))
        then roaster:response(403, map { "error": "Cannot delete a group you are a member of" })
        else
            let $_ := sm:remove-group($name)
            return map { "removed": $name }
};
