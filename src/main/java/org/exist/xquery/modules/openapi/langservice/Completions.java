/*
 * SPDX LGPL-2.1-or-later
 * Copyright (C) 2026 The eXist-db Authors
 */
package org.exist.xquery.modules.openapi.langservice;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.dom.QName;
import org.exist.xquery.AnalyzeContextInfo;
import org.exist.xquery.BasicFunction;
import org.exist.xquery.Expression;
import org.exist.xquery.FunctionSignature;
import org.exist.xquery.Module;
import org.exist.xquery.PathExpr;
import org.exist.xquery.UserDefinedFunction;
import org.exist.xquery.VariableDeclaration;
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
 * Returns completion items available in the context of an XQuery expression,
 * suitable for Language Server Protocol {@code textDocument/completion} responses.
 *
 * <p>Returns an array of maps, where each map represents a completion item with
 * the following keys:</p>
 * <ul>
 *   <li>{@code label} — display text (e.g., "fn:count")</li>
 *   <li>{@code kind} — LSP CompletionItemKind integer (3=Function, 6=Variable)</li>
 *   <li>{@code detail} — signature or type info</li>
 *   <li>{@code documentation} — description from function signature</li>
 *   <li>{@code insertText} — text to insert (e.g., "fn:count()")</li>
 * </ul>
 *
 * <p>Built-in module functions are always returned. If the expression compiles
 * successfully, user-declared functions and variables are included as well.</p>
 *
 * @author eXist-db
 */
public class Completions extends BasicFunction {

    private static final Logger logger = LogManager.getLogger(Completions.class);

    /** LSP CompletionItemKind constants */
    private static final long COMPLETION_KIND_FUNCTION = 3;
    private static final long COMPLETION_KIND_VARIABLE = 6;
    private static final long COMPLETION_KIND_KEYWORD = 14;
    private static final long COMPLETION_KIND_SNIPPET = 15;

    /** LSP InsertTextFormat: 1 = PlainText, 2 = Snippet. */
    private static final long INSERT_TEXT_FORMAT_PLAIN = 1;
    private static final long INSERT_TEXT_FORMAT_SNIPPET = 2;

    private static final Snippet[] SNIPPETS = {
            new Snippet("for", "for … in … return …",
                    "for \\$${1:x} in ${2:expr}\nreturn \\$$1"),
            new Snippet("let", "let … := …",
                    "let \\$${1:x} := ${2:expr}\nreturn \\$$1"),
            new Snippet("if", "if (…) then … else …",
                    "if (${1:condition}) then ${2:then} else ${3:else}"),
            new Snippet("try", "try { … } catch * { … }",
                    "try {\n    ${1}\n} catch * {\n    ${2:\\$err:description}\n}"),
            new Snippet("typeswitch", "typeswitch (…) case … default return …",
                    "typeswitch (${1:expr})\n    case ${2:xs:string} return ${3}\n    default return ${4}"),
            new Snippet("function", "declare function …(…) { … }",
                    "declare function ${1:local}:${2:name}(${3}) {\n    ${4}\n};"),
            new Snippet("import", "import module namespace …",
                    "import module namespace ${1:p} = \"${2:uri}\";")
    };

    /**
     * sortText prefix bucket per namespace. Bias toward the XQuery defaults so
     * unprefixed bare-mode input ranks {@code fn:*} above other namespaces.
     * Items not listed bucket to "9".
     */
    private static final Map<String, String> NAMESPACE_BUCKET = Map.of(
            "fn",    "0",
            "local", "0",
            "xs",    "1",
            "math",  "2",
            "map",   "3",
            "array", "3",
            "util",  "3"
    );

    private static final String FS_COMPLETIONS_NAME = "completions";
    private static final String FS_COMPLETIONS_DESCRIPTION = """
            Returns an array of completion item maps available in the context of \
            the given XQuery expression. Each map contains keys: label (xs:string), \
            kind (xs:integer, LSP CompletionItemKind), detail (xs:string, signature), \
            documentation (xs:string), and insertText (xs:string). \
            Built-in functions are always included; user-declared symbols are \
            included if the expression compiles successfully.""";

