package org.aerie.app;

import android.content.Context;

import androidx.media3.common.util.UnstableApi;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** Account-isolated playback cache shared by native media and Android Auto. */
@UnstableApi
final class NativeMediaCache {
    private static final long MAX_CACHE_BYTES = 2L * 1024L * 1024L * 1024L;
    private static SimpleCache cache;
    private static String cacheScope;

    private NativeMediaCache() { }

    static synchronized DataSource.Factory factory(Context context, DataSource.Factory upstream) {
        Context app = context.getApplicationContext();
        String scope = DocumentGrantScope.current(app);
        if (cache == null || !scope.equals(cacheScope)) {
            if (cache != null) {
                try { cache.release(); } catch (Exception ignored) { }
            }
            File root = new File(app.getFilesDir(), "media-cache");
            File directory = new File(root, scope);
            if (!directory.exists()) directory.mkdirs();
            // Logging out rotates the account scope. Once no player owns the
            // prior cache, remove its private bytes instead of accumulating a
            // 2 GiB cache for every account ever used on the phone.
            File[] oldScopes = root.listFiles();
            if (oldScopes != null) for (File old : oldScopes) {
                if (old.isDirectory() && !old.equals(directory)) removeTree(old);
            }
            cache = new SimpleCache(directory, new LeastRecentlyUsedCacheEvictor(MAX_CACHE_BYTES),
                    new StandaloneDatabaseProvider(app));
            cacheScope = scope;
        }
        return new CacheDataSource.Factory().setCache(cache).setUpstreamDataSourceFactory(upstream)
                .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
    }

    /** Server-independent identity means LAN/cloud failover reuses cached bytes. */
    static String cacheKey(Context context, String mediaId, String streamPath) {
        String material = DocumentGrantScope.current(context) + "\n" + value(mediaId) + "\n" + value(streamPath);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(material.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(64);
            for (byte part : digest) out.append(String.format(Locale.US, "%02x", part & 0xff));
            return "aerie-media-v1-" + out;
        } catch (Exception impossible) {
            return "aerie-media-v1-" + Integer.toHexString(material.hashCode());
        }
    }

    private static String value(String value) { return value == null ? "" : value; }

    private static void removeTree(File file) {
        File[] children = file.isDirectory() ? file.listFiles() : null;
        if (children != null) for (File child : children) removeTree(child);
        file.delete();
    }
}
