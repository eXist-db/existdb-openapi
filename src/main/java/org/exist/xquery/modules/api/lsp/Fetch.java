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

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.dom.persistent.NodeProxy;
import org.exist.xquery.BasicFunction;
import org.exist.xquery.FunctionSignature;
import org.exist.xquery.XPathException;
import org.exist.xquery.XQueryContext;
import org.exist.xquery.functions.array.ArrayType;
import org.exist.xquery.functions.map.MapType;
import org.exist.xquery.value.IntegerValue;
import org.exist.xquery.value.Item;
import org.exist.xquery.value.Sequence;
import org.exist.xquery.value.StringValue;
import org.exist.xquery.value.Type;

import org.w3c.dom.Node;

import java.io.StringWriter;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

import static org.exist.xquery.FunctionDSL.*;

/**
 * Fetches a page of results from a server-side cursor created by {@link Eval}.
 *
 * <p>Returns an array of maps, where each map contains:</p>
 * <ul>
 *   <li>{@code value} — serialized string representation of the item</li>
 *   <li>{@code type} — XDM type name (e.g., "element()", "xs:integer")</li>
 *   <li>{@code documentURI} — path to the source document in the database
 *       (only for persistent database nodes; empty string otherwise)</li>
 *   <li>{@code nodeId} — internal node ID within the document
 *       (only for persistent database nodes; empty string otherwise)</li>
 * </ul>
 *
 * <p>Only the requested items are serialized — items outside the page
 * remain as live node references in the cursor.</p>
 *
 * <p>An optional 4th argument accepts a map of
 * <a href="https://qt4cg.org/specifications/xslt-xquery-serialization-40/Overview.html">
 * serialization parameters</a> (e.g., {@code map { "method": "xml", "indent": "no" }}).
 * Defaults to {@code method=adaptive, indent=yes}.</p>
 */
public class Fetch extends BasicFunction {

    private static final Logger logger = LogManager.getLogger(Fetch.class);

    private static final String FS_FETCH_NAME = "fetch";
    private static final String FS_FETCH_DESCRIPTION = """
            Retrieves a page of results from a cursor created by lsp:eval(). \
            Only the requested items are serialized; the rest remain as live references. \
            Returns an array of maps with keys: value (xs:string, serialized item), \
            type (xs:string, XDM type), documentURI (xs:string, source document path or ""), \
            and nodeId (xs:string, internal node ID or ""). \
            An optional 4th argument accepts a map of W3C serialization parameters \
            (e.g., map { "method": "xml", "indent": "no" }). \
            Defaults to method=adaptive, indent=yes.""";

    public static final FunctionSignature[] FS_FETCH = functionSignatures(
            LspModule.qname(FS_FETCH_NAME),
            FS_FETCH_DESCRIPTION,
            returns(Type.ARRAY_ITEM, "an array of result item maps"),
            arities(
                    arity(
                            param("cursor", Type.STRING, "The cursor ID returned by lsp:eval()."),
                            param("start", Type.INTEGER, "1-based start position."),
                            param("count", Type.INTEGER, "Number of items to retrieve.")
                    ),
                    arity(
                            param("cursor", Type.STRING, "The cursor ID returned by lsp:eval()."),
                            param("start", Type.INTEGER, "1-based start position."),
                            param("count", Type.INTEGER, "Number of items to retrieve."),
                            param("serialization", Type.MAP_ITEM, "Serialization parameters map. " +
                                    "Supports all W3C serialization parameters: method, indent, " +
                                    "omit-xml-declaration, encoding, media-type, item-separator, etc. " +
                                    "Also supports eXist-specific: highlight-matches (boolean). " +
                                    "Defaults: method=adaptive, indent=yes.")
                    )
            )
    );

    public Fetch(final XQueryContext context, final FunctionSignature signature) {
        super(context, signature);
    }

