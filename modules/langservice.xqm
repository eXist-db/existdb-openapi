(:
 : SPDX LGPL-2.1-or-later
 : Copyright (C) 2026 The eXist-db Authors
 :)
xquery version "3.1";

(:~
 : Language services endpoints.
 : Wraps lang:* Java functions as REST endpoints at /api/langservice/*.
 :)
module namespace langservice="http://exist-db.org/api/langservice";

import module namespace lang="http://exist-db.org/xquery/langservice";

declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";

declare option output:method "json";
declare option output:media-type "application/json";

(:~
 : Compile check — returns diagnostics.
 : POST /api/langservice/diagnostics
 :)
declare function langservice:diagnostics($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression))
        then map { "error": "Missing required field: expression" }
        else if ($module-load-path)
        then lang:diagnostics($expression, $module-load-path)
        else lang:diagnostics($expression)
};

(:~
 : Code completions.
 : POST /api/langservice/completions
 :)
declare function langservice:completions($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression))
        then map { "error": "Missing required field: expression" }
        else if ($module-load-path)
        then lang:completions($expression, $module-load-path)
        else lang:completions($expression)
};

(:~
 : Hover info.
 : POST /api/langservice/hover
 :)
declare function langservice:hover($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $line := $body?line
    let $column := $body?column
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression) or empty($line) or empty($column))
        then map { "error": "Missing required fields: expression, line, column" }
        else if ($module-load-path)
        then lang:hover($expression, $line, $column, $module-load-path)
        else lang:hover($expression, $line, $column)
};

(:~
 : Go to definition.
 : POST /api/langservice/definition
 :)
declare function langservice:definition($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $line := $body?line
    let $column := $body?column
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression) or empty($line) or empty($column))
        then map { "error": "Missing required fields: expression, line, column" }
        else if ($module-load-path)
        then lang:definition($expression, $line, $column, $module-load-path)
        else lang:definition($expression, $line, $column)
};

(:~
 : Find all references.
 : POST /api/langservice/references
 :)
declare function langservice:references($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $line := $body?line
    let $column := $body?column
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression) or empty($line) or empty($column))
        then map { "error": "Missing required fields: expression, line, column" }
        else if ($module-load-path)
        then lang:references($expression, $line, $column, $module-load-path)
        else lang:references($expression, $line, $column)
};

(:~
 : Document symbols.
 : POST /api/langservice/symbols
 :)
declare function langservice:symbols($request as map(*)) {
    let $body := $request?body
    let $expression := $body?expression
    let $module-load-path := $body?module-load-path
    return
        if (empty($expression))
        then map { "error": "Missing required field: expression" }
        else if ($module-load-path)
        then lang:symbols($expression, $module-load-path)
        else lang:symbols($expression)
};

(:~
 : Capability discovery — returns the set of language-service features
 : the running existdb-openapi instance supports. Modeled loosely on LSP's
 : ServerCapabilities, but for the REST surface.
 : GET /api/langservice/capabilities
 :)
declare function langservice:capabilities($request as map(*)) {
    map {
        "diagnostics":  map { "available": true(), "provider": "exist-xquery-parser" },
        "completions":  map { "available": true(), "positional": false() },
        "hover":        map { "available": true(), "markupKinds": [ "plaintext" ] },
        "definition":   map { "available": true(), "multiTarget": false() },
        "references":   map { "available": true(), "includeDeclaration": false() },
        "symbols":      map { "available": true(), "hierarchical": false() },
        "cursor":       map { "available": true() },
        "version":      "0.9.0-SNAPSHOT"
    }
};
