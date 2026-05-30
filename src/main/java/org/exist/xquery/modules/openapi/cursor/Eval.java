/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.openapi.cursor;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.source.StringSource;
import org.exist.xmldb.XmldbURI;
import org.exist.xquery.BasicFunction;
import org.exist.xquery.CompiledXQuery;
import org.exist.xquery.FunctionSignature;
import org.exist.xquery.XPathException;
import org.exist.xquery.XQuery;
import org.exist.xquery.XQueryContext;
import org.exist.xquery.functions.map.MapType;
import org.exist.xquery.value.AnyURIValue;
import org.exist.xquery.value.IntegerValue;
import org.exist.xquery.value.Sequence;
import org.exist.xquery.value.StringValue;
import org.exist.xquery.value.Type;

import java.net.URISyntaxException;
import java.util.UUID;

import static org.exist.xquery.FunctionDSL.*;

/**
 * Evaluates an XQuery expression and stores the result in a server-side
 * cursor for paginated retrieval via {@link Fetch}.
 *
 * <p>Returns a map with:</p>
 * <ul>
 *   <li>{@code cursor} — cursor ID for use with {@code cursor:fetch()} and {@code cursor:close()}</li>
 *   <li>{@code items} — total number of items in the result sequence</li>
 *   <li>{@code elapsed} — execution time in milliseconds</li>
 * </ul>
 *
 * <p>The result sequence is held in memory with live node references intact,
 * enabling lazy serialization and document-URI lookup on fetch. Cursors
 * expire after 5 minutes of inactivity.</p>
 */
public class Eval extends BasicFunction {

    private static final Logger logger = LogManager.getLogger(Eval.class);

    private static final String FS_EVAL_NAME = "eval";
    private static final String FS_EVAL_DESCRIPTION = """
            Evaluates an XQuery expression and stores the result in a server-side cursor. \
            Returns a map with keys: cursor (xs:string, cursor ID for cursor:fetch/cursor:close), \
            items (xs:integer, total result count), and elapsed (xs:integer, execution time in ms). \
            The cursor holds live node references and expires after 5 minutes of inactivity.""";

    public static final FunctionSignature[] FS_EVAL = functionSignatures(
            CursorModule.qname(FS_EVAL_NAME),
            FS_EVAL_DESCRIPTION,
            returns(Type.MAP_ITEM, "a map with cursor ID, item count, and elapsed time"),
            arities(
                    arity(
                            param("expression", Type.STRING, "The XQuery expression to evaluate.")
                    ),
                    arity(
                            param("expression", Type.STRING, "The XQuery expression to evaluate."),
                            optParam("module-load-path", Type.STRING, """
                                    The module load path. \
                                    Imports will be resolved relative to this. \
                                    Use xmldb:exist:///db or /db for database-stored modules.""")
                    )
            )
    );

    public Eval(final XQueryContext context, final FunctionSignature signature) {
        super(context, signature);
    }

