/*
 * eXist-db Open Source Native XML Database
 * Copyright (C) 2001 The eXist-db Authors
 *
 * info@exist-db.org
 * http://www.exist-db.org
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA
 */
package org.exist.xquery.modules.api.lsp;

import org.exist.dom.QName;
import org.exist.xquery.AbstractInternalModule;
import org.exist.xquery.FunctionDef;

import java.util.List;
import java.util.Map;

import static org.exist.xquery.FunctionDSL.functionDefs;

/**
 * Backward-compatibility module that registers LSP functions under the
 * original {@code http://exist-db.org/xquery/lsp} namespace.
 *
 * <p>This allows existing code (e.g., eXide) that imports {@code lsp:eval},
 * {@code lsp:fetch}, etc. to continue working without changes after
 * migrating from the standalone exist-lsp package to exist-api.</p>
 *
 * <p>All functions delegate to the same implementations used by the
 * {@code api} namespace module.</p>
 */
public class LspModule extends AbstractInternalModule {

    public static final String NAMESPACE_URI = "http://exist-db.org/xquery/lsp";
    public static final String PREFIX = "lsp";
    public static final String RELEASE = "0.9.0-SNAPSHOT";

    public static final FunctionDef[] functions = functionDefs(
            functionDefs(Close.class, Close.FS_CLOSE),
            functionDefs(Completions.class, Completions.FS_COMPLETIONS),
            functionDefs(Definition.class, Definition.FS_DEFINITION),
            functionDefs(Diagnostics.class, Diagnostics.FS_DIAGNOSTICS),
            functionDefs(Eval.class, Eval.FS_EVAL),
            functionDefs(Fetch.class, Fetch.FS_FETCH),
            functionDefs(Hover.class, Hover.FS_HOVER),
            functionDefs(References.class, References.FS_REFERENCES),
            functionDefs(Rename.class, Rename.FS_RENAME),
            functionDefs(SignatureHelp.class, SignatureHelp.FS_SIGNATURE_HELP),
            functionDefs(Symbols.class, Symbols.FS_SYMBOLS)
    );

    public LspModule(final Map<String, List<?>> parameters) {
        super(functions, parameters, true);
    }

    @Override
    public String getNamespaceURI() { return NAMESPACE_URI; }

    @Override
    public String getDefaultPrefix() { return PREFIX; }

    @Override
    public String getDescription() {
        return "Backward-compatible LSP functions (use http://exist-db.org/xquery/api for new code)";
    }

    @Override
    public String getReleaseVersion() { return RELEASE; }

    static QName qname(final String localPart) {
        return new QName(localPart, NAMESPACE_URI, PREFIX);
    }
}
