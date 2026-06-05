/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.openapi.langservice;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.dom.QName;
import org.exist.xquery.BasicFunction;
import org.exist.xquery.FunctionSignature;
import org.exist.xquery.Module;
import org.exist.xquery.UserDefinedFunction;
import org.exist.xquery.XPathException;
import org.exist.xquery.XQueryContext;
import org.exist.xquery.functions.array.ArrayType;
import org.exist.xquery.functions.map.MapType;
import org.exist.xquery.value.IntegerValue;
import org.exist.xquery.value.Sequence;
import org.exist.xquery.value.SequenceType;
import org.exist.xquery.value.StringValue;
import org.exist.xquery.value.Type;

import static org.exist.xquery.FunctionDSL.*;

/**
 * Returns parameter-level help for the function call surrounding the cursor,
 * shaped like LSP's {@code textDocument/signatureHelp} response:
 *
 * <pre>
 * SignatureHelp {
 *   signatures: SignatureInformation[],
 *   activeSignature?: integer,
 *   activeParameter?: integer
 * }
 * SignatureInformation {
 *   label: string,
 *   documentation: MarkupContent { kind: "markdown", value: string },
 *   parameters: ParameterInformation[]
 * }
 * ParameterInformation {
 *   label: string,
 *   documentation: MarkupContent { kind: "markdown", value: string }
 * }
 * </pre>
 *
 * <p>The lookup is <strong>name-based and lenient about incomplete syntax</strong>
 * — mid-typing states like {@code util:log(}, {@code util:log("info",}, or
 * {@code util:log("info", "msg", } are all valid inputs and produce help.
 * Internally:</p>
 *
 * <ol>
 *   <li>Scan the raw text forward from the start of the expression to the
 *       cursor, maintaining a stack of unmatched open parens (skipping string
 *       literals). The top of the stack is the open paren of the enclosing
 *       call.</li>
 *   <li>Walk left from that open paren over whitespace and capture the
 *       function name (optionally prefixed: {@code prefix:local}).</li>
 *   <li>Resolve the prefix to a namespace URI via the XQuery context's
 *       in-scope namespaces. {@code prefix}-less names resolve in the default
 *       function namespace (fn).</li>
 *   <li>Collect all loaded signatures with that QName (same approach as
 *       {@link Completions} — walk every module whose namespaceURI matches,
 *       plus user-declared local functions), sorted by arity ascending.</li>
 *   <li>Compute {@code activeParameter} by counting top-level commas between
 *       the open paren and the cursor (string-literal-aware).</li>
 *   <li>Pick {@code activeSignature}: the smallest-arity overload whose arity
 *       is at least {@code activeParameter + 1}; falls back to the
 *       largest-arity overload if no overload has enough parameters.</li>
 * </ol>
 *
 * <p>Returns an empty sequence if the cursor is not inside any open paren,
 * or if the name walking back from the paren doesn't resolve to any known
 * function.</p>
 */
public class SignatureHelp extends BasicFunction {

    private static final Logger logger = LogManager.getLogger(SignatureHelp.class);

    private static final String FS_SIGNATURE_HELP_NAME = "signature-help";
    private static final String FS_SIGNATURE_HELP_DESCRIPTION = """
            Returns LSP-shaped SignatureHelp for the function call surrounding \
            the cursor. Name-based and lenient: mid-typing states like \
            "util:log(", "util:log(\\"info\\",", and "util:log(\\"info\\", \\"x\\", " \
            all produce help, since resolution is by function name (scanned \
            from the raw text), not by requiring the partial call to parse. \
            Returns a map with keys signatures (array of SignatureInformation \
            { label, documentation, parameters }), activeSignature (xs:integer, \
            index into signatures), and activeParameter (xs:integer, 0-based \
            index of the parameter the cursor is on, computed by counting \
            commas at the call's paren depth). Returns an empty sequence if \
            the cursor is not inside a function call's argument list.""";

    public static final FunctionSignature[] FS_SIGNATURE_HELP = functionSignatures(
            LangServiceModule.qname(FS_SIGNATURE_HELP_NAME),
            FS_SIGNATURE_HELP_DESCRIPTION,
            returns(Type.MAP_ITEM, "a SignatureHelp map, or empty sequence"),
            arities(
                    arity(
                            param("expression", Type.STRING, "The XQuery expression."),
                            param("line", Type.INTEGER, "0-based line number."),
                            param("column", Type.INTEGER, "0-based column number.")
                    ),
                    arity(
                            param("expression", Type.STRING, "The XQuery expression."),
                            param("line", Type.INTEGER, "0-based line number."),
                            param("column", Type.INTEGER, "0-based column number."),
                            optParam("module-load-path", Type.STRING, "The module load path.")
                    )
            )
    );

