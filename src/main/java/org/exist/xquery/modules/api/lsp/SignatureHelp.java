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

import java.io.StringReader;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.dom.QName;
import org.exist.xquery.AnalyzeContextInfo;
import org.exist.xquery.BasicFunction;
import org.exist.xquery.Expression;
import org.exist.xquery.Function;
import org.exist.xquery.FunctionCall;
import org.exist.xquery.FunctionSignature;
import org.exist.xquery.InternalFunctionCall;
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
import org.exist.xquery.value.FunctionParameterSequenceType;
import org.exist.xquery.value.IntegerValue;
import org.exist.xquery.value.Sequence;
import org.exist.xquery.value.SequenceType;
import org.exist.xquery.value.StringValue;
import org.exist.xquery.value.Type;

import antlr.collections.AST;

import static org.exist.xquery.FunctionDSL.*;

/**
 * Returns signature help for the function call at a given position in an
 * XQuery expression, suitable for Language Server Protocol
 * {@code textDocument/signatureHelp} responses.
 *
 * <p>Returns a map with the following keys:</p>
 * <ul>
 *   <li>{@code signatures} — array of signature maps, each with:
 *     <ul>
 *       <li>{@code label} — full function signature string</li>
 *       <li>{@code documentation} — function description</li>
 *       <li>{@code parameters} — array of parameter maps with {@code label}
 *           and {@code documentation} keys</li>
 *     </ul>
 *   </li>
 *   <li>{@code activeSignature} — index of the best-matching signature</li>
 *   <li>{@code activeParameter} — index of the parameter the cursor is in</li>
 * </ul>
 *
 * <p>Returns an empty sequence if no function call is found at the position.</p>
 *
 * @author eXist-db
 */
public class SignatureHelp extends BasicFunction {

    private static final Logger logger = LogManager.getLogger(SignatureHelp.class);

    private static final String FS_SIGNATURE_HELP_NAME = "signature-help";
    private static final String FS_SIGNATURE_HELP_DESCRIPTION = """
            Returns signature help for the function call at the given \
            position. Returns a map with keys: signatures (array of \
            signature maps with label, documentation, and parameters), \
            activeSignature (xs:integer, index of best match), and \
            activeParameter (xs:integer, index of current parameter). \
            Returns an empty sequence if no function call is found.""";

