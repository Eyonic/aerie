package org.aerie.app;

import android.app.job.JobScheduler;
import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.webkit.MimeTypeMap;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Locale;
import java.util.Calendar;
import java.util.concurrent.TimeUnit;

public class SyncEngine {
    static final int JOB_ID = 44012;
    private static final String WORK_NAME = "aerie-nightly-folder-sync";
    private static final long MAX_FILE = 2L * 1024L * 1024L * 1024L;
    private final Context context;
    private final SharedPreferences prefs;
    private volatile boolean cancelled;
    private long deadlineMs;
    private ProgressListener progressListener;

    interface ProgressListener {
        void onProgress(String folder, int done, int total);
    }

    SyncEngine(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
    }

    void cancel() {
        cancelled = true;
    }

    void setDeadlineMs(long deadlineMs) {
        this.deadlineMs = deadlineMs;
    }

    void setProgressListener(ProgressListener progressListener) {
        this.progressListener = progressListener;
    }

    static void schedule(Context context) {
        try {
            SharedPreferences p = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
            WorkManager wm = WorkManager.getInstance(context.getApplicationContext());
            if (new JSONArray(p.getString("sync_folders", "[]")).length() == 0) {
                wm.cancelUniqueWork(WORK_NAME);
                return;
            }
            // Cancel the old raw JobScheduler entry when upgrading from 1.2.
            JobScheduler legacy = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (legacy != null) legacy.cancel(JOB_ID);

            Constraints constraints = new Constraints.Builder()
                    .setRequiresCharging(true)
                    .setRequiredNetworkType(NetworkType.UNMETERED)
                    .build();
            long delay = delayUntilNextNight();
            PeriodicWorkRequest work = new PeriodicWorkRequest.Builder(SyncWorker.class, 24, TimeUnit.HOURS)
                    .setInitialDelay(delay, TimeUnit.MILLISECONDS)
                    .setConstraints(constraints)
                    .addTag(WORK_NAME)
                    .build();
            // UPDATE preserves the original enqueue time while repairing the
            // constraints and schedule of older installed versions. KEEP left
            // some phones attached to a stale one-shot/old periodic job.
            wm.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, work);
            p.edit().putLong("sync_next_run", System.currentTimeMillis() + delay).apply();
        } catch (Exception e) {
            context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit()
                    .putString("sync_last_result", "schedule_failed").apply();
        }
    }

    private static long delayUntilNextNight() {
        Calendar now = Calendar.getInstance();
        Calendar next = (Calendar) now.clone();
        next.set(Calendar.HOUR_OF_DAY, 2);
        next.set(Calendar.MINUTE, 0);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (!next.after(now)) next.add(Calendar.DAY_OF_YEAR, 1);
        return Math.max(0, next.getTimeInMillis() - now.getTimeInMillis());
    }

    static JSONArray folders(Context context) {
        try {
            return new JSONArray(context.getSharedPreferences("aerie", Context.MODE_PRIVATE).getString("sync_folders", "[]"));
        } catch (Exception e) { return new JSONArray(); }
    }

    static String listJson(Context context) {
        try {
            JSONObject o = new JSONObject();
            o.put("folders", folders(context));
            return o.toString();
        } catch (Exception e) { return "{\"folders\":[]}"; }
    }

    static String statusJson(Context context) {
        try {
            SharedPreferences p = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
            JSONObject o = new JSONObject();
            o.put("running", p.getBoolean("sync_running", false));
            o.put("lastRun", p.getLong("sync_last_run", 0));
            o.put("lastResult", p.getString("sync_last_result", ""));
            o.put("nextRun", p.getLong("sync_next_run", 0));
            String progress = p.getString("sync_progress", null);
            if (progress != null && !progress.isEmpty()) o.put("progress", new JSONObject(progress));
            o.put("folders", folders(context));
            return o.toString();
        } catch (Exception e) { return "{\"running\":false,\"folders\":[]}"; }
    }

    static void remove(Context context, String uri) {
        try {
            JSONArray in = folders(context);
            JSONArray out = new JSONArray();
            for (int i = 0; i < in.length(); i++) {
                JSONObject f = in.getJSONObject(i);
                if (!uri.equals(f.optString("uri"))) out.put(f);
            }
            context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit().putString("sync_folders", out.toString()).apply();
        } catch (Exception ignored) { }
    }

    static void addTree(Context context, Uri uri, String label) {
        try {
            JSONArray arr = folders(context);
            for (int i = 0; i < arr.length(); i++) {
                if (uri.toString().equals(arr.getJSONObject(i).optString("uri"))) return;
            }
            String base = label == null || label.trim().isEmpty() ? "Folder" : label.trim();
            HashSet<String> used = new HashSet<>();
            for (int i = 0; i < arr.length(); i++) used.add(arr.getJSONObject(i).optString("label"));
            String out = base;
            int n = 2;
            while (used.contains(out)) out = base + " (" + (n++) + ")";
            JSONObject f = new JSONObject();
            f.put("uri", uri.toString());
            f.put("label", out);
            arr.put(f);
            context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit().putString("sync_folders", arr.toString()).apply();
            schedule(context);
        } catch (Exception ignored) { }
    }

    boolean runOnce(String activeBase) {
        prefs.edit().putBoolean("sync_running", true).remove("sync_progress").apply();
        int uploaded = 0;
        try {
            String server = normalize(activeBase);
            if (server == null) server = normalize(prefs.getString("active_base", null));
            if (server == null) server = normalize(prefs.getString("url", null));
            String token = prefs.getString("token", null);
            if (server == null || token == null || token.isEmpty()) return finish("not_configured", false);
            JSONArray dirs = folders(context);
            ArrayList<WorkFolder> work = new ArrayList<>();
            int total = 0;
            for (int i = 0; i < dirs.length(); i++) {
                throwIfStopped();
                JSONObject f = dirs.getJSONObject(i);
                String label = f.optString("label", "Phone");
                ArrayList<FileItem> files = new ArrayList<>();
                walk(Uri.parse(f.optString("uri")), "", files);
                JSONArray payload = new JSONArray();
                for (FileItem item : files) {
                    JSONObject o = new JSONObject();
                    o.put("rel", item.rel);
                    o.put("size", item.size);
                    o.put("mtimeMs", item.mtimeMs);
                    payload.put(o);
                }
                String base = "Camera backup".equals(label)
                        ? "Photos/Camera/" + sanitize(Build.MODEL)
                        : "Sync/" + sanitize(Build.MODEL) + " " + sanitize(label);
                HashSet<String> needed = check(server, token, base, payload);
                WorkFolder wf = new WorkFolder(label, base);
                for (FileItem item : files) {
                    if (needed.contains(item.rel)) wf.files.add(item);
                }
                total += wf.files.size();
                work.add(wf);
            }
            updateProgress("", 0, total);
            for (WorkFolder wf : work) {
                for (FileItem item : wf.files) {
                    throwIfStopped();
                    updateProgress(wf.label, uploaded, total);
                    upload(server, token, wf.base, item);
                    uploaded++;
                    updateProgress(wf.label, uploaded, total);
                }
            }
            return finish("uploaded " + uploaded, false);
        } catch (Unauthorized e) {
            return finish("unauthorized", false);
        } catch (Stopped e) {
            return finish(cancelled ? "cancelled" : "deadline", true);
        } catch (Exception e) {
            return finish(e.getMessage() == null ? "sync_failed" : e.getMessage(), true);
        }
    }

    private boolean finish(String result, boolean needsMore) {
        Calendar next = Calendar.getInstance();
        next.add(Calendar.DAY_OF_YEAR, 1);
        next.set(Calendar.HOUR_OF_DAY, 2);
        next.set(Calendar.MINUTE, 0);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        prefs.edit()
                .putBoolean("sync_running", false)
                .putLong("sync_last_run", System.currentTimeMillis())
                .putLong("sync_next_run", next.getTimeInMillis())
                .putString("sync_last_result", result)
                .remove("sync_progress")
                .apply();
        return needsMore;
    }

    private void throwIfStopped() throws Stopped {
        if (cancelled || (deadlineMs > 0 && System.currentTimeMillis() > deadlineMs)) throw new Stopped();
    }

    private void updateProgress(String folder, int done, int total) {
        try {
            JSONObject o = new JSONObject();
            o.put("folder", folder == null ? "" : folder);
            o.put("done", done);
            o.put("total", total);
            prefs.edit().putString("sync_progress", o.toString()).apply();
            ProgressListener l = progressListener;
            if (l != null) l.onProgress(folder, done, total);
        } catch (Exception ignored) { }
    }

    private static String normalize(String u) {
        if (u == null) return null;
        u = u.trim().replaceAll("/+$", "");
        if (u.startsWith("http://") || u.startsWith("https://")) return u;
        return null;
    }

    private static String sanitize(String s) {
        s = s == null ? "Phone" : s.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return s.isEmpty() ? "Phone" : s;
    }

    private void walk(Uri tree, String prefix, ArrayList<FileItem> out) {
        try {
            String treeId = DocumentsContract.getTreeDocumentId(tree);
            Uri doc = prefix.isEmpty()
                    ? DocumentsContract.buildDocumentUriUsingTree(tree, treeId)
                    : null;
            if (doc == null) return;
            walkDoc(tree, doc, prefix, out);
        } catch (Exception ignored) { }
    }

    private void walkDoc(Uri tree, Uri doc, String prefix, ArrayList<FileItem> out) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(doc));
        Cursor c = null;
        try {
            c = context.getContentResolver().query(children,
                    new String[]{
                            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                            DocumentsContract.Document.COLUMN_SIZE,
                            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                            DocumentsContract.Document.COLUMN_MIME_TYPE
                    }, null, null, null);
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0);
                String name = c.getString(1);
                if (name == null || name.startsWith(".")) continue;
                long size = c.isNull(2) ? 0 : c.getLong(2);
                long modified = c.isNull(3) ? System.currentTimeMillis() : c.getLong(3);
                String mime = c.getString(4);
                Uri child = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                String rel = prefix.isEmpty() ? name : prefix + "/" + name;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) walkDoc(tree, child, rel, out);
                else if (size <= MAX_FILE) out.add(new FileItem(child, rel, size, modified, mime));
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
    }

    private HashSet<String> check(String server, String token, String base, JSONArray files) throws Exception {
        HashSet<String> out = new HashSet<>();
        for (int i = 0; i < files.length(); i += 5000) {
            JSONArray chunk = new JSONArray();
            for (int j = i; j < files.length() && j < i + 5000; j++) chunk.put(files.getJSONObject(j));
            out.addAll(checkChunk(server, token, base, chunk));
        }
        return out;
    }

    private HashSet<String> checkChunk(String server, String token, String base, JSONArray files) throws Exception {
        JSONObject body = new JSONObject();
        body.put("base", base);
        body.put("files", files);
        HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/sync/check").openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setDoOutput(true);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "application/json");
        byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
        c.getOutputStream().write(b);
        int code = c.getResponseCode();
        if (code == 401) throw new Unauthorized();
        if (code >= 300) throw new Exception("check_" + code);
        byte[] buf = readAll(c.getInputStream());
        c.disconnect();
        JSONArray arr = new JSONObject(new String(buf, StandardCharsets.UTF_8)).optJSONArray("needed");
        HashSet<String> set = new HashSet<>();
        if (arr != null) for (int i = 0; i < arr.length(); i++) set.add(arr.optString(i));
        return set;
    }

    private void upload(String server, String token, String base, FileItem item) throws Exception {
        String boundary = "AerieSync" + Long.toHexString(System.nanoTime());
        HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/sync/upload").openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(20000);
        c.setReadTimeout(120000);
        c.setDoOutput(true);
        c.setChunkedStreamingMode(64 * 1024);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        OutputStream raw = null;
        BufferedInputStream in = null;
        try {
            raw = new BufferedOutputStream(c.getOutputStream());
            field(raw, boundary, "base", base);
            field(raw, boundary, "rel", item.rel);
            field(raw, boundary, "mtimeMs", String.valueOf(item.mtimeMs));
            write(raw, "--" + boundary + "\r\n");
            String type = item.mime == null || item.mime.isEmpty() ? guess(item.rel) : item.mime;
            write(raw, "Content-Disposition: form-data; name=\"file\"; filename=\"" + item.rel.replace("\"", "_") + "\"\r\n");
            write(raw, "Content-Type: " + type + "\r\n\r\n");
            in = new BufferedInputStream(context.getContentResolver().openInputStream(item.uri));
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                throwIfStopped();
                raw.write(buf, 0, n);
            }
            in.close();
            in = null;
            write(raw, "\r\n--" + boundary + "--\r\n");
            raw.flush();
            raw.close();
            raw = null;
            int code = c.getResponseCode();
            if (code == 401) throw new Unauthorized();
            if (code >= 300) throw new Exception("upload_" + code);
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignored) { }
            try { if (raw != null) raw.close(); } catch (Exception ignored) { }
            c.disconnect();
        }
    }

    private static void field(OutputStream out, String boundary, String name, String value) throws Exception {
        write(out, "--" + boundary + "\r\n");
        write(out, "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
        write(out, value + "\r\n");
    }

    private static void write(OutputStream out, String s) throws Exception {
        out.write(s.getBytes(StandardCharsets.UTF_8));
    }

    private static String guess(String rel) {
        String ext = "";
        int i = rel.lastIndexOf('.');
        if (i >= 0) ext = rel.substring(i + 1).toLowerCase(Locale.ROOT);
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m == null ? "application/octet-stream" : m;
    }

    private static byte[] readAll(java.io.InputStream in) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }

    private static class FileItem {
        final Uri uri;
        final String rel;
        final long size;
        final long mtimeMs;
        final String mime;
        FileItem(Uri uri, String rel, long size, long mtimeMs, String mime) {
            this.uri = uri; this.rel = rel; this.size = size; this.mtimeMs = mtimeMs; this.mime = mime;
        }
    }

    private static class WorkFolder {
        final String label;
        final String base;
        final ArrayList<FileItem> files = new ArrayList<>();
        WorkFolder(String label, String base) {
            this.label = label; this.base = base;
        }
    }

    private static class Stopped extends Exception { }
    private static class Unauthorized extends Exception { }
}
