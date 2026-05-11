(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Language services endpoints.
 : Wraps LSP Java functions as REST endpoints.
 :)
module namespace lspapi="http://exist-db.org/api/lsp";

import module namespace lsp="http://exist-db.org/xquery/lsp";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : Compile check — returns diagnostics.
 : POST /api/lsp/diagnostics
 :)
declare function lspapi:diagnostics($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression))
        then map { "error": "Missing required field: expression" }
        else if ($module-load-path)
        then lsp:diagnostics($expression, $module-load-path)
        else lsp:diagnostics($expression)
};

(:~
 : Code completions.
 : POST /api/lsp/completions
 :)
declare function lspapi:completions($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression))
        then map { "error": "Missing required field: expression" }
        else if ($module-load-path)
        then lsp:completions($expression, $module-load-path)
        else lsp:completions($expression)
};

(:~
 : Hover info.
 : POST /api/lsp/hover
 :)
declare function lspapi:hover($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $line := $body?line
    let $column := $body?column
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression) or empty($line) or empty($column))
        then map { "error": "Missing required fields: expression, line, column" }
        else if ($module-load-path)
        then lsp:hover($expression, $line, $column, $module-load-path)
        else lsp:hover($expression, $line, $column)
};

(:~
 : Go to definition.
 : POST /api/lsp/definition
 :)
declare function lspapi:definition($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $line := $body?line
    let $column := $body?column
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression) or empty($line) or empty($column))
        then map { "error": "Missing required fields: expression, line, column" }
        else if ($module-load-path)
        then lsp:definition($expression, $line, $column, $module-load-path)
        else lsp:definition($expression, $line, $column)
};

(:~
 : Find all references.
 : POST /api/lsp/references
 :)
declare function lspapi:references($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $line := $body?line
    let $column := $body?column
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression) or empty($line) or empty($column))
        then map { "error": "Missing required fields: expression, line, column" }
        else if ($module-load-path)
        then lsp:references($expression, $line, $column, $module-load-path)
        else lsp:references($expression, $line, $column)
};

(:~
 : Document symbols.
 : POST /api/lsp/symbols
 :)
declare function lspapi:symbols($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression))
        then map { "error": "Missing required field: expression" }
        else if ($module-load-path)
        then lsp:symbols($expression, $module-load-path)
        else lsp:symbols($expression)
};