    public static final FunctionSignature[] FS_COMPLETIONS = functionSignatures(
            LangServiceModule.qname(FS_COMPLETIONS_NAME),
            FS_COMPLETIONS_DESCRIPTION,
            returns(Type.ARRAY_ITEM, "an array of completion item maps"),
            arities(
                    arity(
                            param("expression", Type.STRING, "The XQuery expression to analyze for available completions.")
                    ),
                    arity(
                            param("expression", Type.STRING, "The XQuery expression to analyze for available completions."),
                            optParam("module-load-path", Type.STRING, """
                                    The module load path. \
                                    Imports will be resolved relative to this. \
                                    Use xmldb:exist:///db or /db for database-stored modules.""")
                    )
            )
    );

    /** XQuery keywords for completion */
    private static final String[] XQUERY_KEYWORDS = {
            "declare", "function", "variable", "namespace", "module",
            "import", "at", "as", "instance", "of", "cast", "castable", "treat",
            "let", "for", "in", "where", "order", "by", "ascending", "descending",
            "group", "count", "return", "if", "then", "else",
            "some", "every", "satisfies",
            "typeswitch", "switch", "case", "default",
            "try", "catch",
            "element", "attribute", "text", "comment", "document",
            "processing-instruction", "node",
            "empty-sequence", "item",
            "or", "and", "not",
            "div", "idiv", "mod",
            "union", "intersect", "except",
            "to", "eq", "ne", "lt", "le", "gt", "ge",
            "is", "preceding", "following"
    };

    public Completions(final XQueryContext context, final FunctionSignature signature) {
        super(context, signature);
    }

    /**
     * Classification of the identifier-like token at the cursor (i.e. at the
     * end of the submitted expression). Drives server-side scoping: a {@code
     * prefix:} cursor narrows the response to that namespace; a bare token
     * gets the full set.
     */
    enum CursorMode { PREFIXED_PARTIAL, PREFIXED_EMPTY, BARE_PARTIAL, NONE }

    record CursorToken(String prefix, String localPart, CursorMode mode) {
        boolean isPrefixed() {
            return mode == CursorMode.PREFIXED_PARTIAL || mode == CursorMode.PREFIXED_EMPTY;
        }
    }

    /**
     * Snippet templates expanded by clients that honor
     * {@code insertTextFormat: 2}. Placeholders use {@code ${N:default}};
     * {@code \$} escapes a literal dollar (so the XQuery variable {@code $x}
     * is written {@code \$x} in the snippet body).
     */
    private record Snippet(String trigger, String label, String body) { }

    @Override
    public Sequence eval(final Sequence[] args, final Sequence contextSequence) throws XPathException {
        final String expr = args[0].getStringValue();
        final CursorToken cursor = parseTrailingToken(expr);
        final List<Sequence> completions = new ArrayList<>();

        final XQueryContext pContext = new XQueryContext(context.getBroker().getBrokerPool());
        try {
            if (getArgumentCount() == 2 && args[1].hasOne()) {
                pContext.setModuleLoadPath(args[1].getStringValue());
            }

            // Built-in module functions are always available
            addBuiltinFunctions(pContext, completions, cursor);

            // Keywords and snippets — never offered when the cursor is scoped
            // to a prefix, since `util:return`/`util:for` can't exist.
            if (!cursor.isPrefixed()) {
                addKeywords(completions);
                addSnippets(completions);
            }

            // Try to compile to discover user-declared symbols
            if (!expr.trim().isEmpty()) {
                context.pushNamespaceContext();
                try {
                    addUserDeclaredSymbols(pContext, expr, completions, cursor);
                } finally {
                    context.popNamespaceContext();
                    pContext.reset(false);
                }
            }
        } finally {
            pContext.runCleanupTasks();
        }

        return new ArrayType(this, context, completions);
    }

