# exist-api: Gaps for Dashboard Collections Manager

The Dashboard Collections Manager (see `~/workspace/dashboard-next/taskings/collections-browser.md`)
uses exist-api as its backend. Most CRUD operations are already implemented, but several
issues need investigation and resolution.

## 1. GET /api/db/collection returns 405 (Method Not Allowed)

**Severity**: blocking — collection ZIP download doesn't work

**Symptom**: `GET /api/db/collection?path=/db/apps/docs` returns 405 from roaster:
```
"The method get is not supported for /api/db/collection"
```

POST and DELETE on the same path work fine (create-collection returns 201,
remove-collection returns 200).

**Implementation exists** in `modules/db.xqm`:
```xquery
declare function db:download-collection($request as map(*)) {
    ...
    let $zip := compression:zip($entries, false())
    let $name := replace($path, "^.*/", "") || ".zip"
    return response:stream-binary($zip, "application/zip", $name)
};
```

**api.json route** is correctly defined:
```json
"get": {
    "operationId": "db:download-collection",
    "summary": "Download collection as ZIP",
    "responses": {
        "200": {
            "content": {
                "application/zip": {
                    "schema": { "type": "string", "format": "binary" }
                }
            }
        }
    }
}
```

**Likely cause**: `response:stream-binary()` bypasses roaster's response pipeline.
Roaster expects the function to return a value that it serializes, but
`response:stream-binary()` writes directly to the HTTP output stream and returns
`empty-sequence()`. Roaster may interpret the empty return as an error.

**Investigation steps**:
1. Check if other exist-api endpoints use `response:stream-binary()` successfully
2. Check roaster's source for how it handles binary responses vs JSON responses
3. Try returning the binary data directly instead of using `response:stream-binary()`:
   ```xquery
   roaster:response(200, "application/zip", $zip)
   ```
   or use roaster's built-in binary response mechanism if it has one
4. Check roaster 1.12.0 release notes for binary response support
5. Test with `response:set-header("Content-Disposition", ...)` + direct binary return

**Alternative**: bypass roaster entirely with a dedicated XQuery endpoint (like
`modules/download.xq`) that handles the ZIP streaming directly via the REST API.


## 2. No rename endpoint

**Severity**: needed for Collections Manager

**Status**: neither `db:rename` nor `/api/db/rename` exist in the codebase.

**Implementation needed** in `modules/db.xqm`:
```xquery
declare function db:rename($request as map(*)) {
    let $body := $request?body
    let $path := $body?path
    let $name := $body?name
    return
        if (empty($path) or empty($name))
        then roaster:response(400, map { "error": "Missing required fields: path, name" })
        else if (xmldb:collection-available($path))
        then
            let $parent := replace($path, "/[^/]+$", "")
            let $old-name := replace($path, "^.*/", "")
            let $_ := xmldb:rename($parent, $old-name, $name)
            return map { "renamed": $path, "to": $parent || "/" || $name }
        else
            let $collection := replace($path, "/[^/]+$", "")
            let $resource := replace($path, "^.*/", "")
            let $_ := xmldb:rename($collection, $resource, $name)
            return map { "renamed": $path, "to": $collection || "/" || $name }
};
```

**api.json route** to add:
```json
"/api/db/rename": {
    "post": {
        "operationId": "db:rename",
        "summary": "Rename resource or collection",
        "requestBody": {
            "content": {
                "application/json": {
                    "schema": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Current DB path" },
                            "name": { "type": "string", "description": "New name" }
                        },
                        "required": ["path", "name"]
                    }
                }
            }
        }
    }
}
```

**eXide comparison**: eXide uses `POST api/storage/{path}` with
`{ "action": "rename", "target": "new-name" }`. Our approach uses a dedicated
endpoint which is cleaner and consistent with `db:copy` and `db:move`.


## 3. db:list missing `mime` and `writable` fields

**Severity**: nice-to-have — Collections Manager needs MIME type for icon mapping
and `writable` to show/hide write operations per-item

**Current response** for each resource entry:
```json
{
    "name": "collection.xconf",
    "path": "/db/apps/docs/data/try-it/ft/data/collection.xconf",
    "type": "resource",
    "mode": "rw-rw-r--",
    "owner": "docs",
    "group": "docs",
    "size": 4096,
    "modified": "2026-04-17T02:03:58.696Z",
    "created": "2026-04-17T02:03:58.696Z",
    "acl": []
}
```

**Fields to add**:
- `mime` — from `xmldb:get-mime-type(xs:anyURI($path))`
- `writable` — from `sm:has-access(xs:anyURI($path), "w")`

Both are cheap lookups and should be added to `db:get-resource-info()` in `modules/db.xqm`.

**Workaround**: the Collections Manager can infer MIME type from the file extension
(eXide does this with `fileIcon()` in `resources.js`), and can check `writable`
via the mode string + current user. But having the server compute these is more
reliable and avoids edge cases with ACLs.


## 4. Serialization parameters for resource download

**Severity**: nice-to-have — XML download serialization control

**Current state**: `db:get-resource` fetches content but may not support `indent`,
`expand-xincludes`, and `omit-xml-decl` query parameters for download.

**Check**: verify whether `db:get-resource` already passes these through to
`util:serialize()` or the exist serializer. If not, add support following eXide's
pattern (which passes these as query params to its storage API).


## Summary

| Issue | Status | Priority |
|-------|--------|----------|
| GET /api/db/collection (ZIP download) | 405 — needs investigation | Blocking |
| POST /api/db/rename | Not implemented | Needed |
| `mime` + `writable` in db:list | Not implemented | Nice-to-have |
| Serialization params for download | Unknown — needs check | Nice-to-have |
