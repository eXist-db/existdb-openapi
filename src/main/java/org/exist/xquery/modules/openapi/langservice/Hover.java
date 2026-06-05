/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.openapi.langservice;

import java.io.StringReader;
import java.util.Iterator;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.xquery.AnalyzeContextInfo;
import org.exist.xquery.BasicFunction;
import org.exist.xquery.DefaultExpressionVisitor;
import org.exist.xquery.Expression;
import org.exist.xquery.ForExpr;
import org.exist.xquery.Function;
import org.exist.xquery.FunctionCall;
import org.exist.xquery.FunctionSignature;
import org.exist.xquery.LetExpr;
import org.exist.xquery.PathExpr;
import org.exist.xquery.UserDefinedFunction;
import org.exist.xquery.VariableDeclaration;
import org.exist.xquery.VariableReference;
import org.exist.xquery.XPathException;
import org.exist.xquery.XQueryContext;
import org.exist.xquery.functions.map.MapType;
import org.exist.xquery.parser.XQueryLexer;
import org.exist.xquery.parser.XQueryParser;
import org.exist.xquery.parser.XQueryTreeParser;
import org.exist.xquery.value.FunctionParameterSequenceType;
import org.exist.xquery.value.IntegerValue;
import org.exist.xquery.value.Sequence;
import org.exist.xquery.value.SequenceType;
import org.exist.xquery.value.StringValue;
import org.exist.xquery.value.Type;

import antlr.collections.AST;

import static org.exist.xquery.FunctionDSL.*;

/**
 * Returns hover information for the symbol at a given position in an XQuery
 * expression, suitable for Language Server Protocol {@code textDocument/hover}
 * responses.
 *
 * <p>Returns a map shaped like LSP's {@code Hover}:</p>
 * <pre>
 * {
 *   "contents": { "kind": "markdown", "value": "&lt;markdown string&gt;" }
 * }
 * </pre>
 *
 * <p>The Markdown body contains a fenced XQuery code block for the signature,
 * the function's prose description, a bullet list of parameters (each with
 * type and per-parameter docs), and the return type. For variables, only the
 * variable name (and type when known) is included.</p>
 *
 * <p>Returns an empty sequence if nothing is found at the given position.</p>
 *
 * @author eXist-db
 */
public class Hover extends BasicFunction {

    private static final Logger logger = LogManager.getLogger(Hover.class);

    private static final String FS_HOVER_NAME = "hover";
    private static final String FS_HOVER_DESCRIPTION = """
            Returns hover information for the symbol at the given position \
            in the XQuery expression, shaped like LSP's Hover: a map with one \
            key, contents, whose value is a MarkupContent map { kind: \
            "markdown", value: "<markdown>" }. The Markdown body includes a \
            fenced code block for the signature, the description, a bullet \
            list of parameters, and the return type. Returns an empty \
            sequence if no symbol is found at the position.""";

