package org.aerie.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Atomic, app-private handoff between ShareActivity and ShareUploadWorker. */
final class ShareBatch {
    private static final int MAX_MANIFEST_BYTES = 256 * 1024;
    static final long MAX_AGE_MS = 7L * 24L * 60L * 60L * 1000L;
    private ShareBatch() { }

    static String newId() { return UUID.randomUUID().toString(); }

    static File root(Context context) {
        File root = new File(context.getFilesDir(), "share-staging");
        if (!root.exists()) root.mkdirs();
        return root;
    }

    static File directory(Context context, String id) throws Exception {
        if (id == null || !id.matches("^[a-f0-9-]{36}$")) throw new Exception("invalid_share_batch");
        File root = root(context).getCanonicalFile();
        File dir = new File(root, id).getCanonicalFile();
        if (!root.equals(dir.getParentFile())) throw new Exception("invalid_share_batch");
        return dir;
    }

    static synchronized void write(Context context, String id, JSONObject manifest) throws Exception {
        File dir = directory(context, id);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("share_staging_unavailable");
        byte[] bytes = manifest.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_MANIFEST_BYTES) throw new Exception("share_manifest_too_large");
        File temp = new File(dir, "manifest.json.tmp");
        File target = new File(dir, "manifest.json");
        try (FileOutputStream output = new FileOutputStream(temp, false)) {
            output.write(bytes);
            output.getFD().sync();
        }
        if (target.exists() && !target.delete()) throw new Exception("share_manifest_replace_failed");
        if (!temp.renameTo(target)) throw new Exception("share_manifest_commit_failed");
    }

    static synchronized JSONObject read(Context context, String id) throws Exception {
        File file = new File(directory(context, id), "manifest.json");
        if (!file.isFile() || file.length() <= 0 || file.length() > MAX_MANIFEST_BYTES)
            throw new Exception("share_manifest_missing");
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int count; (count = input.read(buffer)) >= 0; ) {
                if (count <= 0) continue;
                if (count > MAX_MANIFEST_BYTES - output.size()) throw new Exception("share_manifest_too_large");
                output.write(buffer, 0, count);
            }
            JSONObject result = new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
            if (result.optInt("schemaVersion", 0) != 1 || !id.equals(result.optString("id")))
                throw new Exception("invalid_share_manifest");
            return result;
        }
    }

    static void remove(Context context, String id) {
        try { removeTree(directory(context, id)); } catch (Exception ignored) { }
    }

    static void pruneStale(Context context) {
        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        File[] batches = root(context).listFiles();
        if (batches == null) return;
        for (File batch : batches) {
            if (!batch.isDirectory() || !batch.getName().matches("^[a-f0-9-]{36}$")) continue;
            if (batch.lastModified() > 0 && batch.lastModified() < cutoff) removeTree(batch);
        }
    }

    private static void removeTree(File file) {
        File[] children = file.isDirectory() ? file.listFiles() : null;
        if (children != null) for (File child : children) removeTree(child);
        file.delete();
    }
}