    @Override
    public Sequence eval(final Sequence[] args, final Sequence contextSequence) throws XPathException {
        final String expr = args[0].getStringValue();

        final String moduleLoadPath;
        if (getArgumentCount() == 2 && args[1].hasOne()) {
            moduleLoadPath = args[1].getStringValue();
        } else {
            moduleLoadPath = null;
        }

        // Use a fresh XQueryContext (like RESTServer._query) rather than
        // copyContext(). copyContext() inherits the parent's cached
        // staticDocuments — for a caller in /db/apps/existdb-openapi the
        // optimizer ends up walking that collection regardless of what
        // staticallyKnownDocuments we set here. A fresh context cleanly
        // takes whatever scope we declare below.
        final XQuery xqueryService = context.getBroker().getBrokerPool().getXQueryService();
        final XQueryContext evalContext = new XQueryContext(context.getBroker().getBrokerPool());
        evalContext.setShared(true);
        try {
            if (moduleLoadPath != null) {
                evalContext.setModuleLoadPath(moduleLoadPath);
            }

            // Scope unprefixed path expressions (//foo, collection()) and resolve
            // relative URIs (doc("x.xml")) against the collection derived from
            // moduleLoadPath. Mirrors RESTServer._query, which sets these from
            // the request URL; without them, `//p` walks nothing.
            final XmldbURI scopeUri = resolveScope(moduleLoadPath);
            evalContext.setStaticallyKnownDocuments(new XmldbURI[]{scopeUri});
            evalContext.setBaseURI(new AnyURIValue(scopeUri.toString()));

            final CompiledXQuery compiled;
            final Sequence result;
            try {
                // Phase 1: Compile (parse + compile + analyze)
                final long compileStart = System.currentTimeMillis();
                compiled = xqueryService.compile(evalContext, new StringSource(expr));
                final long compileTime = System.currentTimeMillis() - compileStart;

                // Phase 2: Evaluate
                final long evalStart = System.currentTimeMillis();
                result = xqueryService.execute(context.getBroker(), compiled, null);
                final long evalTime = System.currentTimeMillis() - evalStart;

                final int itemCount = result.getItemCount();
                final long totalTime = compileTime + evalTime;

                // Store in cursor — evalContext is kept alive so node references remain valid.
                // Cleanup happens when the cursor is evicted or explicitly closed.
                final String cursorId = UUID.randomUUID().toString();
                CursorStore.getInstance().put(cursorId, result, itemCount, evalContext);

                logger.debug("cursor:eval cursor={} items={} compile={}ms eval={}ms total={}ms",
                        cursorId, itemCount, compileTime, evalTime, totalTime);

                // Return metadata with timing breakdown
                final MapType resultMap = new MapType(this, context);
                resultMap.add(new StringValue(this, "cursor"), new StringValue(this, cursorId));
                resultMap.add(new StringValue(this, "items"), new IntegerValue(this, itemCount));
                resultMap.add(new StringValue(this, "elapsed"), new IntegerValue(this, totalTime));

                final MapType timingMap = new MapType(this, context);
                timingMap.add(new StringValue(this, "compile"), new IntegerValue(this, compileTime));
                timingMap.add(new StringValue(this, "evaluate"), new IntegerValue(this, evalTime));
                timingMap.add(new StringValue(this, "total"), new IntegerValue(this, totalTime));
                resultMap.add(new StringValue(this, "timing"), timingMap);

                return resultMap;

            } catch (final java.io.IOException e) {
                throw new XPathException(this, "Failed to compile query: " + e.getMessage(), e);
            } catch (final org.exist.security.PermissionDeniedException e) {
                throw new XPathException(this, "Permission denied: " + e.getMessage(), e);
            }

        } catch (final XPathException e) {
            // Compilation/evaluation failed — clean up immediately
            evalContext.runCleanupTasks();
            throw e;
        }
    }

    /**
     * Derive a collection URI from {@code moduleLoadPath} for use with
     * {@link XQueryContext#setStaticallyKnownDocuments} and
     * {@link XQueryContext#setBaseURI}.
     *
     * <ul>
     *   <li>{@code xmldb:exist:///db/apps/foo} → {@code /db/apps/foo}</li>
     *   <li>{@code /db/apps/foo} → {@code /db/apps/foo}</li>
     *   <li>{@code null}, {@code "."}, or non-xmldb (file:, http:) → {@code /db}</li>
     * </ul>
     *
     * Defaulting to {@code /db} when no usable path is given matches the
     * behaviour of {@code /exist/rest/db} (the REST root) — `//p` walks the
     * whole database rather than silently returning nothing.
     */
    private static XmldbURI resolveScope(final String moduleLoadPath) {
        if (moduleLoadPath == null || moduleLoadPath.isEmpty() || ".".equals(moduleLoadPath)) {
            return XmldbURI.ROOT_COLLECTION_URI;
        }
        if (moduleLoadPath.startsWith(XmldbURI.XMLDB_URI_PREFIX)) {
            try {
                return XmldbURI.xmldbUriFor(moduleLoadPath, false).toCollectionPathURI();
            } catch (final URISyntaxException e) {
                return XmldbURI.ROOT_COLLECTION_URI;
            }
        }
        if (moduleLoadPath.startsWith("/")) {
            return XmldbURI.create(moduleLoadPath);
        }
        return XmldbURI.ROOT_COLLECTION_URI;
    }
}
