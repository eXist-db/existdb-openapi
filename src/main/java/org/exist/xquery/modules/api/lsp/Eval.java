/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.api.lsp;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.source.StringSource;
import org.exist.xquery.BasicFunction;
import org.exist.xquery.CompiledXQuery;
import org.exist.xquery.FunctionSignature;
import org.exist.xquery.XPathException;
import org.exist.xquery.XQuery;
import org.exist.xquery.XQueryContext;
import org.exist.xquery.functions.map.MapType;
import org.exist.xquery.value.IntegerValue;
import org.exist.xquery.value.Sequence;
import org.exist.xquery.value.StringValue;
import org.exist.xquery.value.Type;

import java.util.UUID;

import static org.exist.xquery.FunctionDSL.*;

/**
 * Evaluates an XQuery expression and stores the result in a server-side
 * cursor for paginated retrieval via {@link Fetch}.
 *
 * <p>Returns a map with:</p>
 * <ul>
 *   <li>{@code cursor} — cursor ID for use with {@code lsp:fetch()} and {@code lsp:close()}</li>
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
            Returns a map with keys: cursor (xs:string, cursor ID for lsp:fetch/lsp:close), \
            items (xs:integer, total result count), and elapsed (xs:integer, execution time in ms). \
            The cursor holds live node references and expires after 5 minutes of inactivity.""";

    public static final FunctionSignature[] FS_EVAL = functionSignatures(
            LspModule.qname(FS_EVAL_NAME),
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

        // Copy the parent context to preserve broker, base URI, default collection,
        // and static context — same approach as util:eval() in Eval.doEval()
        final XQuery xqueryService = context.getBroker().getBrokerPool().getXQueryService();
        final XQueryContext evalContext = context.copyContext();
        evalContext.setShared(true);
        try {
            if (moduleLoadPath != null) {
                evalContext.setModuleLoadPath(moduleLoadPath);
            }

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

                logger.debug("lsp:eval cursor={} items={} compile={}ms eval={}ms total={}ms",
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
}
