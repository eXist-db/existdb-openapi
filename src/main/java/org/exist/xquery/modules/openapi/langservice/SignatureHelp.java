/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.openapi.langservice;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.dom.QName;
import org.exist.xquery.AnalyzeContextInfo;
import org.exist.xquery.BasicFunction;
import org.exist.xquery.DefaultExpressionVisitor;
import org.exist.xquery.Expression;
import org.exist.xquery.Function;
import org.exist.xquery.FunctionCall;
import org.exist.xquery.FunctionSignature;
import org.exist.xquery.Module;
import org.exist.xquery.PathExpr;
import org.exist.xquery.UserDefinedFunction;
import org.exist.xquery.XPathException;
import org.exist.xquery.XQueryContext;
import org.exist.xquery.functions.array.ArrayType;
import org.exist.xquery.functions.map.MapType;
import org.exist.xquery.parser.XQueryLexer;
import org.exist.xquery.parser.XQueryParser;
import org.exist.xquery.parser.XQueryTreeParser;
import org.exist.xquery.value.IntegerValue;
import org.exist.xquery.value.Sequence;
import org.exist.xquery.value.SequenceType;
import org.exist.xquery.value.StringValue;
import org.exist.xquery.value.Type;

import antlr.collections.AST;

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
 * <p>The active parameter is computed by scanning back from the cursor to the
 * function-call's opening paren and counting commas at the same paren depth.
 * Nested function calls and string literals are tracked.</p>
 *
 * <p>Returns an empty sequence if the cursor is not inside a function-call
 * argument list.</p>
 */
public class SignatureHelp extends BasicFunction {

    private static final Logger logger = LogManager.getLogger(SignatureHelp.class);

