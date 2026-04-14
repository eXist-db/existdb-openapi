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

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.exist.xquery.XQueryContext;
import org.exist.xquery.value.Sequence;

import javax.annotation.Nullable;
import java.util.concurrent.TimeUnit;

/**
 * Server-side cursor store for query results.
 *
 * <p>Holds live {@link Sequence} references in a Caffeine cache, allowing
 * clients to paginate through query results without re-executing the query
 * or serializing the entire result set upfront.</p>
 *
 * <p>The store is a singleton shared across all XQuery contexts within the
 * same eXist-db instance. It is configured at module initialization time
 * via {@link #configure(long, long, long)}.</p>
 *
 * <h3>Eviction policies</h3>
 * <ul>
 *   <li><b>Time-based</b>: cursors expire after a configurable period of
 *       inactivity ({@code cursor.expireAfterAccess}, default 5 minutes)</li>
 *   <li><b>Count-based</b>: at most N concurrent cursors
 *       ({@code cursor.maximumSize}, default 100, LRU eviction)</li>
 *   <li><b>Weight-based</b>: optional total memory budget across all cursors
 *       ({@code cursor.maximumWeight}, default unlimited). Each cursor's
 *       weight is estimated as {@code itemCount × 1024} bytes.</li>
 * </ul>
 *
 * <p>When a cursor is evicted (by any policy) or explicitly closed, its
 * eval context cleanup tasks are run to release broker resources.</p>
 */
public final class CursorStore {

    private static final Logger logger = LogManager.getLogger(CursorStore.class);

    /** Estimated memory per result item for weight calculation (1 KB). */
    private static final long ESTIMATED_BYTES_PER_ITEM = 1024;

    private static final long DEFAULT_MAXIMUM_SIZE = 100;
    private static final long DEFAULT_EXPIRE_AFTER_ACCESS_MS = 300_000; // 5 min

    private static final CursorStore INSTANCE = new CursorStore();

    private volatile Cache<String, CursorEntry> store;

    private CursorStore() {
        // Initialize with defaults; configure() may replace this later
        store = buildCache(DEFAULT_MAXIMUM_SIZE, DEFAULT_EXPIRE_AFTER_ACCESS_MS, 0);
    }

    public static CursorStore getInstance() {
        return INSTANCE;
    }

    /**
     * (Re)configure the cursor store. Called from {@link LspModule} constructor
     * when module parameters are available.
     *
     * @param maximumSize max concurrent cursors (0 = unlimited count)
     * @param expireAfterAccessMs inactivity timeout in milliseconds
     * @param maximumWeight max total estimated memory in bytes (0 = unlimited)
     */
    public static void configure(final long maximumSize, final long expireAfterAccessMs,
                                  final long maximumWeight) {
        // Invalidate all existing cursors before replacing the cache
        INSTANCE.store.invalidateAll();
        INSTANCE.store = buildCache(maximumSize, expireAfterAccessMs, maximumWeight);
    }

    private static Cache<String, CursorEntry> buildCache(final long maximumSize,
                                                          final long expireAfterAccessMs,
                                                          final long maximumWeight) {
        final Caffeine<Object, Object> builder = Caffeine.newBuilder()
                .expireAfterAccess(expireAfterAccessMs, TimeUnit.MILLISECONDS)
                .removalListener((key, value, cause) -> {
                    logger.debug("Cursor {} evicted ({})", key, cause);
                    if (value instanceof CursorEntry entry && entry.evalContext() != null) {
                        entry.evalContext().runCleanupTasks();
                    }
                });

        if (maximumWeight > 0) {
            // Weight-based eviction: each cursor's weight = itemCount * estimated bytes per item
            builder.maximumWeight(maximumWeight)
                    .weigher((key, value) -> {
                        if (value instanceof CursorEntry entry) {
                            return (int) Math.min(
                                    (long) entry.itemCount() * ESTIMATED_BYTES_PER_ITEM,
                                    Integer.MAX_VALUE);
                        }
                        return 1;
                    });
        } else if (maximumSize > 0) {
            builder.maximumSize(maximumSize);
        }

        return builder.build();
    }

    /**
     * Store a result sequence and return the cursor ID.
     * The evalContext is kept alive so that node references in the sequence
     * remain valid across fetch requests.
     */
    public String put(final String cursorId, final Sequence result, final int itemCount,
                      final XQueryContext evalContext) {
        store.put(cursorId, new CursorEntry(result, itemCount, evalContext));
        logger.debug("Cursor {} stored ({} items)", cursorId, itemCount);
        return cursorId;
    }

    /**
     * Retrieve a cursor entry by ID.
     */
    @Nullable
    public CursorEntry get(final String cursorId) {
        return store.getIfPresent(cursorId);
    }

    /**
     * Explicitly remove a cursor (client-initiated close).
     *
     * @return true if the cursor existed and was removed, false if not found
     */
    public boolean remove(final String cursorId) {
        final boolean existed = store.getIfPresent(cursorId) != null;
        store.invalidate(cursorId);
        logger.debug("Cursor {} closed (found={})", cursorId, existed);
        return existed;
    }

    /**
     * A cached cursor entry holding the result sequence, metadata,
     * and the eval context (kept alive so node references remain valid).
     */
    public record CursorEntry(Sequence result, int itemCount, XQueryContext evalContext) {
    }
}