    /** What the raw-text scan extracts for an enclosing function call. */
    private record EnclosingCall(String prefix, String localPart, int openParenOffset) { }

    public SignatureHelp(final XQueryContext context, final FunctionSignature signature) {
        super(context, signature);
    }

    @Override
    public Sequence eval(final Sequence[] args, final Sequence contextSequence) throws XPathException {
        final String expr = args[0].getStringValue();
        final int line0 = ((IntegerValue) args[1].itemAt(0)).getInt();
        final int col0 = ((IntegerValue) args[2].itemAt(0)).getInt();

        if (expr.isEmpty()) {
            return Sequence.EMPTY_SEQUENCE;
        }
        final int cursorOffset = lineColumnToOffset(expr, line0, col0);
        if (cursorOffset < 0) {
            return Sequence.EMPTY_SEQUENCE;
        }

        final EnclosingCall enc = findEnclosingCall(expr, cursorOffset);
        if (enc == null) {
            return Sequence.EMPTY_SEQUENCE;
        }

        final XQueryContext pContext = new XQueryContext(context.getBroker().getBrokerPool());
        try {
            if (getArgumentCount() == 4 && args[3].hasOne()) {
                pContext.setModuleLoadPath(args[3].getStringValue());
            }

            final QName qname = resolveQName(pContext, enc.prefix(), enc.localPart());
            if (qname == null) {
                return Sequence.EMPTY_SEQUENCE;
            }

            final List<FunctionSignature> overloads = collectOverloads(pContext, qname);
            if (overloads.isEmpty()) {
                return Sequence.EMPTY_SEQUENCE;
            }

            final int beforeCursor = countTopLevelCommas(expr, enc.openParenOffset() + 1, cursorOffset);
            // Also scan forward past the cursor to the call's matching close
            // paren (or end-of-input). Total commas in the call → intended
            // arity, used to pick the activeSignature overload. This matters
            // for cases like `substring("abc", 2, 1)` with the cursor *on* the
            // 2: commas-before-cursor alone would pick the #2 overload, but
            // the user clearly intends #3.
            final int afterCursor = countTopLevelCommas(expr, cursorOffset, expr.length());
            final int intendedArity = beforeCursor + afterCursor + 1;
            return buildSignatureHelp(overloads, beforeCursor, intendedArity);
        } catch (final Exception e) {
            logger.debug("Error during signature-help lookup: {}", e.getMessage());
        } finally {
            pContext.runCleanupTasks();
        }
        return Sequence.EMPTY_SEQUENCE;
    }

    /**
     * Forward-scan from the start of the expression to the cursor, maintaining
     * a stack of unmatched open-paren offsets. The top of the stack is the
     * open paren of the call we're inside. Then walk left over whitespace and
     * an NCName (possibly prefixed) to extract the function name.
     *
     * @return the enclosing call, or {@code null} if the cursor isn't inside
     *         a function-call argument list (no enclosing paren, or the
     *         characters before the paren don't form a function name).
     */
    private static EnclosingCall findEnclosingCall(final String expr, final int cursorOffset) {
        final int openParen = findEnclosingOpenParen(expr, cursorOffset);
        if (openParen < 0) {
            return null;
        }
        return extractFunctionNameBefore(expr, openParen);
    }

    private static int findEnclosingOpenParen(final String expr, final int cursorOffset) {
        final java.util.ArrayDeque<Integer> parenStack = new java.util.ArrayDeque<>();
        final int end = Math.min(cursorOffset, expr.length());
        int i = 0;
        while (i < end) {
            final char c = expr.charAt(i);
            if (c == '"' || c == '\'') {
                final int after = skipString(expr, i, c);
                i = after < 0 ? end : after + 1;
                continue;
            }
            if (c == '(') {
                parenStack.push(i);
            } else if (c == ')' && !parenStack.isEmpty()) {
                parenStack.pop();
            }
            i++;
        }
        return parenStack.isEmpty() ? -1 : parenStack.peek();
    }

