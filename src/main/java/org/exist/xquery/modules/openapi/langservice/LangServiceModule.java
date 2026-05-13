/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.openapi.langservice;

import org.exist.dom.QName;
import org.exist.xquery.AbstractInternalModule;
import org.exist.xquery.FunctionDef;

import java.util.List;
import java.util.Map;

import static org.exist.xquery.FunctionDSL.functionDefs;

/**
 * XQuery function module providing language-services capabilities for XQuery editors.
 *
 * <p>Registers functions under {@code http://exist-db.org/xquery/langservice}
 * (prefix: {@code lang}). The functions emit data shapes inspired by the
 * Language Server Protocol (LSP) but are consumed over HTTP/JSON, not the
 * LSP wire protocol.</p>
 *
 * <p>Server-side cursor functions for paginated query execution live in
 * {@link org.exist.xquery.modules.openapi.cursor.CursorModule}, not here.</p>
 */
public class LangServiceModule extends AbstractInternalModule {

    public static final String NAMESPACE_URI = "http://exist-db.org/xquery/langservice";
    public static final String PREFIX = "lang";
    public static final String RELEASE = "0.9.0-SNAPSHOT";

    public static final FunctionDef[] functions = functionDefs(
            functionDefs(Completions.class, Completions.FS_COMPLETIONS),
            functionDefs(Definition.class, Definition.FS_DEFINITION),
            functionDefs(Diagnostics.class, Diagnostics.FS_DIAGNOSTICS),
            functionDefs(Hover.class, Hover.FS_HOVER),
            functionDefs(References.class, References.FS_REFERENCES),
            functionDefs(Symbols.class, Symbols.FS_SYMBOLS)
    );

    public LangServiceModule(final Map<String, List<?>> parameters) {
        super(functions, parameters);
    }

    @Override
    public String getNamespaceURI() { return NAMESPACE_URI; }

    @Override
    public String getDefaultPrefix() { return PREFIX; }

    @Override
    public String getDescription() {
        return "Language services for XQuery (diagnostics, completions, hover, definition, references, symbols)";
    }

    @Override
    public String getReleaseVersion() { return RELEASE; }

    static QName qname(final String localPart) {
        return new QName(localPart, NAMESPACE_URI, PREFIX);
    }
}