    /**
     * Walks back from the end of {@code expr} matching the trailing
     * identifier-like token. Recognises four shapes:
     * <ul>
     *   <li>{@code prefix:local} → {@link CursorMode#PREFIXED_PARTIAL}</li>
     *   <li>{@code prefix:} → {@link CursorMode#PREFIXED_EMPTY}</li>
     *   <li>{@code local} (no colon, non-empty) → {@link CursorMode#BARE_PARTIAL}</li>
     *   <li>empty/whitespace/non-NCName end → {@link CursorMode#NONE}</li>
     * </ul>
     * NCName chars: ASCII letter/digit/hyphen/underscore/period. Conservative —
     * misses non-ASCII identifiers but is correct for the common case.
     */
    static CursorToken parseTrailingToken(final String expr) {
        if (expr == null || expr.isEmpty()) {
            return new CursorToken("", "", CursorMode.NONE);
        }
        int end = expr.length();
        int i = end;
        while (i > 0 && isNCNameChar(expr.charAt(i - 1))) {
            i--;
        }
        final String tail = expr.substring(i, end);
        if (i > 0 && expr.charAt(i - 1) == ':') {
            int j = i - 1;
            int k = j;
            while (k > 0 && isNCNameChar(expr.charAt(k - 1))) {
                k--;
            }
            if (k < j) {
                final String prefix = expr.substring(k, j);
                return new CursorToken(prefix, tail,
                        tail.isEmpty() ? CursorMode.PREFIXED_EMPTY : CursorMode.PREFIXED_PARTIAL);
            }
        }
        if (tail.isEmpty()) {
            return new CursorToken("", "", CursorMode.NONE);
        }
        return new CursorToken("", tail, CursorMode.BARE_PARTIAL);
    }

    private static String sortBucket(final String prefix) {
        return NAMESPACE_BUCKET.getOrDefault(prefix == null ? "" : prefix, "9");
    }

    private static boolean isNCNameChar(final char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
                || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
    }

    /**
     * Adds completion items for functions in built-in modules. When the cursor
     * is scoped to a namespace ({@code prefix:} or {@code prefix:partial}),
     * only that module's functions are emitted; otherwise all built-ins.
     */
    private void addBuiltinFunctions(final XQueryContext pContext, final List<Sequence> completions,
            final CursorToken cursor) throws XPathException {
        final Set<String> seen = new HashSet<>();
        final Iterator<Module> modules = pContext.getAllModules();

        while (modules.hasNext()) {
            final Module module = modules.next();
            if (!module.isInternalModule()) {
                continue;
            }

            String prefix = module.getDefaultPrefix();
            if (prefix == null || prefix.isEmpty()) {
                // Some built-in modules (e.g., XPath functions) have empty default prefix
                // but are bound to a conventional prefix (e.g., "fn") in the context
                prefix = pContext.getPrefixForURI(module.getNamespaceURI());
                if (prefix == null) {
                    prefix = "";
                }
            }

            // Namespace scoping: skip modules whose bound prefix doesn't match
            // the cursor's prefix when the cursor is prefixed.
            if (cursor.isPrefixed() && !cursor.prefix().equals(prefix)) {
                continue;
            }

            for (final FunctionSignature sig : module.listFunctions()) {
                addBuiltinFunction(completions, sig, prefix, cursor, seen);
            }
        }
    }