    public static final FunctionSignature[] FS_HOVER = functionSignatures(
            LangServiceModule.qname(FS_HOVER_NAME),
            FS_HOVER_DESCRIPTION,
            returns(Type.MAP_ITEM, "a hover info map, or empty sequence"),
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

    public Hover(final XQueryContext context, final FunctionSignature signature) {
        super(context, signature);
    }

    @Override
    public Sequence eval(final Sequence[] args, final Sequence contextSequence) throws XPathException {
        final String expr = args[0].getStringValue();
        // Convert 0-based LSP position to 1-based parser position
        final int targetLine = ((IntegerValue) args[1].itemAt(0)).getInt() + 1;
        final int targetColumn = ((IntegerValue) args[2].itemAt(0)).getInt() + 1;

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

                final NodeAtPositionFinder finder = new NodeAtPositionFinder(targetLine, targetColumn);
                path.accept(finder);

                // Also traverse user-defined function bodies (needed for library
                // modules where function bodies aren't part of the main PathExpr)
                final Iterator<UserDefinedFunction> localFuncs = pContext.localFunctions();
                while (localFuncs.hasNext()) {
                    localFuncs.next().getFunctionBody().accept(finder);
                }

                if (finder.foundExpression != null) {
                    return buildHoverResult(finder.foundExpression, path, pContext,
                            targetLine, targetColumn);
                }
            } finally {
                context.popNamespaceContext();
                pContext.reset(false);
            }
        } catch (final Exception e) {
            // Gracefully return empty for any position that can't be resolved
            logger.debug("Error during hover lookup: {}", e.getMessage());
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
            logger.debug("Error compiling expression for hover: {}", e.getMessage());
            return null;
        }
    }

    private Sequence buildHoverResult(final Expression expr, final PathExpr path,
            final XQueryContext pContext, final int targetLine, final int targetColumn)
            throws XPathException {
        if (expr instanceof final FunctionCall call) {
            return buildFunctionHover(call.getSignature());
        } else if (expr instanceof final Function func) {
            // Built-in function (inner function from InternalFunctionCall)
            return buildFunctionHover(func.getSignature());
        } else if (expr instanceof final VariableReference varRef) {
            return buildVariableHover(varRef, path, pContext, targetLine, targetColumn);
        }
        return Sequence.EMPTY_SEQUENCE;
    }

    private Sequence buildFunctionHover(final FunctionSignature sig) throws XPathException {
        return buildHoverMap(MarkdownFormatter.functionMarkdown(sig));
    }

    private Sequence buildVariableHover(final VariableReference varRef, final PathExpr path,
            final XQueryContext pContext, final int targetLine, final int targetColumn)
            throws XPathException {
        final org.exist.dom.QName name = varRef.getName();
        final String prefix = name.getPrefix();
        final String varName = (prefix != null && !prefix.isEmpty())
                ? "$" + prefix + ":" + name.getLocalPart()
                : "$" + name.getLocalPart();

        final SequenceType type = findVariableType(name, path, pContext, targetLine, targetColumn);
        final StringBuilder md = new StringBuilder();
        md.append('`').append(varName).append('`');
        if (type != null) {
            md.append(" as `").append(MarkdownFormatter.formatType(type)).append('`');
            if (type instanceof final FunctionParameterSequenceType p) {
                final String desc = p.getDescription();
                if (desc != null && !desc.isEmpty()) {
                    md.append("\n\n").append(desc.trim());
                }
            }
        }
        return buildHoverMap(md.toString());
    }

    /**
     * Walk the AST looking for the most recent in-scope binding of the named
     * variable: prolog-declared globals ({@code declare variable $x ...}),
     * FLWOR bindings ({@code let $x ...}, {@code for $x ...}), and
     * user-function parameters. The last matching binding whose declaration
     * position is at or before the cursor wins.
     */
    private static SequenceType findVariableType(final org.exist.dom.QName target,
            final PathExpr path, final XQueryContext pContext,
            final int targetLine, final int targetColumn) {
        final VariableTypeFinder finder = new VariableTypeFinder(target, targetLine, targetColumn);
        path.accept(finder);
        // Also walk user-function bodies — for hover on a parameter ref
        // inside a function body where the function is declared as a sibling
        // in the prolog rather than the body's parent path.
        final Iterator<UserDefinedFunction> fns = pContext.localFunctions();
        while (fns.hasNext()) {
            final UserDefinedFunction fn = fns.next();
            considerFunctionParameter(fn, target, finder);
            fn.getFunctionBody().accept(finder);
        }
        return finder.foundType;
    }

    private static void considerFunctionParameter(final UserDefinedFunction fn,
            final org.exist.dom.QName target, final VariableTypeFinder finder) {
        final SequenceType[] argTypes = fn.getSignature().getArgumentTypes();
        if (argTypes == null) {
            return;
        }
        for (final SequenceType argType : argTypes) {
            if (argType instanceof final FunctionParameterSequenceType p
                    && target.getLocalPart().equals(p.getAttributeName())) {
                finder.foundType = argType;
            }
        }
    }

    private Sequence buildHoverMap(final String markdown) throws XPathException {
        final MapType contents = new MapType(this, context);
        contents.add(new StringValue(this, "kind"), new StringValue(this, "markdown"));
        contents.add(new StringValue(this, "value"), new StringValue(this, markdown));

        final MapType result = new MapType(this, context);
        result.add(new StringValue(this, "contents"), contents);
        return result;
    }

    /**
     * Visitor that traverses the full expression tree (including FLWOR clauses)
     * to find the best-matching FunctionCall, InternalFunctionCall, or
     * VariableReference at the given position.
     *
     * <p>Uses {@link DefaultExpressionVisitor} for traversal since it knows
     * how to enter FLWOR expressions, which don't expose children via
     * {@code getSubExpressionCount()}.</p>
     */
    /**
     * Visitor that finds the type of an in-scope binding for a named variable
     * at the cursor position. Walks let/for/prolog/function bindings; the
     * latest matching binding whose declaration position is at-or-before the
     * cursor wins (mirrors XQuery's lexical scoping with last-binding-shadows
     * — without re-implementing full scope tracking).
     */
    static class VariableTypeFinder extends DefaultExpressionVisitor {
        private final org.exist.dom.QName target;
        private final int targetLine;
        private final int targetColumn;
        SequenceType foundType;

        VariableTypeFinder(final org.exist.dom.QName target,
                final int targetLine, final int targetColumn) {
            this.target = target;
            this.targetLine = targetLine;
            this.targetColumn = targetColumn;
        }

        @Override
        public void visitLetExpression(final LetExpr let) {
            consider(let.getLine(), let.getColumn(), let.getVariable(), inferredType(let.getInputSequence()));
            super.visitLetExpression(let);
        }

        @Override
        public void visitForExpression(final ForExpr forExpr) {
            // For-loop bindings iterate one-at-a-time, so the bound var has
            // the input's item type with cardinality EXACTLY_ONE — not the
            // sequence cardinality of the input expression.
            final Expression input = forExpr.getInputSequence();
            final SequenceType type = input == null ? null
                    : new SequenceType(input.returnsType(), org.exist.xquery.Cardinality.EXACTLY_ONE);
            consider(forExpr.getLine(), forExpr.getColumn(), forExpr.getVariable(), type);
            super.visitForExpression(forExpr);
        }

        /**
         * BindingExpression's declared {@code sequenceType} field is protected
         * with no public getter, so for {@code let}/{@code for} we synthesize
         * a SequenceType from the bound expression's inferred return type and
         * cardinality. This is the analysis-inferred type, not necessarily
         * the user's literal type annotation — for {@code let $x := //para}
         * the user sees {@code element()*} (correct), and for
         * {@code let $x as xs:integer := 1} they see {@code xs:integer}
         * because the inferred type happens to match.
         */
        private static SequenceType inferredType(final Expression input) {
            if (input == null) {
                return null;
            }
            return new SequenceType(input.returnsType(), input.getCardinality());
        }

        @Override
        public void visitVariableDeclaration(final VariableDeclaration varDecl) {
            // Prolog globals are visible everywhere — no position check.
            if (target.equals(varDecl.getName())) {
                foundType = varDecl.getSequenceType();
            }
        }

        @Override
        public void visit(final Expression expression) {
            for (int i = 0; i < expression.getSubExpressionCount(); i++) {
                expression.getSubExpression(i).accept(this);
            }
        }

        private void consider(final int line, final int column,
                final org.exist.dom.QName varName, final SequenceType type) {
            // Match on local part — FLWOR bindings rarely carry namespace
            // prefixes, and the hover target is typically the same shape.
            if (varName == null || !target.getLocalPart().equals(varName.getLocalPart())) {
                return;
            }
            // Only count bindings whose source position is at-or-before the
            // cursor — a let bound below the cursor isn't in scope above.
            if (line > 0 && (line < targetLine
                    || (line == targetLine && column <= targetColumn))) {
                foundType = type;
            }
        }
    }

    static class NodeAtPositionFinder extends DefaultExpressionVisitor {
        private final int targetLine;
        private final int targetColumn;
        Expression foundExpression;
        private int bestColumn = -1;

        NodeAtPositionFinder(final int targetLine, final int targetColumn) {
            this.targetLine = targetLine;
            this.targetColumn = targetColumn;
        }

        @Override
        public void visitFunctionCall(final FunctionCall call) {
            checkExpression(call);
            super.visitFunctionCall(call);
        }

        @Override
        public void visitBuiltinFunction(final Function function) {
            // The InternalFunctionCall wrapper delegates accept() to the inner
            // function, so we receive the inner BasicFunction here. Check position
            // on the inner function (which inherits position from the wrapper
            // via the compilation process).
            checkExpression(function);
            super.visitBuiltinFunction(function);
        }

        @Override
        public void visitVariableReference(final VariableReference ref) {
            checkExpression(ref);
        }

        @Override
        public void visit(final Expression expression) {
            // Traverse children for generic expressions
            for (int i = 0; i < expression.getSubExpressionCount(); i++) {
                expression.getSubExpression(i).accept(this);
            }
        }

        private void checkExpression(final Expression expr) {
            final int line = expr.getLine();
            final int column = expr.getColumn();

            if (line == targetLine && column <= targetColumn && column > bestColumn) {
                foundExpression = expr;
                bestColumn = column;
            }
        }
    }
}