    public static final FunctionSignature[] FS_SIGNATURE_HELP = functionSignatures(
            LspModule.qname(FS_SIGNATURE_HELP_NAME),
            FS_SIGNATURE_HELP_DESCRIPTION,
            returns(Type.MAP_ITEM, "a signature help map, or empty sequence"),
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

                // Find the function call at the cursor position
                final Hover.NodeAtPositionFinder finder =
                        new Hover.NodeAtPositionFinder(targetLine, targetColumn);
                path.accept(finder);
                final Iterator<UserDefinedFunction> localFuncs = pContext.localFunctions();
                while (localFuncs.hasNext()) {
                    localFuncs.next().getFunctionBody().accept(finder);
                }

                final Expression found = finder.foundExpression;

                // Get the function signature — handle both user-defined
                // (FunctionCall) and built-in (InternalFunctionCall) functions
                final FunctionSignature foundSig;
                if (found instanceof final FunctionCall call) {
                    foundSig = call.getFunction().getSignature();
                } else if (found instanceof final InternalFunctionCall intCall) {
                    foundSig = intCall.getSignature();
                } else if (found instanceof final Function func) {
                    foundSig = func.getSignature();
                } else {
                    return Sequence.EMPTY_SEQUENCE;
                }

                // Determine active parameter by counting commas before cursor
                final int activeParameter = countActiveParameter(expr, targetLine, targetColumn);

                // Collect all overloads of this function
                final QName funcName = foundSig.getName();
                final List<FunctionSignature> overloads = collectOverloads(funcName, pContext);

                if (overloads.isEmpty()) {
                    // At least include the current call's signature
                    overloads.add(foundSig);
                }

                // Find best matching signature (closest arity >= activeParameter + 1)
                int activeSignature = 0;
                final int currentArity = foundSig.getArgumentCount();
                for (int i = 0; i < overloads.size(); i++) {
                    if (overloads.get(i).getArgumentCount() == currentArity) {
                        activeSignature = i;
                        break;
                    }
                }

                return buildResult(overloads, activeSignature, activeParameter);
            } finally {
                context.popNamespaceContext();
                pContext.reset(false);
            }
        } finally {
            pContext.runCleanupTasks();
        }
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
            logger.debug("Error compiling expression for signature help: {}", e.getMessage());
            return null;
        }
    }

    /**
     * Counts the active parameter index by scanning the source text for commas
     * at the same nesting level, on or before the cursor position.
     */
    private static int countActiveParameter(final String expr, final int targetLine, final int targetColumn) {
        final String[] lines = expr.split("\n", -1);

        // Convert line/column to absolute offset
        int targetOffset = 0;
        for (int i = 0; i < targetLine - 1 && i < lines.length; i++) {
            targetOffset += lines[i].length() + 1;
        }
        targetOffset += Math.min(targetColumn - 1, lines.length > targetLine - 1 ? lines[targetLine - 1].length() : 0);

        // Walk backward from cursor to find the opening paren of the function call
        int depth = 0;
        int commaCount = 0;
        boolean inString = false;
        char stringChar = 0;

        for (int i = targetOffset - 1; i >= 0; i--) {
            final char c = expr.charAt(i);

            // Handle string literals (simplified — track single and double quotes)
            if ((c == '"' || c == '\'') && !inString) {
                inString = true;
                stringChar = c;
                continue;
            }
            if (inString) {
                if (c == stringChar) {
                    inString = false;
                }
                continue;
            }

            if (c == ')') {
                depth++;
            } else if (c == '(') {
                if (depth == 0) {
                    // Found the opening paren of our function call
                    break;
                }
                depth--;
            } else if (c == ',' && depth == 0) {
                commaCount++;
            }
        }

        return commaCount;
    }

    /**
     * Collects all overloads (same QName, different arities) from built-in
     * modules and user-defined functions.
     */
    private List<FunctionSignature> collectOverloads(final QName funcName, final XQueryContext pContext) {
        final List<FunctionSignature> overloads = new ArrayList<>();

        // Search built-in modules
        final Iterator<Module> modules = pContext.getAllModules();
        while (modules.hasNext()) {
            final Module module = modules.next();
            if (!module.isInternalModule()) {
                continue;
            }
            if (!module.getNamespaceURI().equals(funcName.getNamespaceURI())) {
                continue;
            }
            final Iterator<FunctionSignature> sigs = module.getSignaturesForFunction(funcName);
            while (sigs.hasNext()) {
                overloads.add(sigs.next());
            }
        }

        // Search user-defined functions
        final Iterator<UserDefinedFunction> localFuncs = pContext.localFunctions();
        while (localFuncs.hasNext()) {
            final UserDefinedFunction udf = localFuncs.next();
            if (funcName.equals(udf.getSignature().getName())) {
                overloads.add(udf.getSignature());
            }
        }

        // Sort by arity for stable ordering
        overloads.sort((a, b) -> Integer.compare(a.getArgumentCount(), b.getArgumentCount()));

        return overloads;
    }

    private Sequence buildResult(final List<FunctionSignature> overloads,
            final int activeSignature, final int activeParameter) throws XPathException {
        final List<Sequence> signatureItems = new ArrayList<>();

        for (final FunctionSignature sig : overloads) {
            final MapType sigMap = new MapType(this, context);

            // Label: full signature string
            sigMap.add(new StringValue(this, "label"), new StringValue(this, sig.toString()));

            // Documentation
            final String desc = sig.getDescription();
            sigMap.add(new StringValue(this, "documentation"),
                    new StringValue(this, desc != null ? desc : ""));

            // Parameters
            final List<Sequence> paramItems = new ArrayList<>();
            final SequenceType[] argTypes = sig.getArgumentTypes();
            if (argTypes != null) {
                for (final SequenceType argType : argTypes) {
                    final MapType paramMap = new MapType(this, context);
                    if (argType instanceof final FunctionParameterSequenceType paramType) {
                        final String paramLabel = "$" + paramType.getAttributeName() + " as "
                                + Type.getTypeName(paramType.getPrimaryType())
                                + paramType.getCardinality().toXQueryCardinalityString();
                        paramMap.add(new StringValue(this, "label"),
                                new StringValue(this, paramLabel));
                        final String paramDoc = paramType.getDescription();
                        paramMap.add(new StringValue(this, "documentation"),
                                new StringValue(this, paramDoc != null ? paramDoc : ""));
                    } else {
                        final String paramLabel = Type.getTypeName(argType.getPrimaryType())
                                + argType.getCardinality().toXQueryCardinalityString();
                        paramMap.add(new StringValue(this, "label"),
                                new StringValue(this, paramLabel));
                        paramMap.add(new StringValue(this, "documentation"),
                                new StringValue(this, ""));
                    }
                    paramItems.add(paramMap);
                }
            }
            sigMap.add(new StringValue(this, "parameters"),
                    new ArrayType(this, context, paramItems));

            signatureItems.add(sigMap);
        }

        final MapType result = new MapType(this, context);
        result.add(new StringValue(this, "signatures"),
                new ArrayType(this, context, signatureItems));
        result.add(new StringValue(this, "activeSignature"),
                new IntegerValue(this, activeSignature));
        result.add(new StringValue(this, "activeParameter"),
                new IntegerValue(this, activeParameter));
        return result;
    }
}
