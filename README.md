# existdb-openapi

An OpenAPI-described HTTP API for [eXist-db](https://exist-db.org/) — a single,
versioned REST surface for database management, query execution, language
services, user/group/package administration, search, and cross-app linking.

**Status:** pre-1.0 (`0.9.x` releases). The 1.0.0 milestone tracks API
stabilization. See [issue #2](https://github.com/eXist-db/existdb-openapi/issues/2).

---

## What this is (and isn't)

eXist-db ships several HTTP surfaces accumulated over its history:

- **RESTXQ** — declarative URL routing for XQuery (annotation-based)
- **REST Server** (`/exist/rest/`) — the legacy XML:DB-flavored interface
- **XML:DB / XML-RPC** — the older Java/RPC era
- the **Roaster** framework — the toolkit this project is built on

`existdb-openapi` is **none of the above** — it's a new, OpenAPI-described
surface that consolidates the operations modern eXist apps actually need (admin
endpoints, query execution, language services for editor integration) under a
coherent versioned contract. It's defined by [`modules/api.json`](modules/api.json),
served by the [Roaster](https://github.com/eeditiones/roaster) routing layer,
and backed by a mix of XQuery handlers and Java-implemented XQuery functions
for the performance-sensitive paths (cursor store, language analysis).

It is **not** a Language Server Protocol implementation. The `/api/langservice/*`
endpoints return data shapes inspired by LSP types, but the wire protocol is
plain HTTP/JSON, not JSON-RPC. See [#7](https://github.com/eXist-db/existdb-openapi/issues/7)
for the scope discussion.

---

## Quick start

### Install on a running eXist-db 7.0+

1. Download the latest XAR from [Releases](https://github.com/eXist-db/existdb-openapi/releases)
   (or build from source — see below).
2. Drop it into eXist's autodeploy directory (or install via the Dashboard's
   Package Manager). Dependencies:
   - eXist-db 7.0+
   - [Roaster](https://github.com/eeditiones/roaster) ≥ 1.8.0
3. The API is then reachable at `/exist/apps/existdb-openapi/api/*`.

### Smoke test

```bash
# Capability discovery (no auth required)
curl http://localhost:8080/exist/apps/existdb-openapi/api/langservice/capabilities

# Run a query (admin auth)
curl -u admin: \
  -X POST -H "Content-Type: application/json" \
  -d '{"query":"(1, 2, 3, 4, 5)"}' \
  http://localhost:8080/exist/apps/existdb-openapi/api/query

# Returns: { "cursor": "<uuid>", "items": 5, "elapsed": 1, ... }
# Then:
curl -u admin: \
  "http://localhost:8080/exist/apps/existdb-openapi/api/query/<uuid>/results?start=1&count=3"

# Done with the cursor:
curl -u admin: -X DELETE \
  "http://localhost:8080/exist/apps/existdb-openapi/api/query/<uuid>"
```

---

## API surface

The full spec lives in [`modules/api.json`](modules/api.json) (OpenAPI 3.0). A
non-exhaustive index of what's available, grouped by concern:

### Database

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/db` | List collection contents |
| `POST` / `DELETE` | `/api/db/collection` | Create / remove collection |
| `POST` | `/api/db/copy` | Copy resource or collection |
| `POST` | `/api/db/move` | Move resource or collection (with optional rename) |
| `POST` | `/api/db/permissions` | Set permissions |
| `GET` | `/api/db/properties` | Resource / collection properties |
| `GET` / `PUT` / `DELETE` | `/api/db/resource` | Get / store / remove a resource |
| `GET` | `/api/db/sync` | Sync a tree with timestamps |
| `GET` | `/api/modules` | Discover importable XQuery modules |

### Query execution

Two flavors:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/eval` | One-shot: evaluate and return serialized result as text |
| `POST` | `/api/query` | Cursor-based: returns a `{cursor, items, elapsed}` handle |
| `GET` | `/api/query/{id}/results?start=…&count=…` | Fetch a page from an open cursor |
| `POST` | `/api/query/{id}/cancel` | Cancel a running query |
| `DELETE` | `/api/query/{id}` | Close the cursor, release server-side resources |

`/api/eval` is for simple try-it widgets; the `/api/query/…` family is for
paginated UIs (browser-based editors, dashboards). See
[Cursor lifecycle](#cursor-lifecycle) below.

### Language services

For editor / IDE integration — analyze XQuery without running it. Request
bodies take `{expression, …}` plus per-endpoint extras (e.g. `line` / `column`
for positional queries).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/langservice/capabilities` | Feature discovery (which langservice features the server supports) |
| `POST` | `/api/langservice/diagnostics` | Compile-check; structured error list |
| `POST` | `/api/langservice/completions` | Identifier completions in context |
| `POST` | `/api/langservice/hover` | Symbol info at a position |
| `POST` | `/api/langservice/definition` | Go-to-definition target(s) |
| `POST` | `/api/langservice/references` | Find references to a symbol |
| `POST` | `/api/langservice/symbols` | Document symbol outline |

Response shapes are inspired by LSP types (`CompletionItemKind`, `SymbolKind`,
`DiagnosticSeverity` integers are reused) but the transport is plain
HTTP/JSON. Isomorphic-to-LSP shape tightening is tracked in
[#16](https://github.com/eXist-db/existdb-openapi/issues/16).

### Users, groups, packages, search, system

Standard admin surface — see the OpenAPI spec for full operation details.

| Method | Path | Purpose |
|---|---|---|
| `GET` / `POST` | `/api/users` | List / create |
| `GET` / `PUT` / `DELETE` | `/api/users/{name}` | Get / update / remove |
| `GET` | `/api/users/whoami` | Current authenticated user |
| `GET` / `POST` | `/api/groups` | List / create |
| `GET` / `DELETE` | `/api/groups/{name}` | Get / remove |
| `GET` | `/api/packages` | List installed packages |
| `POST` | `/api/packages/install` | Install a XAR |
| `POST` | `/api/packages/update-check` | Check upstream for newer versions |
| `DELETE` | `/api/packages/{name}` | Remove a package |
| `GET` | `/api/search` | Sitewide search (Lucene) |
| `GET` | `/api/site/apps` | List installed apps |
| `GET` | `/api/site/resolve` | Resolve cross-app link |
| `GET` | `/api/system/info` | System info |
| `GET` | `/api/system/scheduler` | Scheduled jobs |
| `POST` | `/api/test` | Run XQSuite tests |

---

## XQuery namespaces

The internal XQuery functions surface two namespaces (these are Java-backed
internal modules, not REST endpoints):

| Prefix | URI | Backed by | What's in it |
|---|---|---|---|
| `lang` | `http://exist-db.org/xquery/langservice` | `org.exist.xquery.modules.openapi.langservice.LangServiceModule` | `lang:diagnostics`, `lang:completions`, `lang:hover`, `lang:definition`, `lang:references`, `lang:symbols` |
| `cursor` | `http://exist-db.org/xquery/cursor` | `org.exist.xquery.modules.openapi.cursor.CursorModule` | `cursor:eval`, `cursor:fetch`, `cursor:close` |

The REST routes in `modules/langservice.xqm` and `modules/query.xqm` are thin
wrappers over these functions.

---

## Cursor lifecycle

The `/api/query/*` family implements server-side cursor pagination. The Java
side holds the result sequence (with live node references), allowing lazy
serialization and per-page document-URI lookup:

```
client                                server
  │                                     │
  │ POST /api/query  { query, … }       │
  │ ───────────────────────────────►   │  cursor:eval → stash result sequence
  │ ◄─── { cursor: "<uuid>", items, elapsed } 
  │                                     │
  │ GET /api/query/<uuid>/results?…    │
  │ ───────────────────────────────►   │  cursor:fetch → serialize requested page
  │ ◄─── [ items… ]                    │
  │                                     │
  │ DELETE /api/query/<uuid>           │
  │ ───────────────────────────────►   │  cursor:close → release the sequence
  │ ◄─── { closed: true }              │
```

Cursors are also released automatically by the cache:

- **Time-based**: 5 min of inactivity by default
- **Count-based**: LRU eviction at 100 concurrent cursors by default
- **Weight-based**: configurable optional memory budget

See [Configuration](#configuration) for tuning.

---

## Sitewide search

`GET /api/search` runs one relevance-ranked Lucene query across every content app
that contributes to a shared `site-content` field, and returns scored hits with
KWIC highlighting (`<mark>` snippets) and facet counts. Site-wide and per-app
search are the same query, with or without a facet filter.

### What a producer must index

To make an app's content searchable, index a **shared field convention** on the
element that represents one search result (typically the document root). In the
app's `collection.xconf`:

```xml
<collection xmlns="http://exist-db.org/collection-config/1.0">
  <index><lucene>
    <text qname="page">
      <field name="site-content" expression="string-join(.//text(), ' ')"/>
      <field name="site-title"   expression="head/title"/>
      <field name="site-url"     expression="..."/>            <!-- see convention below -->
      <facet dimension="site-app"     expression="'myapp'"/>
      <facet dimension="site-section" expression="head/section"/>
    </text>
  </lucene></index>
</collection>
```

| Field / facet | Required | Purpose |
|---|---|---|
| `site-content` (field) | **yes** | the searchable text; what relevance ranks on |
| `site-title` (field) | recommended | the result heading (else `/api/search` falls back to a `<title>` child, then `"(untitled)"`) |
| `site-url` (field) | recommended | the canonical link to the rendered page — see the convention below |
| `site-app` (facet) | recommended | groups results by app (drives the facet drill-down + counts) |
| `site-section` (facet) | optional | a finer category within the app |

The field and facet **names must be identical across all apps** — that is what
lets one query span them. Element names need *not* match: `/api/search` selects
the contributing element with a single-step axis (`collection("/db/apps")/*`),
which is name-independent and — unlike a `//*` descendant wildcard — preserves
`ft:score` for field queries.

### The `site-url` convention

`site-url` is the canonical link a user would follow (or bookmark) to view the
result. Store it as a **root-relative path**:

- **Begin with `/`, and point at the rendered page** — not the `/db/...` storage
  resource. e.g. `/exist/apps/docs/functions/array`,
  `/exist/apps/blog/2015/xquery-3-1`.
- **No scheme, host, or port.** A producer writes `site-url` at index time, when
  it cannot reliably know the instance's external origin — behind a reverse proxy
  or container port-mapping, request introspection (e.g. `request:get-server-port()`)
  reports the wrong value — and a baked absolute URL goes stale the moment the
  content is served from a different origin (dev/staging/prod, a new domain, a
  CDN). A root-relative path is portable across all of them.
- **One rule, every app.** `/api/search` normalizes the value to this shape (it
  roots any app-relative value under `/exist/apps/<app>/`), but producers should
  emit the compliant form directly rather than rely on the safety net.

Consumers compose an absolute URL by prefixing the origin *they* know: a browser
or the Oxygen plugin prepends its own connection origin; server-side code that
genuinely needs an absolute URL — Atom/RSS feeds, sitemaps, email, SEO canonical
tags — prepends a single configured public base URL. Never per-document, never
from request introspection.

### Response shape

```jsonc
{
  "query": "array", "total": 53, "offset": 0, "limit": 20,
  "facets": { "site-app": { "docs": 41, "blog": 8 }, "site-section": { … } },
  "results": [
    {
      "uri":   "/db/apps/docs/data/functions/….xml",  // storage path
      "title": "array:flatten",
      "app":   "docs",
      "url":   "/exist/apps/docs/functions/array",     // root-relative view URL
      "score": 3.42,
      "snippet":    "<span>… the <mark>array</mark> functions …</span>",
      "highlights": [ "<span>…<mark>array</mark>…</span>", … ]
    }
  ]
}
```

`app`/`section` query parameters narrow the result set (facet drill-down). See
the OpenAPI spec (`modules/api.json`) for the full operation contract.

---

## Configuration

`CursorModule` accepts three parameters via `exist.xml` (set on the module
declaration):

| Parameter | Default | Meaning |
|---|---|---|
| `cursor.maximumSize` | `100` | Max concurrent cursors (LRU eviction). `0` = unlimited count. |
| `cursor.expireAfterAccess` | `300000` (5 min) | Inactivity timeout in milliseconds. |
| `cursor.maximumWeight` | `0` (unlimited) | Max estimated total memory in bytes across all cursors. |

### Connection credentials

For local development tooling (the `xst` CLI, gulp-exist, the Cypress test
runner, etc.), this repo supports both conventions used in the eXist-db
ecosystem:

- **`.env` file** — the default for `xst` and `gulp-exist`
- **`.existdb.json` file** — an alternate format also recognized by both tools

Templates are included as `.env.example` and `.existdb.json.example`; pick the
one that matches your tooling.

---

## Build from source

### Requirements

- JDK 21+ (the project uses `--release 21`)
- Maven 3.9+
- Node.js (for the Cypress test suite — optional)

### Build

```bash
mvn package -DskipTests
# → target/existdb-openapi-<version>.xar
```

Install the resulting XAR into eXist via the Dashboard's Package Manager, or
drop it in `autodeploy/`.

### Project layout

```
existdb-openapi/
├── controller.xq                # Top-level URL router (delegates to modules/api.xq)
├── modules/
│   ├── api.json                 # The OpenAPI 3.0 spec — single source of truth
│   ├── api.xq                   # Roaster entry-point; loads api.json and dispatches
│   ├── langservice.xqm          # /api/langservice/* handlers (wraps lang:*)
│   ├── query.xqm                # /api/query, /api/eval handlers (wraps cursor:*)
│   ├── db.xqm, dbutils.xqm      # /api/db/* — collections, resources, sync
│   ├── users.xqm                # /api/users/*, /api/groups/*
│   ├── packages.xqm             # /api/packages/*
│   ├── search.xqm, site.xqm     # search + cross-app linking
│   └── system.xqm               # /api/system/*, /api/test
├── src/main/java/org/exist/xquery/modules/openapi/
│   ├── langservice/             # Java XQuery functions for lang:* (LangServiceModule)
│   └── cursor/                  # Java XQuery functions for cursor:* + CursorStore
├── repo.xml, expath-pkg.xml.tmpl  # EXPath package descriptors
├── xar-assembly.xml             # Maven plugin XAR assembly config
└── pom.xml                      # Maven build
```

The XQuery handlers in `modules/*.xqm` are thin — they validate request bodies
and call into the Java-backed `lang:*` / `cursor:*` functions for the actual
work. The split keeps performance-sensitive paths (parsing, cursor storage,
serialization) in Java while leaving the URL routing in XQuery where it's
easier to evolve.

### Running tests

```bash
# Unit / XQSuite tests (none yet — placeholder)
mvn test

# Cypress browser tests against a running eXist
npm install
npm test
```

---

## Versioning and compatibility

Pre-1.0 releases (`0.9.x`) are **not** API-stable; breaking changes may land
between minor versions as we converge on the 1.0 contract. Once 1.0 ships:

- The OpenAPI surface at `/api/*` becomes the stable contract.
- Breaking changes require a major version bump.
- The shape-tightening work (real `Range` end-positions, hierarchical
  `DocumentSymbol[]`, `MarkupContent` on hover, positional completions) tracked
  in [#16](https://github.com/eXist-db/existdb-openapi/issues/16) is targeted
  for 1.0.

A real LSP wire-protocol transport (JSON-RPC, LSP-over-WebSocket) is
**explicitly out of scope** for 1.0 — a separate process (e.g.,
[existdb-langserver](https://github.com/wolfgangmm/existdb-langserver))
consumes the REST API and translates to LSP for editor clients. See
[#7](https://github.com/eXist-db/existdb-openapi/issues/7).

---

## Consumers

Known clients of this API (each may be in flight or already merged):

- **[eXide](https://github.com/eXist-db/eXide)** (browser-based XQuery IDE) —
  uses `/api/langservice/*` for diagnostics, completions, hover, definition,
  references, and `/api/query/*` for paginated query results.
- **[existdb-langserver](https://github.com/wolfgangmm/existdb-langserver)**
  (VS Code / Atom Language Server Protocol server) — same `/api/langservice/*`
  + `/api/query/*` surface, translated to LSP/JSON-RPC for editor clients.
- **[monex](https://github.com/eXist-db/monex)** (monitoring app) —
  WebSocket-based monitoring + cursor-paginated query console.
- **[notebook](https://github.com/joewiz/notebook)** (Jupyter-style XQuery
  notebook) — completions + hover via `/api/langservice/*`.

---

## Contributing

Issues and pull requests welcome at
[github.com/eXist-db/existdb-openapi](https://github.com/eXist-db/existdb-openapi).

Open issues coordinating the road to 1.0:

- [#2](https://github.com/eXist-db/existdb-openapi/issues/2) — Initial release tracker
- [#7](https://github.com/eXist-db/existdb-openapi/issues/7) — Langservice / LSP scope (closed; superseded by #15/#16/#17)
- [#15](https://github.com/eXist-db/existdb-openapi/issues/15) — `lsp` → `langservice` rename (this PR)
- [#16](https://github.com/eXist-db/existdb-openapi/issues/16) — Tighten REST shapes to LSP 3.17 isomorphism
- [#17](https://github.com/eXist-db/existdb-openapi/issues/17) — `/api/langservice/capabilities` endpoint
- [#13](https://github.com/eXist-db/existdb-openapi/issues/13) — Repo rename (closed; renamed from `exist-api`)

---

## History

This project absorbs and replaces the prior standalone `exist-lsp` package.
The XQuery namespace and URL prefix were originally `lsp` / `/api/lsp/*`; both
were renamed to `langservice` / `lang` (for language-service endpoints) plus a
new `cursor` namespace (for paginated query execution) once it became clear
that this surface is *inspired by* LSP types but does not implement the LSP
wire protocol. The repo itself was renamed from `exist-api` to
`existdb-openapi` to name what it actually is — an OpenAPI-described HTTP
surface — without conflicting with eXist's several other "API" identifiers.
See [`MIGRATION.md`](MIGRATION.md) for the rename details.

---

## License

GNU Lesser General Public License, version 2.1 (or later). See [`LICENSE`](LICENSE).