    private static EnclosingCall extractFunctionNameBefore(final String expr, final int openParen) {
        final int nameEnd = skipWhitespaceLeft(expr, openParen - 1);
        if (nameEnd < 0) {
            return null;
        }
        final int nameStart = skipNCNameLeft(expr, nameEnd);
        if (nameStart > nameEnd) {
            return null;
        }
        final String localPart = expr.substring(nameStart, nameEnd + 1);
        final String prefix = extractPrefixBefore(expr, nameStart);
        return new EnclosingCall(prefix, localPart, openParen);
    }

    private static int skipWhitespaceLeft(final String expr, final int from) {
        int i = from;
        while (i >= 0 && Character.isWhitespace(expr.charAt(i))) {
            i--;
        }
        return i;
    }

    private static int skipNCNameLeft(final String expr, final int from) {
        int i = from;
        while (i > 0 && isNCNameChar(expr.charAt(i - 1))) {
            i--;
        }
        return i;
    }

    /**
     * If position {@code nameStart - 1} is a colon, walk further left over
     * NCName chars and return that prefix. Otherwise return empty string.
     */
    private static String extractPrefixBefore(final String expr, final int nameStart) {
        if (nameStart <= 0 || expr.charAt(nameStart - 1) != ':') {
            return "";
        }
        final int prefixEnd = nameStart - 1;
        final int prefixStart = skipNCNameLeft(expr, prefixEnd);
        return prefixStart < prefixEnd ? expr.substring(prefixStart, prefixEnd) : "";
    }

    private static boolean isNCNameChar(final char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
                || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
    }

    /**
     * Build a QName for the function being called. If a prefix is present,
     * resolve it via the in-scope namespaces of a fresh XQuery context (which
     * has the standard built-in prefixes bound: fn, xs, util, xmldb, map,
     * array, math, etc.). For unprefixed names, use the default function
     * namespace (fn).
     */
    private static QName resolveQName(final XQueryContext pContext,
            final String prefix, final String localPart) {
        if (localPart == null || localPart.isEmpty()) {
            return null;
        }
        final String uri = prefix == null || prefix.isEmpty()
                ? pContext.getDefaultFunctionNamespace()
                : pContext.getURIForPrefix(prefix);
        if (uri == null || uri.isEmpty()) {
            return null;
        }
        return new QName(localPart, uri, prefix == null ? "" : prefix);
    }

    /**
     * Collect all overloads of the given QName — same name+namespace, any
     * arity — sorted by arity ascending.
     *
     * <p>Searches the module matching the namespace and {@link
     * XQueryContext#localFunctions()} for user-declared overloads.</p>
     */
    private static List<FunctionSignature> collectOverloads(final XQueryContext pContext,
            final QName target) {
        final List<FunctionSignature> overloads = new ArrayList<>();
        final boolean[] seenArity = new boolean[256];

        final Iterator<Module> modules = pContext.getAllModules();
        while (modules.hasNext()) {
            final Module module = modules.next();
            if (!target.getNamespaceURI().equals(module.getNamespaceURI())) {
                continue;
            }
            for (final FunctionSignature s : module.listFunctions()) {
                if (!s.isPrivate() && target.equals(s.getName())) {
                    addUnique(overloads, seenArity, s);
                }
            }
        }

        final Iterator<UserDefinedFunction> userFns = pContext.localFunctions();
        while (userFns.hasNext()) {
            final FunctionSignature s = userFns.next().getSignature();
            if (target.equals(s.getName())) {
                addUnique(overloads, seenArity, s);
            }
        }

        overloads.sort(Comparator.comparingInt(FunctionSignature::getArgumentCount));
        return overloads;
    }

    private static void addUnique(final List<FunctionSignature> into,
            final boolean[] seenArity, final FunctionSignature s) {
        final int arity = s.getArgumentCount();
        if (arity >= 0 && arity < seenArity.length && !seenArity[arity]) {
            seenArity[arity] = true;
            into.add(s);
        }
    }

    /**
     * Pick the active overload: the smallest-arity overload whose arity is at
     * least {@code intendedArity}; falls back to the largest available if
     * none has enough. Assumes {@code overloads} is sorted by arity ascending.
     */
    private static int pickActiveSignature(final List<FunctionSignature> overloads,
            final int intendedArity) {
        for (int i = 0; i < overloads.size(); i++) {
            if (overloads.get(i).getArgumentCount() >= intendedArity) {
                return i;
            }
        }
        return overloads.size() - 1;
    }

