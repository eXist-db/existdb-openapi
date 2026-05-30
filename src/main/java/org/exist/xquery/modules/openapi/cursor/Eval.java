/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.openapi.cursor;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.source.Source;
import org.exist.source.StringSource;
import org.exist.storage.XQueryPool;
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

        // Borrow a compiled query for this expression from the shared
        // XQueryPool if one is available; otherwise compile fresh. Same
        // pattern as RESTServer._query — for repeated identical queries
        // this skips the parse+compile+analyse cycle and is typically the
        // largest cost in interactive eXide use.
        //
        // The compiled query (along with its XQueryContext) is then handed
        // off to CursorStore, which holds it until the cursor is closed or
        // evicted and returns it to the pool at that point. The compiled is
        // not returned to the pool at the end of this call because the
        // cursor's stored Sequence holds node references that depend on
        // the context staying unmutated until fetches complete; returning
        // early would let a concurrent borrower mutate it.
        //
        // Fresh XQueryContext (when no pool hit) — see the scope fix in
        // the preceding commit for why copyContext() doesn't work here.
        final XQuery xqueryService = context.getBroker().getBrokerPool().getXQueryService();
        final XQueryPool pool = context.getBroker().getBrokerPool().getXQueryPool();
        final Source source = new StringSource(expr);

        CompiledXQuery compiled = null;
        XQueryContext evalContext = null;
        boolean storedInCursor = false;
        try {
            try {
                compiled = pool.borrowCompiledXQuery(context.getBroker(), source);
            } catch (final org.exist.security.PermissionDeniedException e) {
                throw new XPathException(this, "Permission denied: " + e.getMessage(), e);
            }
            final boolean poolHit = compiled != null;

            long compileTime = 0;
            if (poolHit) {
                evalContext = compiled.getContext();
                evalContext.prepareForReuse();
            } else {
                evalContext = new XQueryContext(context.getBroker().getBrokerPool());
            }
            evalContext.setShared(true);

            if (moduleLoadPath != null) {
                evalContext.setModuleLoadPath(moduleLoadPath);
            }
            // Scope unprefixed path expressions (//foo, collection()) and resolve
            // relative URIs (doc("x.xml")) against the collection derived from
            // moduleLoadPath. Mirrors RESTServer._query.
            final XmldbURI scopeUri = resolveScope(moduleLoadPath);
            evalContext.setStaticallyKnownDocuments(new XmldbURI[]{scopeUri});
            evalContext.setBaseURI(new AnyURIValue(scopeUri.toString()));

            try {
                if (!poolHit) {
                    final long compileStart = System.currentTimeMillis();
                    compiled = xqueryService.compile(evalContext, source);
                    compileTime = System.currentTimeMillis() - compileStart;
                }

                final long evalStart = System.currentTimeMillis();
                final Sequence result = xqueryService.execute(context.getBroker(), compiled, null);
                final long evalTime = System.currentTimeMillis() - evalStart;

                final int itemCount = result.getItemCount();
                final long totalTime = compileTime + evalTime;

                final String cursorId = UUID.randomUUID().toString();
                CursorStore.getInstance().put(cursorId, result, itemCount, evalContext, source, compiled);
                storedInCursor = true;

                logger.debug("cursor:eval cursor={} items={} compile={}ms eval={}ms total={}ms pool={}",
                        cursorId, itemCount, compileTime, evalTime, totalTime,
                        poolHit ? "hit" : "miss");

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
            if (evalContext != null) {
                evalContext.runCleanupTasks();
            }
            throw e;
        } finally {
            // If we own a compiled but didn't transfer ownership to a cursor
            // (i.e. an exception was thrown before put()), return it to the
            // pool so it isn't leaked.
            if (!storedInCursor && compiled != null) {
                pool.returnCompiledXQuery(source, compiled);
            }
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
