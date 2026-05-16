# Migration: `lsp` → `langservice` + `cursor`, repo `exist-api` → `existdb-openapi` (pre-1.0.0)

This document describes the breaking renames landed in the PR closing issues #7, #13, #15, and #17. It applies to consumers that integrated against pre-release versions of this project (formerly `exist-api`, with the `lsp:` namespace inherited from `exist-lsp`).

This file will be removed once all known consumers (eXide, monex, existdb-langserver, notebook) have been updated. If you reach this section after that point, the names below are settled.

## Why

The previous `lsp:` namespace and `/api/lsp/*` URL prefix were inherited from the migrated `exist-lsp` standalone package. They implied that this project speaks the Language Server Protocol — it does not. The project is an HTTP/JSON backend whose data shapes are *inspired by* LSP types but consumed via REST, not JSON-RPC. See issue #7 for the full discussion.

The repo itself was also renamed from `exist-api` to `existdb-openapi` to match what the project actually is — an OpenAPI-described HTTP surface, distinct from RESTXQ, the legacy REST Server, and XML:DB. See issue #13.

The rename also splits server-side cursor functions (`eval` / `fetch` / `close`) out of the language-services namespace, since they are query-execution primitives, not language services.

## What changed

### URL paths

| Before | After |
|---|---|
| `POST /api/lsp/diagnostics` | `POST /api/langservice/diagnostics` |
| `POST /api/lsp/completions` | `POST /api/langservice/completions` |
| `POST /api/lsp/hover` | `POST /api/langservice/hover` |
| `POST /api/lsp/definition` | `POST /api/langservice/definition` |
| `POST /api/lsp/references` | `POST /api/langservice/references` |
| `POST /api/lsp/symbols` | `POST /api/langservice/symbols` |
| — | `GET /api/langservice/capabilities` *(new)* |

`POST /api/eval`, `GET /api/query/{id}/results`, `DELETE /api/query/{id}` are unchanged externally. Internally they now delegate to `cursor:eval` / `cursor:fetch` / `cursor:close` instead of `lsp:eval` / `lsp:fetch` / `lsp:close`.

### XQuery namespaces

| Before | After |
|---|---|
| `http://exist-db.org/xquery/lsp` (prefix `lsp`) | `http://exist-db.org/xquery/langservice` (prefix `lang`) for language-service functions |
| — | `http://exist-db.org/xquery/cursor` (prefix `cursor`) *(new)* for cursor functions |
| `http://exist-db.org/xquery/api` (prefix `api`, empty module) | removed |

Function renames:

| Before | After |
|---|---|
| `lsp:diagnostics()` | `lang:diagnostics()` |
| `lsp:completions()` | `lang:completions()` |
| `lsp:hover()` | `lang:hover()` |
| `lsp:definition()` | `lang:definition()` |
| `lsp:references()` | `lang:references()` |
| `lsp:symbols()` | `lang:symbols()` |
| `lsp:eval()` | `cursor:eval()` |
| `lsp:fetch()` | `cursor:fetch()` |
| `lsp:close()` | `cursor:close()` |

### Java packages

| Before | After |
|---|---|
| `org.exist.xquery.modules.api.ApiModule` | removed |
| `org.exist.xquery.modules.api.lsp.LspModule` | `org.exist.xquery.modules.openapi.langservice.LangServiceModule` |
| `org.exist.xquery.modules.api.lsp.{Completions,Definition,Diagnostics,Hover,References,Symbols}` | `org.exist.xquery.modules.openapi.langservice.{...}` |
| `org.exist.xquery.modules.api.lsp.{Eval,Fetch,Close,CursorStore}` | `org.exist.xquery.modules.openapi.cursor.{...}` |
| — | `org.exist.xquery.modules.openapi.cursor.CursorModule` *(new)* |

`CursorModule` takes over the cursor store configuration role that previously lived in the (now-removed) `ApiModule`. The configuration parameter names (`cursor.maximumSize`, `cursor.expireAfterAccess`, `cursor.maximumWeight`) are unchanged.

### No backward-compatibility aliases

None of the previous names are kept as aliases. All four known consumers — eXide, existdb-langserver, monex, notebook — are pre-release and updated in lockstep with this change.

## Repo / package coordinates

| Coordinate | Before | After |
|---|---|---|
| GitHub repo | `eXist-db/exist-api` | `eXist-db/existdb-openapi` |
| Maven `artifactId` | `exist-api` | `existdb-openapi` |
| XAR `target` / `package-abbrev` | `exist-api` | `existdb-openapi` |
| EXPath `package-name` URI | `http://exist-db.org/pkg/api` | `http://exist-db.org/pkg/openapi` |

GitHub auto-redirects the old repo URL.

## What did NOT change

- The `/api/*` URL prefix and the OpenAPI surface as a whole.
- HTTP request/response *shapes* for the language-service endpoints. Those will be tightened to LSP-isomorphic shapes in a follow-up PR (issue #16) — separate from this rename.