    private void addBuiltinFunction(final List<Sequence> completions, final FunctionSignature sig,
            final String prefix, final CursorToken cursor, final Set<String> seen) throws XPathException {
        if (sig.isPrivate()) {
            return;
        }
        final QName name = sig.getName();
        if (cursor.isPrefixed() && !cursor.localPart().isEmpty()
                && !startsWithIgnoreCase(name.getLocalPart(), cursor.localPart())) {
            return;
        }
        final String label = formatLabel(prefix, name.getLocalPart(), sig.getArgumentCount());
        if (!seen.add(label)) {
            return;
        }
        // In bare mode (user hasn't typed any prefix), an `fn:` item inserts
        // without its prefix so accepting `cou` yields `count(...)`, not
        // `fn:count(...)`. Other namespaces always need their prefix to
        // resolve, so leave those alone.
        final boolean dropFnPrefix = !cursor.isPrefixed() && "fn".equals(prefix);
        final String insertText = dropFnPrefix
                ? formatInsertText("", name.getLocalPart())
                : formatInsertText(prefix, name.getLocalPart());
        final String documentation = sig.getDescription() != null ? sig.getDescription() : "";
        final String filterText = name.getLocalPart();
        final String sortText = sortBucket(prefix) + "_" + name.getLocalPart() + "#" + sig.getArgumentCount();
        addCompletion(completions, label, COMPLETION_KIND_FUNCTION, sig.toString(), documentation,
                insertText, filterText, sortText, INSERT_TEXT_FORMAT_PLAIN);
    }

    private static boolean startsWithIgnoreCase(final String s, final String prefix) {
        return s.length() >= prefix.length()
                && s.regionMatches(true, 0, prefix, 0, prefix.length());
    }

    /**
     * Adds XQuery keywords as completion items.
     */
    private void addKeywords(final List<Sequence> completions) throws XPathException {
        for (final String keyword : XQUERY_KEYWORDS) {
            // Keywords share the top bucket with fn:* — both are the most
            // common things users type without a prefix.
            addCompletion(completions, keyword, COMPLETION_KIND_KEYWORD, "keyword", "",
                    keyword, keyword, "0_" + keyword, INSERT_TEXT_FORMAT_PLAIN);
        }
    }

    /**
     * Adds snippet completions (FLWOR, try/catch, typeswitch, declarations,
     * imports). Clients that honor {@code insertTextFormat: 2} expand the
     * tab-stop placeholders; clients that don't fall back to plain-text
     * insertion per the LSP spec.
     */
    private void addSnippets(final List<Sequence> completions) throws XPathException {
        for (final Snippet s : SNIPPETS) {
            addCompletion(completions, s.trigger(), COMPLETION_KIND_SNIPPET, s.label(),
                    "XQuery snippet", s.body(), s.trigger(), "0_" + s.trigger(),
                    INSERT_TEXT_FORMAT_SNIPPET);
        }
    }

    /**
     * Tries to compile the expression and adds user-declared functions and variables.
     */
    private void addUserDeclaredSymbols(final XQueryContext pContext, final String expr,
            final List<Sequence> completions, final CursorToken cursor) throws XPathException {
        try {
            final XQueryLexer lexer = new XQueryLexer(pContext, new StringReader(expr));
            final XQueryParser parser = new XQueryParser(lexer);
            final XQueryTreeParser astParser = new XQueryTreeParser(pContext);

            parser.xpath();
            if (parser.foundErrors()) {
                return;
            }

            final AST ast = parser.getAST();
            final PathExpr path = new PathExpr(pContext);
            astParser.xpath(ast, path);
            if (astParser.foundErrors()) {
                return;
            }

            path.analyze(new AnalyzeContextInfo());

            // User-declared functions
            final Iterator<UserDefinedFunction> funcs = pContext.localFunctions();
            while (funcs.hasNext()) {
                addUserFunction(completions, funcs.next().getSignature(), cursor);
            }

            // User-declared global variables — never offered in prefixed mode
            if (cursor.isPrefixed()) {
                return;
            }
            for (int i = 0; i < path.getSubExpressionCount(); i++) {
                final Expression step = path.getSubExpression(i);
                if (step instanceof final VariableDeclaration varDecl) {
                    addVariable(completions, varDecl);
                }
            }

        } catch (final Exception e) {
            logger.debug("Error compiling expression for completions: {}", e.getMessage());
        }
    }

