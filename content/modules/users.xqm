xquery version "3.1";

(:~
 : User and group management endpoints.
 : Admin-only operations using sm:* functions.
 :)
module namespace users="http://exist-db.org/api/users";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : Get current user identity.
 : GET /api/users/whoami
 :
 : Returns the real and effective user identities and group memberships.
 : Replaces xst's whoami.xq module.
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
        then map { "error": "User not found: " || $name }
        else
            map {
                "name": $name,
                "groups": array { sm:get-user-groups($name) },
                "primaryGroup": sm:get-user-primary-group($name),
                "enabled": sm:is-account-enabled($name),
                "umask": sm:get-umask($name)
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
        then map { "error": "Missing required fields: name, password" }
        else (
            sm:create-account($name, $password, $name,
                if (exists($groups)) then $groups?* else ()),
            map { "created": $name }
        )
};

(:~
 : Update user.
 : PUT /api/users/{name}
 :)
declare function users:update($request as map(*)) {
    let $name := $request?parameters?name
    let $body := $request?body
    return
        if (not($name = sm:list-users()))
        then map { "error": "User not found: " || $name }
        else (
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
            map { "updated": $name }
        )
};

(:~
 : Remove user.
 : DELETE /api/users/{name}
 :)
declare function users:remove($request as map(*)) {
    let $name := $request?parameters?name
    return (
        sm:remove-account($name),
        map { "removed": $name }
    )
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
 : Create group.
 : POST /api/groups
 :)
declare function users:create-group($request as map(*)) {
    let $body := $request?body
    let $name := $body?name
    let $managers := $body?managers
    return
        if (empty($name))
        then map { "error": "Missing required field: name" }
        else (
            sm:create-group($name,
                if (exists($managers)) then $managers?* else ()),
            map { "created": $name }
        )
};

(:~
 : Remove group.
 : DELETE /api/groups/{name}
 :)
declare function users:remove-group($request as map(*)) {
    let $name := $request?parameters?name
    return (
        sm:remove-group($name),
        map { "removed": $name }
    )
};