    private static final String FS_SIGNATURE_HELP_NAME = "signature-help";
    private static final String FS_SIGNATURE_HELP_DESCRIPTION = """
            Returns LSP-shaped SignatureHelp for the function call surrounding \
            the cursor: a map with keys signatures (array of SignatureInformation \
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

    public SignatureHelp(final XQueryContext context, final FunctionSignature signature) {
        super(context, signature);
    }

    @Override
    public Sequence eval(final Sequence[] args, final Sequence contextSequence) throws XPathException {
        final String expr = args[0].getStringValue();
        final int line0 = ((IntegerValue) args[1].itemAt(0)).getInt();
        final int col0 = ((IntegerValue) args[2].itemAt(0)).getInt();
        // 1-based for the parser's line/column accounting
        final int targetLine = line0 + 1;
        final int targetColumn = col0 + 1;

        if (expr.trim().isEmpty()) {
            return Sequence.EMPTY_SEQUENCE;
        }

        final XQueryContext pContext = new XQueryContext(context.getBroker().getBrokerPool());
        try {
            if (getArgumentCount() == 4 && args[3].hasOne()) {
                pContext.setModuleLoadPath(args[3].getStringValue());
            }

            context.pushNamespaceContext();
            try {
                final PathExpr path = compile(pContext, expr);
                if (path == null) {
                    return Sequence.EMPTY_SEQUENCE;
                }

                final EnclosingCallFinder finder = new EnclosingCallFinder(targetLine, targetColumn);
                path.accept(finder);
                final Iterator<UserDefinedFunction> localFuncs = pContext.localFunctions();
                while (localFuncs.hasNext()) {
                    localFuncs.next().getFunctionBody().accept(finder);
                }

                if (finder.bestSignature == null) {
                    return Sequence.EMPTY_SEQUENCE;
                }
                final int activeParam = computeActiveParameter(expr, line0, col0,
                        finder.bestLine, finder.bestColumn);
                final List<FunctionSignature> overloads = collectOverloads(pContext, finder.bestSignature);
                return buildSignatureHelp(overloads, finder.bestSignature, activeParam);
            } finally {
                context.popNamespaceContext();
                pContext.reset(false);
            }
        } catch (final Exception e) {
            logger.debug("Error during signature-help lookup: {}", e.getMessage());
        } finally {
            pContext.runCleanupTasks();
        }
        return Sequence.EMPTY_SEQUENCE;
    }

    private PathExpr compile(final XQueryContext pContext, final String expr) {
        try {
            final XQueryLexer lexer = new XQueryLexer(pContext, new StringReader(expr));
            final XQueryParser parser = new XQueryParser(lexer);
            final XQueryTreeParser astParser = new XQueryTreeParser(pContext);
            parser.xpath();
            if (parser.foundErrors()) {
                return null;
            }
            final AST ast = parser.getAST();
            final PathExpr path = new PathExpr(pContext);
            astParser.xpath(ast, path);
            if (astParser.foundErrors()) {
                return null;
            }
            path.analyze(new AnalyzeContextInfo());
            return path;
        } catch (final Exception e) {
            logger.debug("Error compiling expression for signature-help: {}", e.getMessage());
            return null;
        }
    }

    private Sequence buildSignatureHelp(final List<FunctionSignature> overloads,
            final FunctionSignature resolved, final int activeParam) throws XPathException {
        final List<Sequence> signatures = new ArrayList<>(overloads.size());
        int activeSig = 0;
        for (int i = 0; i < overloads.size(); i++) {
            final FunctionSignature sig = overloads.get(i);
            if (sig.getArgumentCount() == resolved.getArgumentCount()) {
                activeSig = i;
            }
            signatures.add(buildSignatureInfo(sig));
        }

        final FunctionSignature activeOverload = overloads.get(activeSig);
        final int activeArity = activeOverload.getArgumentCount();
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

    /**
     * Collect all overloads of the resolved function — same QName, any arity —
     * sorted by arity ascending.
     *
     * <p>Searches three sources:</p>
     * <ol>
     *   <li>The module matching the resolved function's namespace — built-in
     *       modules pre-register every signature, so their {@code listFunctions()}
     *       returns all arities (XQueryContext's getSignaturesForFunction only
     *       returns what the current compilation has *loaded*, so it misses
     *       arities the user code didn't reference).</li>
     *   <li>{@link XQueryContext#localFunctions()} for user-declared
     *       functions whose names match.</li>
     *   <li>Always includes the resolved sig itself (defensive — if the lookups
     *       above somehow miss it, the active sig is still in the result).</li>
     * </ol>
     *
     * <p>Deduplicates by arity; for the rare case of two registrations of the
     * same name+arity, the first wins.</p>
     */
    private static List<FunctionSignature> collectOverloads(final XQueryContext pContext,
            final FunctionSignature resolved) {
        final QName target = resolved.getName();
        final List<FunctionSignature> overloads = new ArrayList<>();
        final boolean[] seenArity = new boolean[256];

        final Iterator<Module> modules = pContext.getAllModules();
        while (modules.hasNext()) {
            final Module module = modules.next();
            if (!target.getNamespaceURI().equals(module.getNamespaceURI())) {
                continue;
            }
            for (final FunctionSignature s : module.listFunctions()) {
                if (target.equals(s.getName())) {
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

        addUnique(overloads, seenArity, resolved);
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

    private MapType buildMarkupContent(final String markdown) throws XPathException {
        final MapType mc = new MapType(this, context);
        mc.add(new StringValue(this, "kind"), new StringValue(this, "markdown"));
        mc.add(new StringValue(this, "value"), new StringValue(this, markdown));
        return mc;
    }

    /**
     * Scan the expression text from the function-call's opening paren to the
     * cursor position, counting commas at the call's paren depth. String
     * literals (single and double quoted) are skipped to avoid mistaking
     * commas inside strings for argument separators.
     *
     * @param callLine 1-based line of the FunctionCall start
     * @param callColumn 1-based column of the FunctionCall start
     * @return 0-based active-parameter index, or 0 if it can't be determined
     */
    private static int computeActiveParameter(final String expr,
            final int cursorLine0, final int cursorCol0,
            final int callLine, final int callColumn) {
        final int callOffset = lineColumnToOffset(expr, callLine - 1, callColumn - 1);
        final int cursorOffset = lineColumnToOffset(expr, cursorLine0, cursorCol0);
        if (callOffset < 0 || cursorOffset < 0 || cursorOffset <= callOffset) {
            return 0;
        }
        final int openParen = expr.indexOf('(', callOffset);
        if (openParen < 0 || openParen >= cursorOffset) {
            return 0;
        }
        return countTopLevelCommas(expr, openParen + 1, cursorOffset);
    }

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

    /**
     * Returns the next index to inspect, or {@code -1} to stop the outer scan.
     * Returning the current index means "no skip applied — process this char in
     * the caller." Strings cause a jump past the closing quote; an unclosed
     * close-paren at depth 0 signals end-of-call.
     */
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

    /**
     * Finds the {@link FunctionCall} or built-in {@link Function} whose call
     * site is the nearest enclosing one for the cursor position — the call
     * whose start is at-or-before the cursor and whose column is greatest
     * (deepest). Mirrors {@link Hover.NodeAtPositionFinder} but specifically
     * for function calls; built-in functions are unwrapped via
     * {@link DefaultExpressionVisitor#visitBuiltinFunction}.
     */
    static class EnclosingCallFinder extends DefaultExpressionVisitor {
        private final int targetLine;
        private final int targetColumn;
        FunctionSignature bestSignature;
        int bestLine = -1;
        int bestColumn = -1;

        EnclosingCallFinder(final int targetLine, final int targetColumn) {
            this.targetLine = targetLine;
            this.targetColumn = targetColumn;
        }

        @Override
        public void visitFunctionCall(final FunctionCall call) {
            consider(call, call.getSignature());
            super.visitFunctionCall(call);
        }

        @Override
        public void visitBuiltinFunction(final Function function) {
            consider(function, function.getSignature());
            super.visitBuiltinFunction(function);
        }

        @Override
        public void visit(final Expression expression) {
            for (int i = 0; i < expression.getSubExpressionCount(); i++) {
                expression.getSubExpression(i).accept(this);
            }
        }

        private void consider(final Expression expr, final FunctionSignature sig) {
            if (sig == null) {
                return;
            }
            final int line = expr.getLine();
            final int column = expr.getColumn();
            if (line == targetLine && column <= targetColumn
                    && (column > bestColumn || bestColumn < 0)) {
                bestSignature = sig;
                bestLine = line;
                bestColumn = column;
            }
        }
    }
}
