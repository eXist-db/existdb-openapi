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
