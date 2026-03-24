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
package org.exist.xquery.modules.api;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.dom.QName;
import org.exist.xquery.AbstractInternalModule;
import org.exist.xquery.FunctionDef;
import org.exist.xquery.modules.api.lsp.CursorStore;

import java.util.List;
import java.util.Map;

import static org.exist.xquery.FunctionDSL.functionDefs;

/**
 * XQuery function module providing the unified eXist-db Platform API.
 *
 * <p>Registers functions under {@code http://exist-db.org/xquery/api} (prefix: {@code api}).
 * Currently configures the shared cursor store; new API-namespaced functions will be
 * added in future versions.</p>
 *
 * <p>LSP functions remain available under the original {@code http://exist-db.org/xquery/lsp}
 * namespace via the companion {@link org.exist.xquery.modules.api.lsp.LspModule}.</p>
 *
 * <h3>Cursor store configuration</h3>
 * <p>The cursor store used by {@code api:eval}/{@code api:fetch} can be configured
 * via module parameters in {@code exist.xml}:</p>
 * <ul>
 *   <li>{@code cursor.maximumSize} — max concurrent cursors (default: 100, LRU eviction)</li>
 *   <li>{@code cursor.expireAfterAccess} — inactivity timeout in ms (default: 300000 = 5 min)</li>
 *   <li>{@code cursor.maximumWeight} — max total estimated memory in bytes (default: 0 = unlimited)</li>
 * </ul>
 */
public class ApiModule extends AbstractInternalModule {

    private static final Logger logger = LogManager.getLogger(ApiModule.class);

    public static final String NAMESPACE_URI = "http://exist-db.org/xquery/api";
    public static final String PREFIX = "api";
    public static final String RELEASE = "0.9.0-SNAPSHOT";

    public static final String PARAM_CURSOR_MAXIMUM_SIZE = "cursor.maximumSize";
    public static final String PARAM_CURSOR_EXPIRE_AFTER_ACCESS = "cursor.expireAfterAccess";
    public static final String PARAM_CURSOR_MAXIMUM_WEIGHT = "cursor.maximumWeight";

    // No functions registered yet — LSP functions use the lsp namespace.
    // Future platform API functions will be added here.
    public static final FunctionDef[] functions = functionDefs();

    public ApiModule(final Map<String, List<?>> parameters) {
        super(functions, parameters, true);

        final long maxSize = getLongParam(parameters, PARAM_CURSOR_MAXIMUM_SIZE, 100);
        final long expireMs = getLongParam(parameters, PARAM_CURSOR_EXPIRE_AFTER_ACCESS, 300_000);
        final long maxWeight = getLongParam(parameters, PARAM_CURSOR_MAXIMUM_WEIGHT, 0);

        CursorStore.configure(maxSize, expireMs, maxWeight);
        logger.info("API cursor store: maximumSize={}, expireAfterAccess={}ms, maximumWeight={}",
                maxSize, expireMs, maxWeight > 0 ? maxWeight : "unlimited");
    }

    private static long getLongParam(final Map<String, List<?>> parameters,
                                      final String name, final long defaultValue) {
        if (parameters == null) return defaultValue;
        final List<?> values = parameters.get(name);
        if (values == null || values.isEmpty()) return defaultValue;
        try {
            return Long.parseLong(values.get(0).toString());
        } catch (final NumberFormatException e) {
            return defaultValue;
        }
    }

    @Override
    public String getNamespaceURI() { return NAMESPACE_URI; }

    @Override
    public String getDefaultPrefix() { return PREFIX; }

    @Override
    public String getDescription() {
        return "Unified platform API for eXist-db";
    }

    @Override
    public String getReleaseVersion() { return RELEASE; }

    static QName qname(final String localPart) {
        return new QName(localPart, NAMESPACE_URI, PREFIX);
    }
}