    @Override
    public Sequence eval(final Sequence[] args, final Sequence contextSequence) throws XPathException {
        final String cursorId = args[0].getStringValue();
        final int start = ((IntegerValue) args[1].itemAt(0)).getInt();
        final int count = ((IntegerValue) args[2].itemAt(0)).getInt();

        // Build serialization properties from optional 4th argument or defaults
        final Properties serProps = new Properties();
        serProps.setProperty("method", "adaptive");
        serProps.setProperty("indent", "yes");
        boolean highlightMatches = false;

        if (getArgumentCount() == 4 && args[3].hasOne()) {
            final MapType optionsMap = (MapType) args[3].itemAt(0);
            for (final var entry : optionsMap) {
                final String key = entry.key().getStringValue();
                final String val = entry.value().getStringValue();
                if ("highlight-matches".equals(key)) {
                    highlightMatches = "yes".equals(val) || "true".equals(val) || "both".equals(val);
                } else {
                    serProps.setProperty(key, val);
                }
            }
        }

        final CursorStore.CursorEntry entry = CursorStore.getInstance().get(cursorId);
        if (entry == null) {
            throw new XPathException(this, "Cursor not found or expired: " + cursorId);
        }

        final Sequence result = entry.result();
        final int total = entry.itemCount();
        final int actualStart = Math.max(1, start);
        final int actualEnd = Math.min(actualStart + count - 1, total);

        logger.debug("lsp:fetch cursor={} start={} count={} (total={})", cursorId, actualStart, count, total);

        final List<Sequence> items = new ArrayList<>();

        for (int i = actualStart; i <= actualEnd; i++) {
            final Item item = result.itemAt(i - 1); // 0-based internal index
            final MapType map = new MapType(this, context);

            // Serialize just this one item
            final String serialized = serializeItem(item, serProps, highlightMatches);
            map.add(new StringValue(this, "value"), new StringValue(this, serialized));

            // Type info
            map.add(new StringValue(this, "type"),
                    new StringValue(this, Type.getTypeName(item.getType())));

            // Document URI and node ID (only for persistent database nodes)
            String documentURI = "";
            String nodeId = "";
            if (item instanceof Node) {
                try {
                    if (item instanceof NodeProxy proxy) {
                        final String docUri = proxy.getOwnerDocument().getDocumentURI();
                        if (docUri != null) {
                            documentURI = docUri;
                        }
                        nodeId = proxy.getNodeId().toString();
                    }
                } catch (final Exception e) {
                    logger.debug("Could not extract document info for item {}: {}", i, e.getMessage());
                }
            }
            map.add(new StringValue(this, "documentURI"), new StringValue(this, documentURI));
            map.add(new StringValue(this, "nodeId"), new StringValue(this, nodeId));

            items.add(map);
        }

        return new ArrayType(this, context, items);
    }

    /**
     * Serialize a single item using the given serialization properties.
     *
     * <p>For persistent database nodes, uses the broker's serializer which
     * supports highlight-matches expansion. For in-memory nodes, uses
     * XQuerySerializer. For atomic values, returns the string value directly.</p>
     */
    private String serializeItem(final Item item, final Properties props,
                                  final boolean highlightMatches) throws XPathException {
        try {
            if (item instanceof NodeProxy proxy) {
                // Persistent database node — use the broker's serializer
                // which supports highlight-matches and full serialization params
                final StringWriter writer = new StringWriter();
                final org.exist.storage.serializers.Serializer serializer =
                        context.getBroker().borrowSerializer();
                try {
                    serializer.setProperties(props);
                    if (highlightMatches) {
                        serializer.setProperty(
                                org.exist.storage.serializers.EXistOutputKeys.HIGHLIGHT_MATCHES,
                                "both");
                    }
                    serializer.serialize(proxy, writer);
                } finally {
                    context.getBroker().returnSerializer(serializer);
                }
                return writer.toString();
            } else if (item instanceof org.exist.dom.memtree.NodeImpl) {
                // In-memory constructed node — serialize via XQuerySerializer
                final StringWriter writer = new StringWriter();
                final org.exist.util.serializer.XQuerySerializer xqs =
                        new org.exist.util.serializer.XQuerySerializer(
                                context.getBroker(), props, writer);
                xqs.serialize(item.toSequence());
                return writer.toString();
            } else {
                // Atomic value — delegate to XQuerySerializer (which uses AdaptiveWriter
                // for method=adaptive). AdaptiveWriter correctly implements W3C adaptive
                // serialization for all atomic types: xs:string/xs:anyURI/xs:untypedAtomic
                // and all string subtypes are double-quoted with internal quotes doubled;
                // xs:integer/xs:decimal are bare numbers; xs:boolean uses true()/false();
                // xs:double uses exponential notation; all other types use typename("value").
                final StringWriter writer = new StringWriter();
                final org.exist.util.serializer.XQuerySerializer xqs =
                        new org.exist.util.serializer.XQuerySerializer(
                                context.getBroker(), props, writer);
                xqs.serialize(item.toSequence());
                return writer.toString();
            }
        } catch (final Exception e) {
            return item.getStringValue();
        }
    }
}
