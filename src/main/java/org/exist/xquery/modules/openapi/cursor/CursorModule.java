/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.openapi.cursor;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.dom.QName;
import org.exist.xquery.AbstractInternalModule;
import org.exist.xquery.FunctionDef;

import java.util.List;
import java.util.Map;

import static org.exist.xquery.FunctionDSL.functionDefs;

/**
 * XQuery function module exposing server-side cursors for paginated query execution.
 *
 * <p>Registers functions under {@code http://exist-db.org/xquery/cursor}
 * (prefix: {@code cursor}). Provides {@code cursor:eval()} to evaluate an
 * expression into a server-held cursor, {@code cursor:fetch()} to retrieve
 * pages, and {@code cursor:close()} to release.</p>
 *
 * <h3>Cursor store configuration</h3>
 * <p>The cursor store used by these functions can be configured via module
 * parameters in {@code exist.xml}:</p>
 * <ul>
 *   <li>{@code cursor.maximumSize} — max concurrent cursors (default: 100, LRU eviction)</li>
 *   <li>{@code cursor.expireAfterAccess} — inactivity timeout in ms (default: 300000 = 5 min)</li>
 *   <li>{@code cursor.maximumWeight} — max total estimated memory in bytes (default: 0 = unlimited)</li>
 * </ul>
 */
public class CursorModule extends AbstractInternalModule {

    private static final Logger logger = LogManager.getLogger(CursorModule.class);

    public static final String NAMESPACE_URI = "http://exist-db.org/xquery/cursor";
    public static final String PREFIX = "cursor";
    public static final String RELEASE = "0.9.0-SNAPSHOT";

    public static final String PARAM_CURSOR_MAXIMUM_SIZE = "cursor.maximumSize";
    public static final String PARAM_CURSOR_EXPIRE_AFTER_ACCESS = "cursor.expireAfterAccess";
    public static final String PARAM_CURSOR_MAXIMUM_WEIGHT = "cursor.maximumWeight";

    public static final FunctionDef[] functions = functionDefs(
            functionDefs(Eval.class, Eval.FS_EVAL),
            functionDefs(Fetch.class, Fetch.FS_FETCH),
            functionDefs(Close.class, Close.FS_CLOSE)
    );

    public CursorModule(final Map<String, List<?>> parameters) {
        super(functions, parameters);

        final long maxSize = getLongParam(parameters, PARAM_CURSOR_MAXIMUM_SIZE, 100);
        final long expireMs = getLongParam(parameters, PARAM_CURSOR_EXPIRE_AFTER_ACCESS, 300_000);
        final long maxWeight = getLongParam(parameters, PARAM_CURSOR_MAXIMUM_WEIGHT, 0);

        CursorStore.configure(maxSize, expireMs, maxWeight);
        logger.debug("Cursor store: maximumSize={}, expireAfterAccess={}ms, maximumWeight={}",
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
        return "Server-side cursors for paginated XQuery execution";
    }

    @Override
    public String getReleaseVersion() { return RELEASE; }

    static QName qname(final String localPart) {
        return new QName(localPart, NAMESPACE_URI, PREFIX);
    }
}
