/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.api.lsp;

import org.exist.xquery.BasicFunction;
import org.exist.xquery.FunctionSignature;
import org.exist.xquery.XPathException;
import org.exist.xquery.XQueryContext;
import org.exist.xquery.value.BooleanValue;
import org.exist.xquery.value.Sequence;
import org.exist.xquery.value.Type;

import static org.exist.xquery.FunctionDSL.*;

/**
 * Closes a server-side cursor, releasing the held result sequence.
 *
 * <p>Returns {@code true} if the cursor existed and was removed,
 * {@code false} if it had already expired or was not found.</p>
 */
public class Close extends BasicFunction {

    private static final String FS_CLOSE_NAME = "close";
    private static final String FS_CLOSE_DESCRIPTION = """
            Closes a server-side cursor created by lsp:eval(), releasing the held result sequence. \
            Returns true if the cursor was found and removed, false if it had already expired.""";

    public static final FunctionSignature[] FS_CLOSE = functionSignatures(
            LspModule.qname(FS_CLOSE_NAME),
            FS_CLOSE_DESCRIPTION,
            returns(Type.BOOLEAN, "true if cursor was closed, false if not found"),
            arities(
                    arity(
                            param("cursor", Type.STRING, "The cursor ID to close.")
                    )
            )
    );

    public Close(final XQueryContext context, final FunctionSignature signature) {
        super(context, signature);
    }

    @Override
    public Sequence eval(final Sequence[] args, final Sequence contextSequence) throws XPathException {
        final String cursorId = args[0].getStringValue();
        return BooleanValue.valueOf(CursorStore.getInstance().remove(cursorId));
    }
}