    private Sequence buildSignatureHelp(final List<FunctionSignature> overloads,
            final int activeParam, final int intendedArity) throws XPathException {
        final List<Sequence> signatures = new ArrayList<>(overloads.size());
        for (final FunctionSignature sig : overloads) {
            signatures.add(buildSignatureInfo(sig));
        }
        final int activeSig = pickActiveSignature(overloads, intendedArity);
        final int activeArity = overloads.get(activeSig).getArgumentCount();
        final int clampedParam = activeArity == 0
                ? 0 : Math.min(Math.max(activeParam, 0), activeArity - 1);

        final MapType result = new MapType(this, context);
        result.add(new StringValue(this, "signatures"), new ArrayType(this, context, signatures));
        result.add(new StringValue(this, "activeSignature"), new IntegerValue(this, activeSig));
        result.add(new StringValue(this, "activeParameter"), new IntegerValue(this, clampedParam));
        return result;
    }

    private MapType buildSignatureInfo(final FunctionSignature sig) throws XPathException {
        final MapType sigInfo = new MapType(this, context);
        sigInfo.add(new StringValue(this, "label"),
                new StringValue(this, MarkdownFormatter.signatureLabel(sig)));
        sigInfo.add(new StringValue(this, "documentation"), buildMarkupContent(
                sig.getDescription() != null ? sig.getDescription() : ""));

        final List<Sequence> paramInfos = new ArrayList<>();
        final SequenceType[] argTypes = sig.getArgumentTypes();
        if (argTypes != null) {
            for (final SequenceType argType : argTypes) {
                final MapType param = new MapType(this, context);
                param.add(new StringValue(this, "label"),
                        new StringValue(this, MarkdownFormatter.parameterLabel(argType)));
                param.add(new StringValue(this, "documentation"),
                        buildMarkupContent(MarkdownFormatter.parameterMarkdown(argType)));
                paramInfos.add(param);
            }
        }
        sigInfo.add(new StringValue(this, "parameters"),
                new ArrayType(this, context, paramInfos));
        return sigInfo;
    }

    private MapType buildMarkupContent(final String markdown) throws XPathException {
        final MapType mc = new MapType(this, context);
        mc.add(new StringValue(this, "kind"), new StringValue(this, "markdown"));
        mc.add(new StringValue(this, "value"), new StringValue(this, markdown));
        return mc;
    }

    /**
     * Count top-level commas (commas not inside nested parens or string
     * literals) between {@code from} and {@code to}, exclusive.
     */
    private static int countTopLevelCommas(final String expr, final int from, final int to) {
        int depth = 0;
        int commas = 0;
        int i = from;
        final int end = Math.min(to, expr.length());
        while (i < end) {
            final char c = expr.charAt(i);
            final int next = scanStep(expr, i, c, depth);
            if (next < 0) {
                return commas;
            }
            if (next == i) {
                if (c == '(') {
                    depth++;
                } else if (c == ')') {
                    depth--;
                } else if (c == ',' && depth == 0) {
                    commas++;
                }
                i++;
            } else {
                i = next;
            }
        }
        return commas;
    }

    private static int scanStep(final String expr, final int i, final char c, final int depth) {
        if (c == '"' || c == '\'') {
            final int after = skipString(expr, i, c);
            return after < 0 ? -1 : after + 1;
        }
        if (c == ')' && depth == 0) {
            return -1;
        }
        return i;
    }

    private static int skipString(final String s, final int start, final char quote) {
        for (int i = start + 1; i < s.length(); i++) {
            final char c = s.charAt(i);
            // XQuery doubles quotes to escape them inside strings
            if (c == quote) {
                if (i + 1 < s.length() && s.charAt(i + 1) == quote) {
                    i++;
                    continue;
                }
                return i;
            }
        }
        return -1;
    }

    private static int lineColumnToOffset(final String s, final int line0, final int col0) {
        int line = 0;
        int col = 0;
        for (int i = 0; i < s.length(); i++) {
            if (line == line0 && col == col0) {
                return i;
            }
            if (s.charAt(i) == '\n') {
                line++;
                col = 0;
            } else {
                col++;
            }
        }
        return line == line0 && col == col0 ? s.length() : -1;
    }
}