    private void addUserFunction(final List<Sequence> completions, final FunctionSignature sig,
            final CursorToken cursor) throws XPathException {
        final QName name = sig.getName();
        final String prefix = name.getPrefix() != null ? name.getPrefix() : "";
        if (cursor.isPrefixed() && !cursor.prefix().equals(prefix)) {
            return;
        }
        if (cursor.isPrefixed() && !cursor.localPart().isEmpty()
                && !startsWithIgnoreCase(name.getLocalPart(), cursor.localPart())) {
            return;
        }
        final String label = formatLabel(prefix, name.getLocalPart(), sig.getArgumentCount());
        final String insertText = formatInsertText(prefix, name.getLocalPart());
        // User-defined functions rank in the top bucket alongside fn:/keywords
        // — they're the symbols most relevant to the user's own code.
        final String sortText = "0_" + name.getLocalPart() + "#" + sig.getArgumentCount();
        addCompletion(completions, label, COMPLETION_KIND_FUNCTION, sig.toString(), "",
                insertText, name.getLocalPart(), sortText, INSERT_TEXT_FORMAT_PLAIN);
    }

    private void addVariable(final List<Sequence> completions, final VariableDeclaration varDecl)
            throws XPathException {
        final QName name = varDecl.getName();
        final String varName = "$" + formatQName(name);
        final SequenceType seqType = varDecl.getSequenceType();
        final String detail = seqType != null
                ? Type.getTypeName(seqType.getPrimaryType()) + seqType.getCardinality().toXQueryCardinalityString()
                : "";
        // filterText drops the leading $ so typing "x" (or "$x") matches "$x"
        addCompletion(completions, varName, COMPLETION_KIND_VARIABLE, detail, "",
                varName, name.getLocalPart(), "0_" + name.getLocalPart(), INSERT_TEXT_FORMAT_PLAIN);
    }

    /**
     * Creates a completion item map and adds it to the list.
     *
     * @param filterText text the client matches typed input against (usually
     *        the local-name, so bare {@code cou} matches {@code fn:count})
     * @param sortText sort key used by the client to order items; bucketed by
     *        namespace via {@link #sortBucket} so {@code fn:*} ranks first
     * @param insertTextFormat 1=PlainText, 2=Snippet (LSP InsertTextFormat)
     */
    private void addCompletion(final List<Sequence> completions, final String label,
            final long kind, final String detail, final String documentation,
            final String insertText, final String filterText, final String sortText,
            final long insertTextFormat) throws XPathException {
        final MapType item = new MapType(this, context);
        item.add(new StringValue(this, "label"), new StringValue(this, label));
        item.add(new StringValue(this, "kind"), new IntegerValue(this, kind));
        item.add(new StringValue(this, "detail"), new StringValue(this, detail));
        item.add(new StringValue(this, "documentation"), new StringValue(this, documentation));
        item.add(new StringValue(this, "insertText"), new StringValue(this, insertText));
        item.add(new StringValue(this, "filterText"), new StringValue(this, filterText));
        item.add(new StringValue(this, "sortText"), new StringValue(this, sortText));
        item.add(new StringValue(this, "insertTextFormat"), new IntegerValue(this, insertTextFormat));
        completions.add(item);
    }

    private static String formatLabel(final String prefix, final String localPart, final int arity) {
        if (prefix != null && !prefix.isEmpty()) {
            return prefix + ":" + localPart + "#" + arity;
        }
        return localPart + "#" + arity;
    }

    private static String formatInsertText(final String prefix, final String localPart) {
        final StringBuilder sb = new StringBuilder();
        if (prefix != null && !prefix.isEmpty()) {
            sb.append(prefix).append(':');
        }
        sb.append(localPart).append('(');
        sb.append(')');
        return sb.toString();
    }

    private static String formatQName(final QName name) {
        final String prefix = name.getPrefix();
        if (prefix != null && !prefix.isEmpty()) {
            return prefix + ":" + name.getLocalPart();
        }
        return name.getLocalPart();
    }
}
