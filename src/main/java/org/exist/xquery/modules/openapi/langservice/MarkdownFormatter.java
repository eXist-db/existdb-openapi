/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.openapi.langservice;

import org.exist.xquery.Cardinality;
import org.exist.xquery.FunctionSignature;
import org.exist.xquery.value.FunctionParameterSequenceType;
import org.exist.xquery.value.FunctionReturnSequenceType;
import org.exist.xquery.value.SequenceType;
import org.exist.xquery.value.Type;

/**
 * Builds Markdown renderings of XQuery function signatures, used by
 * {@link Hover} for the LSP {@code Hover.contents} value and by
 * {@link SignatureHelp} for {@code SignatureInformation.documentation}.
 *
 * <p>Output format for a function:</p>
 * <pre>
 * ```xquery
 * fn:count($arg as item()*) as xs:integer
 * ```
 *
 * Returns the number of items in the input sequence.
 *
 * **Parameters**
 *
 * - `$arg` (`item()*`) — The input sequence
 *
 * **Returns:** `xs:integer`
 * </pre>
 */
final class MarkdownFormatter {

    private MarkdownFormatter() { }

    static String functionMarkdown(final FunctionSignature sig) {
        final StringBuilder md = new StringBuilder(256);
        md.append("```xquery\n").append(signatureLabel(sig)).append("\n```");

        final String description = sig.getDescription();
        if (description != null && !description.isEmpty()) {
            md.append("\n\n").append(description.trim());
        }

        final SequenceType[] argTypes = sig.getArgumentTypes();
        if (argTypes != null && argTypes.length > 0) {
            md.append("\n\n**Parameters**\n");
            for (final SequenceType argType : argTypes) {
                md.append("\n- ").append(parameterListItem(argType));
            }
        }

        final SequenceType ret = sig.getReturnType();
        if (ret != null) {
            md.append("\n\n**Returns:** `").append(formatType(ret)).append("`");
            if (ret instanceof final FunctionReturnSequenceType retDoc) {
                final String desc = retDoc.getDescription();
                if (desc != null && !desc.isEmpty()) {
                    md.append(" — ").append(desc.trim());
                }
            }
        }
        return md.toString();
    }

    /**
     * One-line signature suitable for the LSP {@code SignatureInformation.label}
     * field — same format the underlying signature renders as via toString().
     */
    static String signatureLabel(final FunctionSignature sig) {
        return sig.toString();
    }

    private static String parameterListItem(final SequenceType argType) {
        final StringBuilder sb = new StringBuilder();
        final String name = (argType instanceof final FunctionParameterSequenceType p)
                ? p.getAttributeName() : null;
        sb.append("`$").append(name != null ? name : "arg").append("` (`").append(formatType(argType)).append("`)");
        if (argType instanceof final FunctionParameterSequenceType p) {
            final String desc = p.getDescription();
            if (desc != null && !desc.isEmpty()) {
                sb.append(" — ").append(desc.trim());
            }
        }
        return sb.toString();
    }

    /**
     * Type label including cardinality marker (?, *, +). Mirrors what {@code
     * FunctionSignature.toString()} produces for individual params.
     *
     * <p>Cardinality {@code EMPTY_SEQUENCE} is special: its
     * {@code toXQueryCardinalityString()} returns the literal
     * {@code "empty-sequence()"} (not a postfix marker), so naively
     * concatenating it onto the primary type name produces nonsense like
     * {@code "item()empty-sequence()"}. In that case we use the cardinality
     * string standalone.</p>
     */
    static String formatType(final SequenceType type) {
        final Cardinality card = type.getCardinality();
        if (card == Cardinality.EMPTY_SEQUENCE) {
            return "empty-sequence()";
        }
        final String name = Type.getTypeName(type.getPrimaryType());
        return name + (card != null ? card.toXQueryCardinalityString() : "");
    }

    /**
     * Parameter label for {@code ParameterInformation.label} in LSP
     * SignatureHelp — e.g. {@code "$arg as item()*"} — designed to match a
     * substring of {@link #signatureLabel(FunctionSignature)}.
     */
    static String parameterLabel(final SequenceType argType) {
        final String name = (argType instanceof final FunctionParameterSequenceType p)
                ? p.getAttributeName() : "arg";
        return "$" + name + " as " + formatType(argType);
    }

    /**
     * Markdown for an individual parameter — used as
     * {@code ParameterInformation.documentation.value}.
     */
    static String parameterMarkdown(final SequenceType argType) {
        final StringBuilder md = new StringBuilder();
        md.append("`").append(parameterLabel(argType)).append("`");
        if (argType instanceof final FunctionParameterSequenceType p) {
            final String desc = p.getDescription();
            if (desc != null && !desc.isEmpty()) {
                md.append("\n\n").append(desc.trim());
            }
        }
        return md.toString();
    }
}
