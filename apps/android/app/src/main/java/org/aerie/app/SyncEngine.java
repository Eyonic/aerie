package org.aerie.app;

import android.app.job.JobScheduler;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.webkit.MimeTypeMap;

import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Calendar;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class SyncEngine {
    static final int JOB_ID = 44012;
    private static final String PERIODIC_WORK_NAME = "aerie-nightly-folder-sync";
    private static final String MANUAL_WORK_NAME = "aerie-manual-folder-sync";
    static final String WORK_INPUT_MANUAL = "manual";
    static final String WORK_INPUT_BASE = "activeBase";
    private static final String FOLDER_HEALTH = "sync_folder_health_v1";
    private static final ReentrantLock RUN_LOCK = new ReentrantLock(true);
    private static volatile SyncEngine activeEngine;
    private static final long MAX_FILE = 20L * 1024L * 1024L * 1024L;
    private static final int UPLOAD_CHUNK = 8 * 1024 * 1024;
    private static final int FABRIC_PAGE = 250;
    private static final int IO_BUFFER = 64 * 1024;
    private static final int MAX_JSON_RESPONSE_BYTES = 32 * 1024 * 1024;
    private static final Pattern CONTENT_RANGE = Pattern.compile("^bytes (\\d+)-(\\d+)/(\\d+)$",
            Pattern.CASE_INSENSITIVE);
    private final Context context;
    private final SharedPreferences prefs;
    private volatile boolean cancelled;
    private boolean manualRun;
    private String runId;
    private long lastHeartbeatWrite;
    private long deadlineMs;
    private ProgressListener progressListener;
    private boolean resumableUploads;

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
            reconcileStaleRun(p);
            WorkManager wm = WorkManager.getInstance(context.getApplicationContext());
            if (new JSONArray(p.getString("sync_folders", "[]")).length() == 0) {
                wm.cancelUniqueWork(PERIODIC_WORK_NAME);
                wm.cancelUniqueWork(MANUAL_WORK_NAME);
                SyncEngine engine = activeEngine;
                if (engine != null) engine.cancel();
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
                    .addTag(PERIODIC_WORK_NAME)
                    .build();
            // UPDATE preserves the original enqueue time while repairing the
            // constraints and schedule of older installed versions. KEEP left
            // some phones attached to a stale one-shot/old periodic job.
            wm.enqueueUniquePeriodicWork(PERIODIC_WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, work);
            p.edit().putLong("sync_next_run", System.currentTimeMillis() + delay).apply();
        } catch (Exception e) {
            context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit()
                    .putString("sync_last_result", "schedule_failed").apply();
        }
    }

    /** Manual and periodic requests share SyncWorker and the same engine lock. */
    static void requestManual(Context context, String activeBase) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        Data.Builder input = new Data.Builder().putBoolean(WORK_INPUT_MANUAL, true);
        String preferred = ServerEndpointResolver.normalize(activeBase);
        if (preferred != null) input.putString(WORK_INPUT_BASE, preferred);
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(SyncWorker.class)
                .setInputData(input.build())
                .setConstraints(constraints)
                .addTag(MANUAL_WORK_NAME)
                .build();
        WorkManager.getInstance(context.getApplicationContext())
                .enqueueUniqueWork(MANUAL_WORK_NAME, ExistingWorkPolicy.KEEP, work);
    }

    static void cancelManual(Context context) {
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(MANUAL_WORK_NAME);
        SyncEngine engine = activeEngine;
        if (engine != null && engine.manualRun) engine.cancel();
    }

    private static void reconcileStaleRun(SharedPreferences prefs) {
        boolean running = prefs.getBoolean("sync_running", false);
        long heartbeat = prefs.getLong("sync_run_heartbeat", 0);
        if (!SyncFolderPolicy.staleRun(running, heartbeat, System.currentTimeMillis())) return;
        prefs.edit().putBoolean("sync_running", false)
                .putString("sync_last_result", "interrupted")
                .remove("sync_progress").remove("sync_run_id").remove("sync_run_heartbeat")
                .remove("sync_run_manual")
                .commit();
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
            SharedPreferences prefs = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
            JSONArray folders = new JSONArray(prefs.getString("sync_folders", "[]"));
            boolean migrated = false;
            for (int i = 0; i < folders.length(); i++) {
                JSONObject folder = folders.getJSONObject(i);
                String label = folder.optString("label", "Folder");
                if (!folder.has("camera") && "Camera backup".equals(label)) {
                    folder.put("camera", true);
                    migrated = true;
                }
                if (!folder.has("id")) {
                    folder.put("id", folderId(folder.optString("uri", label)));
                    migrated = true;
                }
                if (!folder.has("mode")) {
                    // Camera backup remains deliberately add-only. Ordinary
                    // document trees graduate to journaled two-way sync.
                    folder.put("mode", "Camera backup".equals(label) ? "backup" : "two");
                    migrated = true;
                }
                boolean camera = folder.optBoolean("camera", "Camera backup".equals(label));
                String remoteBase = folder.optString("remoteBase", "");
                if (!SyncFolderPolicy.validRemoteBase(remoteBase)) {
                    // Adopt the exact pre-upgrade location once. Recomputing a new
                    // device-suffixed base here would strand existing server data.
                    folder.put("remoteBase", SyncFolderPolicy.legacyRemoteBase(Build.MODEL, label, camera));
                    migrated = true;
                }
            }
            if (migrated) prefs.edit().putString("sync_folders", folders.toString()).apply();
            return folders;
        } catch (Exception e) { return new JSONArray(); }
    }

    static String listJson(Context context) {
        try {
            JSONObject o = new JSONObject();
            o.put("folders", foldersWithHealth(context));
            return o.toString();
        } catch (Exception e) { return "{\"folders\":[]}"; }
    }

    static String statusJson(Context context) {
        try {
            SharedPreferences p = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
            reconcileStaleRun(p);
            JSONObject o = new JSONObject();
            o.put("running", p.getBoolean("sync_running", false));
            o.put("manual", p.getBoolean("sync_run_manual", false));
            o.put("lastRun", p.getLong("sync_last_run", 0));
            o.put("lastResult", p.getString("sync_last_result", ""));
            o.put("nextRun", p.getLong("sync_next_run", 0));
            String progress = p.getString("sync_progress", null);
            if (progress != null && !progress.isEmpty()) o.put("progress", new JSONObject(progress));
            o.put("folders", foldersWithHealth(context));
            return o.toString();
        } catch (Exception e) { return "{\"running\":false,\"folders\":[]}"; }
    }

    static void remove(Context context, String uri) {
        try {
            JSONArray in = folders(context);
            JSONArray out = new JSONArray();
            String removedId = null;
            for (int i = 0; i < in.length(); i++) {
                JSONObject f = in.getJSONObject(i);
                if (!uri.equals(f.optString("uri"))) out.put(f);
                else removedId = f.optString("id", folderId(uri));
            }
            if (removedId == null) return;
            boolean saved = context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit()
                    .putString("sync_folders", out.toString()).commit();
            if (!saved) return;
            deleteFabricState(context, removedId);
            clearFolderHealth(context, removedId);
            releasePersistedAccess(context, Uri.parse(uri));
        } catch (Exception ignored) { }
    }

    /** @return null on success, otherwise an actionable machine-readable reason. */
    static String addTree(Context context, Uri uri, String label) {
        try {
            boolean camera = "Camera backup".equals(label);
            String mode = camera ? "backup" : "two";
            if (!hasPersistedAccess(context, uri, "two".equals(mode))) return "permission_required";
            JSONArray arr = folders(context);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject existing = arr.getJSONObject(i);
                if (uri.toString().equals(existing.optString("uri"))) {
                    clearFolderHealth(context, existing.optString("id", folderId(uri.toString())));
                    schedule(context);
                    return null;
                }
            }
            String base = label == null || label.trim().isEmpty() ? "Folder" : label.trim();
            HashSet<String> used = new HashSet<>();
            for (int i = 0; i < arr.length(); i++) used.add(arr.getJSONObject(i).optString("label"));
            String out = base;
            int n = 2;
            while (used.contains(out)) out = base + " (" + (n++) + ")";
            JSONObject f = new JSONObject();
            f.put("id", folderId(uri.toString()));
            f.put("uri", uri.toString());
            f.put("label", out);
            f.put("mode", mode);
            f.put("camera", camera);
            f.put("remoteBase", SyncFolderPolicy.newRemoteBase(Build.MODEL, out, camera,
                    stableDeviceId(context)));
            arr.put(f);
            if (!context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit()
                    .putString("sync_folders", arr.toString()).commit()) return "folder_add_failed";
            schedule(context);
            return null;
        } catch (Exception ignored) { return "folder_add_failed"; }
    }

    private static JSONArray foldersWithHealth(Context context) throws Exception {
        JSONArray source = folders(context);
        JSONObject health = folderHealth(context);
        JSONArray out = new JSONArray();
        for (int i = 0; i < source.length(); i++) {
            JSONObject folder = new JSONObject(source.getJSONObject(i).toString());
            JSONObject item = health.optJSONObject(folder.optString("id"));
            if (item != null) folder.put("health", new JSONObject(item.toString()));
            out.put(folder);
        }
        return out;
    }

    private static synchronized JSONObject folderHealth(Context context) {
        try {
            return new JSONObject(context.getSharedPreferences("aerie", Context.MODE_PRIVATE)
                    .getString(FOLDER_HEALTH, "{}"));
        } catch (Exception ignored) { return new JSONObject(); }
    }

    private static synchronized void setFolderHealth(Context context, String id, String state,
                                                     String message, int skippedLarge,
                                                     boolean incomplete, boolean success) {
        try {
            JSONObject all = folderHealth(context);
            JSONObject item = new JSONObject().put("state", state)
                    .put("message", message == null ? "" : message)
                    .put("lastRun", System.currentTimeMillis())
                    .put("skippedLarge", Math.max(0, skippedLarge))
                    .put("incomplete", incomplete);
            JSONObject prior = all.optJSONObject(id);
            if (success) item.put("lastSuccess", System.currentTimeMillis());
            else if (prior != null && prior.has("lastSuccess")) item.put("lastSuccess", prior.optLong("lastSuccess"));
            all.put(id, item);
            context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit()
                    .putString(FOLDER_HEALTH, all.toString()).apply();
        } catch (Exception ignored) { }
    }

    private static synchronized void clearFolderHealth(Context context, String id) {
        try {
            JSONObject all = folderHealth(context);
            all.remove(id);
            context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit()
                    .putString(FOLDER_HEALTH, all.toString()).apply();
        } catch (Exception ignored) { }
    }

    static boolean hasPersistedAccess(Context context, Uri uri, boolean requireWrite) {
        if (uri == null) return false;
        try {
            for (UriPermission permission : context.getContentResolver().getPersistedUriPermissions()) {
                if (!uri.equals(permission.getUri())) continue;
                return SyncFolderPolicy.accessSatisfies(permission.isReadPermission(),
                        permission.isWritePermission(), requireWrite ? "two" : "backup");
            }
        } catch (Exception ignored) { }
        return false;
    }

    private static void releasePersistedAccess(Context context, Uri uri) {
        try {
            for (UriPermission permission : context.getContentResolver().getPersistedUriPermissions()) {
                if (!uri.equals(permission.getUri())) continue;
                int flags = (permission.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0)
                        | (permission.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
                if (flags != 0) context.getContentResolver().releasePersistableUriPermission(uri, flags);
                return;
            }
        } catch (Exception ignored) { }
    }

    private static String stableDeviceId(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
        String stored = prefs.getString("sync_device_id", null);
        String chosen = SyncJournal.selectStableDeviceId(stored,
                prefs.getString("trusted_device_id", null), "android-" + UUID.randomUUID());
        if (!chosen.equals(stored) && !prefs.edit().putString("sync_device_id", chosen).commit())
            throw new Exception("sync_device_identity_unavailable");
        return chosen;
    }

    boolean runOnce(String activeBase) { return runOnce(activeBase, false); }

    boolean runOnce(String activeBase, boolean manual) {
        // WorkManager may dispatch periodic and manual requests together. Only the
        // holder mutates SAF trees or cursor files; the other request retries.
        if (!RUN_LOCK.tryLock()) return true;
        manualRun = manual;
        activeEngine = this;
        runId = UUID.randomUUID().toString();
        lastHeartbeatWrite = System.currentTimeMillis();
        prefs.edit().putBoolean("sync_running", true).putBoolean("sync_run_manual", manual)
                .putString("sync_run_id", runId)
                .putLong("sync_run_heartbeat", lastHeartbeatWrite).remove("sync_progress").commit();
        SyncStats totals = new SyncStats();
        try {
            EndpointSelection endpoint = selectEndpoint(activeBase);
            if (endpoint == null) return finish("not_configured", false);
            String server = endpoint.server;
            String token = endpoint.token;
            boolean fabric = endpoint.fabric;
            resumableUploads = endpoint.resumable;
            JSONArray dirs = folders(context);
            ArrayList<WorkFolder> work = new ArrayList<>();
            int legacyTotal = 0;
            int permissionIssues = 0;
            boolean retryNeeded = false;
            for (int i = 0; i < dirs.length(); i++) {
                throwIfStopped();
                JSONObject f = dirs.getJSONObject(i);
                String label = f.optString("label", "Phone");
                boolean camera = f.optBoolean("camera", "Camera backup".equals(label));
                String mode = f.optString("mode", camera ? "backup" : "two");
                String id = f.optString("id", folderId(f.optString("uri", label)));
                Uri tree = Uri.parse(f.optString("uri"));
                if (!hasPersistedAccess(context, tree, "two".equals(mode))) {
                    setFolderHealth(context, id, "permission_required",
                            "Grant folder access again to resume sync", 0, true, false);
                    permissionIssues++;
                    continue;
                }
                String base = f.optString("remoteBase", "");
                if (!SyncFolderPolicy.validRemoteBase(base)) {
                    setFolderHealth(context, id, "error", "Invalid remote folder", 0, true, false);
                    retryNeeded = true;
                    continue;
                }
                setFolderHealth(context, id, "syncing", "Sync in progress", 0, false, false);
                try {
                    if (fabric && "two".equals(mode) && !camera) {
                        work.add(new WorkFolder(label, base, f, null, false));
                        continue;
                    }

                    // Camera and explicit backup folders remain add-only even on a
                    // Fabric v2 server. Missing phone files never become tombstones.
                    ScanResult scan = scan(tree);
                    JSONArray payload = new JSONArray();
                    for (FileItem item : scan.files) if (!item.tooLarge) payload.put(new JSONObject()
                            .put("rel", item.rel).put("size", item.size).put("mtimeMs", item.mtimeMs));
                    HashSet<String> needed = check(server, token, base, payload);
                    WorkFolder wf = new WorkFolder(label, base, f, scan, camera);
                    for (FileItem item : scan.files) if (!item.tooLarge && needed.contains(item.rel)) wf.files.add(item);
                    legacyTotal += wf.files.size();
                    work.add(wf);
                } catch (Unauthorized | Stopped critical) {
                    throw critical;
                } catch (Exception error) {
                    setFolderHealth(context, id, "error", resultCode(error), 0, true, false);
                    retryNeeded = true;
                }
            }

            int legacyDone = 0;
            updateProgress("", 0, legacyTotal);
            for (WorkFolder wf : work) {
                String id = wf.config.optString("id", folderId(wf.config.optString("uri", wf.label)));
                try {
                    SyncStats folderStats = new SyncStats();
                    if (fabric && wf.scan == null && !wf.camera) {
                        folderStats = syncFabricFolder(server, token, wf);
                    } else {
                        if (wf.scan != null) {
                            folderStats.incomplete = !wf.scan.complete;
                            for (FileItem item : wf.scan.files) if (item.tooLarge) folderStats.skippedLarge++;
                        }
                        for (FileItem item : wf.files) {
                            throwIfStopped();
                            updateProgress(wf.label, legacyDone, legacyTotal);
                            upload(server, token, wf.base, item);
                            legacyDone++;
                            folderStats.uploaded++;
                            updateProgress(wf.label, legacyDone, legacyTotal);
                        }
                    }
                    totals.add(folderStats);
                    boolean warning = folderStats.incomplete || folderStats.skippedLarge > 0;
                    String message = warning
                            ? (folderStats.skippedLarge > 0 ? folderStats.skippedLarge + " oversized file(s) skipped"
                            : "Some folders could not be read")
                            : folderSummary(folderStats);
                    setFolderHealth(context, id, warning ? "warning" : "ok", message,
                            folderStats.skippedLarge, folderStats.incomplete, true);
                } catch (Unauthorized | Stopped critical) {
                    throw critical;
                } catch (Exception error) {
                    setFolderHealth(context, id, "error", resultCode(error), 0, true, false);
                    retryNeeded = true;
                }
            }
            if (retryNeeded) return finish("sync_incomplete", true);
            if (permissionIssues > 0) return finish("attention_required", false);
            if (totals.downloaded == 0 && totals.deleted == 0 && totals.conflicts == 0)
                return finish("uploaded " + totals.uploaded, false);
            return finish("synced " + totals.uploaded + " up, " + totals.downloaded + " down, "
                    + totals.deleted + " removed, " + totals.conflicts + " conflicts", false);
        } catch (Unauthorized e) {
            // WorkManager retries under the same network constraints; the device
            // challenge flow gets another chance without overlapping this run.
            return finish("unauthorized", true);
        } catch (Stopped e) {
            return finish(cancelled ? "cancelled" : "deadline", !cancelled);
        } catch (Exception e) {
            return finish(resultCode(e), true);
        } finally {
            if (activeEngine == this) activeEngine = null;
            RUN_LOCK.unlock();
        }
    }

    private EndpointSelection selectEndpoint(String preferred) throws Exception {
        List<String> candidates = ServerEndpointResolver.candidates(context, preferred);
        if (candidates.isEmpty()) return null;
        Exception last = null;
        Unauthorized unauthorized = null;
        boolean hadToken = false;
        for (String server : candidates) {
            throwIfStopped();
            String token = DeviceAuthClient.validToken(context, server);
            if (token == null || token.isEmpty()) continue;
            hadToken = true;
            try {
                EndpointCapabilities capabilities = capabilities(server, token);
                prefs.edit().putString("active_base", server).apply();
                return new EndpointSelection(server, token, capabilities.fabric, capabilities.resumable);
            } catch (Unauthorized error) {
                unauthorized = error;
            } catch (Exception error) {
                last = error;
            }
        }
        if (!hadToken) return null;
        if (unauthorized != null) throw unauthorized;
        if (last != null) throw last;
        throw new Exception("server_unavailable");
    }

    private static String resultCode(Exception error) {
        String value = error == null ? null : error.getMessage();
        if (value == null || value.isEmpty()) return "sync_failed";
        value = value.replaceAll("[^A-Za-z0-9_-]", "_");
        return value.substring(0, Math.min(120, value.length()));
    }

    private static String folderSummary(SyncStats stats) {
        if (stats.downloaded == 0 && stats.deleted == 0 && stats.conflicts == 0)
            return stats.uploaded + " file(s) uploaded";
        return stats.uploaded + " up, " + stats.downloaded + " down, "
                + stats.deleted + " removed, " + stats.conflicts + " conflicts";
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
                .remove("sync_progress").remove("sync_run_id").remove("sync_run_heartbeat")
                .remove("sync_run_manual")
                .commit();
        return needsMore;
    }

    private void throwIfStopped() throws Stopped {
        touchHeartbeat();
        if (cancelled || (deadlineMs > 0 && System.currentTimeMillis() > deadlineMs)) throw new Stopped();
    }

    private void touchHeartbeat() {
        long now = System.currentTimeMillis();
        if (runId == null || now - lastHeartbeatWrite < 5_000L) return;
        lastHeartbeatWrite = now;
        prefs.edit().putLong("sync_run_heartbeat", now).apply();
    }

    private void updateProgress(String folder, int done, int total) {
        try {
            JSONObject o = new JSONObject();
            o.put("folder", folder == null ? "" : folder);
            o.put("done", done);
            o.put("total", total);
            lastHeartbeatWrite = System.currentTimeMillis();
            prefs.edit().putString("sync_progress", o.toString())
                    .putLong("sync_run_heartbeat", lastHeartbeatWrite).apply();
            ProgressListener l = progressListener;
            if (l != null) l.onProgress(folder, done, total);
        } catch (Exception ignored) { }
    }

    private static String folderId(String value) {
        try {
            return "folder_" + sha256Text(value).substring(0, 24);
        } catch (Exception ignored) { return "folder_" + Math.abs(String.valueOf(value).hashCode()); }
    }

    private static String sha256Text(String value) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return hex(digest.digest(String.valueOf(value).getBytes(StandardCharsets.UTF_8)));
    }

    private static String sidecarRel(String rel, String suffix) throws Exception {
        rel = cleanRel(rel);
        int slash = rel.lastIndexOf('/');
        String dir = slash < 0 ? "" : rel.substring(0, slash + 1);
        return dir + "." + sha256Text(rel).substring(0, 20) + suffix;
    }

    private String deviceId() throws Exception {
        return stableDeviceId(context);
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }

    private static String cleanRel(String rel) throws Exception {
        if (rel == null) throw new Exception("invalid_sync_path");
        rel = rel.replace('\\', '/');
        if (rel.isEmpty() || rel.startsWith("/")) throw new Exception("invalid_sync_path");
        for (String part : rel.split("/", -1)) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) throw new Exception("invalid_sync_path");
        }
        return rel;
    }

    private static String utf8Prefix(String value, int maxBytes) {
        String out = value == null ? "" : value;
        while (!out.isEmpty() && out.getBytes(StandardCharsets.UTF_8).length > maxBytes) {
            out = out.substring(0, out.offsetByCodePoints(0, out.codePointCount(0, out.length()) - 1));
        }
        return out;
    }

    private String conflictRel(String rel, String contentHash) throws Exception {
        rel = cleanRel(rel);
        int slash = rel.lastIndexOf('/');
        String dir = slash < 0 ? "" : rel.substring(0, slash + 1);
        String leaf = slash < 0 ? rel : rel.substring(slash + 1);
        int dot = leaf.lastIndexOf('.');
        String rawExt = dot > 0 ? leaf.substring(dot) : "";
        String stem = dot > 0 ? leaf.substring(0, dot) : leaf;
        String safeDevice = deviceId().replaceAll("[^A-Za-z0-9_-]", "");
        if (safeDevice.isEmpty()) safeDevice = "device";
        safeDevice = safeDevice.substring(0, Math.min(12, safeDevice.length()));
        return dir + utf8Prefix(stem, 180) + " (Aerie conflict " + safeDevice + "-"
                + contentHash.substring(0, Math.min(8, contentHash.length())) + ")" + utf8Prefix(rawExt, 24);
    }

    private ScanResult scan(Uri tree) throws Stopped {
        ScanResult result = new ScanResult();
        try {
            String treeId = DocumentsContract.getTreeDocumentId(tree);
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, treeId);
            walkDoc(tree, doc, "", result);
        } catch (Stopped stopped) { throw stopped; }
        catch (Exception ignored) { result.complete = false; }
        return result;
    }

    private void walkDoc(Uri tree, Uri doc, String prefix, ScanResult result) throws Stopped {
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
            if (c == null) { result.complete = false; return; }
            while (c.moveToNext()) {
                throwIfStopped();
                String id = c.getString(0);
                String name = c.getString(1);
                if (name == null || name.startsWith(".") || name.endsWith(".aerie-part")
                        || name.endsWith(".aerie-replaced")) continue;
                if (name.contains("\\") || name.contains("/")) { result.complete = false; continue; }
                long size = c.isNull(2) ? 0 : c.getLong(2);
                long modified = c.isNull(3) ? 0 : c.getLong(3);
                String mime = c.getString(4);
                Uri child = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                String rel = prefix.isEmpty() ? name : prefix + "/" + name;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) walkDoc(tree, child, rel, result);
                else result.files.add(new FileItem(child, id, rel, size, modified, mime, size > MAX_FILE));
            }
        } catch (Stopped stopped) {
            throw stopped;
        } catch (Exception ignored) {
            result.complete = false;
        } finally {
            if (c != null) c.close();
        }
    }

    private String hashUri(Uri uri) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new BufferedInputStream(context.getContentResolver().openInputStream(uri))) {
            if (in == null) throw new Exception("sync_stream_unavailable");
            byte[] buffer = new byte[IO_BUFFER];
            for (int count; (count = in.read(buffer)) >= 0; ) {
                throwIfStopped();
                if (count > 0) digest.update(buffer, 0, count);
            }
        }
        return hex(digest.digest());
    }

    private EndpointCapabilities capabilities(String server, String token) throws Exception {
        try {
            // Endpoint selection happens before mutations. Keep stale LAN aliases
            // from consuming the full sync request timeout before cloud failover.
            JSONObject capabilities = requestJson(server, token, "GET", "/api/sync/capabilities", null,
                    4_000, 8_000);
            boolean fabric = capabilities.optInt("protocol", 0) >= 2;
            boolean resumable = false;
            JSONArray features = capabilities.optJSONArray("features");
            if (features != null) for (int i = 0; i < features.length(); i++) {
                if ("resumable_uploads".equals(features.optString(i))) { resumable = true; break; }
            }
            return new EndpointCapabilities(fabric, resumable);
        } catch (HttpFailure failure) {
            if (failure.status == 404) return new EndpointCapabilities(false, false);
            throw failure;
        }
    }

    private JSONObject requestJson(String server, String token, String method, String endpoint, JSONObject body) throws Exception {
        return requestJson(server, token, method, endpoint, body, 20_000, 60_000);
    }

    private JSONObject requestJson(String server, String token, String method, String endpoint, JSONObject body,
                                   int connectTimeout, int readTimeout) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(server + endpoint).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(connectTimeout);
            connection.setReadTimeout(readTimeout);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status == 401) throw new Unauthorized();
            InputStream stream = status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream();
            byte[] bytes = stream == null ? new byte[0] : readLimited(stream, MAX_JSON_RESPONSE_BYTES);
            JSONObject response;
            try { response = bytes.length == 0 ? new JSONObject() : new JSONObject(new String(bytes, StandardCharsets.UTF_8)); }
            catch (Exception invalid) { throw new Exception("invalid_sync_response"); }
            if (status < 200 || status >= 300) throw new HttpFailure(status, response);
            return response;
        } finally {
            connection.disconnect();
        }
    }

    static final class DownloadResponsePlan {
        final boolean append;
        final long expectedBytes;

        DownloadResponsePlan(boolean append, long expectedBytes) {
            this.append = append;
            this.expectedBytes = expectedBytes;
        }
    }

    private static long declaredLength(String value) {
        if (value == null || value.isEmpty()) return -1;
        if (!value.matches("^[0-9]{1,19}$"))
            throw new IllegalArgumentException("invalid_download_content_length");
        try {
            long parsed = Long.parseLong(value);
            if (parsed < 0) throw new IllegalArgumentException("invalid_download_content_length");
            return parsed;
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException("invalid_download_content_length");
        }
    }

    static DownloadResponsePlan validateDownloadResponse(int status, long offset, long totalBytes,
                                                         String contentLength, String contentRange) {
        if (totalBytes < 0 || totalBytes > MAX_FILE || offset < 0 || offset > totalBytes)
            throw new IllegalArgumentException("invalid_download_size");
        final boolean append;
        final long expected;
        if (status == 206) {
            if (offset <= 0 || offset >= totalBytes || contentRange == null)
                throw new IllegalArgumentException("invalid_download_content_range");
            Matcher match = CONTENT_RANGE.matcher(contentRange.trim());
            if (!match.matches()) throw new IllegalArgumentException("invalid_download_content_range");
            final long start;
            final long end;
            final long total;
            try {
                start = Long.parseLong(match.group(1));
                end = Long.parseLong(match.group(2));
                total = Long.parseLong(match.group(3));
            } catch (NumberFormatException invalid) {
                throw new IllegalArgumentException("invalid_download_content_range");
            }
            if (start != offset || end != totalBytes - 1 || total != totalBytes || end < start)
                throw new IllegalArgumentException("invalid_download_content_range");
            append = true;
            expected = totalBytes - offset;
        } else if (status == 200) {
            if (contentRange != null && !contentRange.trim().isEmpty())
                throw new IllegalArgumentException("unexpected_download_content_range");
            append = false;
            expected = totalBytes;
        } else throw new IllegalArgumentException("invalid_download_status");

        long declared = declaredLength(contentLength);
        if (declared >= 0 && declared != expected)
            throw new IllegalArgumentException("invalid_download_content_length");
        return new DownloadResponsePlan(append, expected);
    }

    static long checkedDownloadCount(long received, int count, long expectedBytes) {
        if (received < 0 || expectedBytes < 0 || expectedBytes > MAX_FILE || received > expectedBytes)
            throw new IllegalArgumentException("invalid_download_byte_count");
        if (count <= 0) return received;
        if ((long) count > expectedBytes - received || (long) count > MAX_FILE - received)
            throw new IllegalArgumentException("download_response_too_large");
        return received + count;
    }

    private FileItem download(String server, String token, String base, SnapshotEntry entry,
                              TreeAccess tree, boolean retry) throws Exception {
        if (entry.size < 0 || entry.size > MAX_FILE) throw new Exception("sync_file_too_large");
        String tempRel = sidecarRel(entry.rel, ".aerie-part");
        FileItem temp = tree.find(tempRel);
        if (temp == null) temp = tree.createFile(tempRel, guess(entry.rel));
        long offset = temp.size;
        if (offset > entry.size) {
            tree.delete(tempRel);
            temp = tree.createFile(tempRel, guess(entry.rel));
            offset = 0;
        }
        if (offset != entry.size || entry.size == 0) {
            String endpoint = server + "/api/sync/file?base=" + Uri.encode(base) + "&rel=" + Uri.encode(entry.rel);
            HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(120000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            // Android otherwise negotiates and transparently decodes gzip, hiding
            // the wire Content-Length. Identity keeps range/length validation tied
            // to the exact representation that is written to the destination.
            connection.setRequestProperty("Accept-Encoding", "identity");
            if (offset > 0) {
                connection.setRequestProperty("Range", "bytes=" + offset + "-");
                connection.setRequestProperty("If-Range", "\"sha256-" + entry.contentHash + "\"");
            }
            int status = connection.getResponseCode();
            if (status == 401) { connection.disconnect(); throw new Unauthorized(); }
            if (status != 200 && status != 206) {
                connection.disconnect();
                if (status == 416 && retry) {
                    tree.delete(tempRel);
                    return download(server, token, base, entry, tree, false);
                }
                throw new Exception("download_" + status);
            }
            final DownloadResponsePlan plan;
            try {
                plan = validateDownloadResponse(status, offset, entry.size,
                        connection.getHeaderField("Content-Length"),
                        connection.getHeaderField("Content-Range"));
            } catch (IllegalArgumentException invalid) {
                connection.disconnect();
                throw new Exception(invalid.getMessage());
            }
            String mode = plan.append ? "wa" : "rwt";
            try {
                InputStream response = connection.getInputStream();
                OutputStream destination = context.getContentResolver().openOutputStream(temp.uri, mode);
                if (response == null || destination == null) {
                    try { if (response != null) response.close(); } catch (Exception ignored) { }
                    try { if (destination != null) destination.close(); } catch (Exception ignored) { }
                    throw new Exception("sync_stream_unavailable");
                }
                try (InputStream in = new BufferedInputStream(response);
                     OutputStream out = new BufferedOutputStream(destination)) {
                    byte[] buffer = new byte[IO_BUFFER];
                    long received = 0;
                    for (int count; (count = in.read(buffer)) >= 0; ) {
                        throwIfStopped();
                        if (count > 0) {
                            try { received = checkedDownloadCount(received, count, plan.expectedBytes); }
                            catch (IllegalArgumentException invalid) { throw new Exception(invalid.getMessage()); }
                            out.write(buffer, 0, count);
                        }
                    }
                    if (received != plan.expectedBytes) throw new Exception("download_response_truncated");
                }
            } finally { connection.disconnect(); }
        }

        temp = tree.find(tempRel);
        if (temp == null || temp.size != entry.size || !entry.contentHash.equals(hashUri(temp.uri))) {
            tree.delete(tempRel);
            if (retry) return download(server, token, base, entry, tree, false);
            throw new Exception("download_hash_mismatch");
        }
        return tree.commitTemp(tempRel, entry.rel, guess(entry.rel), entry.contentHash);
    }

    private SyncStats syncFabricFolder(String server, String token, WorkFolder folder) throws Exception {
        TreeAccess tree = new TreeAccess(Uri.parse(folder.config.getString("uri")));
        FabricState state = loadFabricState(folder.config, server, folder.base);
        SyncStats stats = new SyncStats();
        String journalDeviceId = deviceId();
        if (!state.initialized)
            applyFullManifest(server, token, journalDeviceId, folder, tree, state, stats);
        else pullFabric(server, token, journalDeviceId, folder, tree, state, stats);
        pushFabric(server, token, folder, tree, state, stats);
        return stats;
    }

    private void applyFullManifest(String server, String token, String journalDeviceId,
                                   WorkFolder folder, TreeAccess tree, FabricState state,
                                   SyncStats stats) throws Exception {
        JSONObject manifest = requestJson(server, token, "GET",
                "/api/sync/manifest?base=" + Uri.encode(folder.base)
                        + "&deviceId=" + Uri.encode(journalDeviceId), null);
        final JSONArray entries = manifest.optJSONArray("entries");
        final long manifestCursor = manifest.optLong("cursor", -1);
        if (entries == null) throw new Exception("invalid_sync_manifest");
        if (manifestCursor < 0) throw new Exception("invalid_sync_cursor");
        final HashSet<String> manifestIds = new HashSet<>();
        final HashSet<String> manifestRels = new HashSet<>();
        for (int i = 0; i < entries.length(); i++) {
            SnapshotEntry entry = SnapshotEntry.fromServer(entries.getJSONObject(i));
            if (!manifestIds.add(entry.stableId))
                throw new Exception("duplicate_stable_id");
            if (!manifestRels.add(entry.rel)) throw new Exception("duplicate_sync_path");
        }

        SyncJournal.commitRemoteApply(() -> {
            int total = entries.length();
            // Remove tracked entries absent from the authoritative manifest
            // before applying it. A newly-created server entry may legitimately
            // reuse an absent entry's old path.
            ArrayList<String> absent = SyncJournal.absentFromManifest(
                    state.entries.keySet(), manifestIds);
            for (String stableId : absent) {
                throwIfStopped();
                applyServerDelete(new JSONObject().put("stableId", stableId), tree, state, stats);
            }
            for (int i = 0; i < total; i++) {
                throwIfStopped();
                JSONObject entry = entries.getJSONObject(i);
                updateProgress(folder.label, i, total);
                applyServerEntry(server, token, folder.base, entry, tree, state, stats);
            }
            state.cursor = manifestCursor;
            state.initialized = true;
            updateProgress(folder.label, total, total);
        }, () -> saveFabricState(folder.config, state),
                () -> acknowledgeFabric(server, token, folder.base, journalDeviceId, manifestCursor));
    }

    private void pullFabric(String server, String token, String journalDeviceId, WorkFolder folder,
                            TreeAccess tree, FabricState state, SyncStats stats) throws Exception {
        boolean more = true;
        while (more) {
            throwIfStopped();
            JSONObject page = requestJson(server, token, "GET", "/api/sync/changes?base="
                    + Uri.encode(folder.base) + "&cursor=" + state.cursor + "&limit=" + FABRIC_PAGE
                    + "&deviceId=" + Uri.encode(journalDeviceId), null);
            if (page.optBoolean("fullManifestRequired", false)) {
                applyFullManifest(server, token, journalDeviceId, folder, tree, state, stats);
                return;
            }
            final JSONArray items = page.optJSONArray("items");
            if (items == null || !page.has("nextCursor")) throw new Exception("invalid_sync_page");
            final boolean hasMore = page.optBoolean("hasMore", false);
            final long nextCursor;
            try {
                long[] itemCursors = new long[items.length()];
                for (int i = 0; i < items.length(); i++)
                    itemCursors[i] = items.getJSONObject(i).optLong("cursor", -1);
                nextCursor = SyncJournal.validatePageCursor(state.cursor,
                        page.optLong("nextCursor", -1), hasMore, itemCursors);
            } catch (IllegalArgumentException invalid) {
                throw new Exception(invalid.getMessage());
            }
            SyncJournal.commitRemoteApply(() -> {
                int total = items.length();
                for (int i = 0; i < total; i++) {
                    throwIfStopped();
                    JSONObject change = items.getJSONObject(i);
                    updateProgress(folder.label, i, total);
                    if ("delete".equals(change.optString("kind")))
                        applyServerDelete(change, tree, state, stats);
                    else applyServerEntry(server, token, folder.base, change, tree, state, stats);
                }
                state.cursor = nextCursor;
                updateProgress(folder.label, total, total);
            }, () -> saveFabricState(folder.config, state),
                    () -> acknowledgeFabric(server, token, folder.base, journalDeviceId, nextCursor));
            more = hasMore;
        }
    }

    private void acknowledgeFabric(String server, String token, String base, String journalDeviceId,
                                   long cursor) throws Exception {
        JSONObject body = new JSONObject().put("base", base).put("deviceId", journalDeviceId)
                .put("cursor", cursor);
        try {
            JSONObject response = requestJson(server, token, "POST", "/api/sync/ack", body);
            if (!response.optBoolean("ok", false) || response.optLong("cursor", -1) < cursor)
                throw new Exception("invalid_sync_ack");
        } catch (HttpFailure failure) {
            // Protocol-2 servers predating retained journals have no ACK route.
            // They never compact based on device progress, so there is nothing
            // useful to acknowledge; retain interoperability during upgrades.
            if (failure.status != 404) throw failure;
        }
    }

    private void applyServerEntry(String server, String token, String base, JSONObject change,
                                  TreeAccess tree, FabricState state, SyncStats stats) throws Exception {
        SnapshotEntry remote = SnapshotEntry.fromServer(change);
        SnapshotEntry prior = state.entries.get(remote.stableId);
        String previousRel = change.optString("previousRel", "");
        String sourceRel = prior != null ? prior.rel : (!previousRel.isEmpty() ? cleanRel(previousRel) : remote.rel);
        FileItem source = tree.find(sourceRel);
        boolean deleteSourceAfterDownload = false;

        if (source != null) {
            String sourceHash = hashUri(source.uri);
            if (remote.contentHash.equals(sourceHash)) {
                if (!sourceRel.equals(remote.rel)) {
                    FileItem destination = tree.find(remote.rel);
                    if (destination != null) {
                        String destinationHash = hashUri(destination.uri);
                        if (remote.contentHash.equals(destinationHash)) {
                            tree.delete(sourceRel);
                            updateSnapshot(state, remote, destination);
                            return;
                        }
                        preserveConflict(tree, destination, stats);
                    }
                    FileItem moved = tree.move(sourceRel, remote.rel, source.mime, sourceHash);
                    updateSnapshot(state, remote, moved);
                } else updateSnapshot(state, remote, source);
                return;
            }

            if (prior != null && prior.contentHash.equals(sourceHash)) {
                deleteSourceAfterDownload = !sourceRel.equals(remote.rel);
            } else {
                preserveConflict(tree, source, stats);
                source = null;
            }
        }

        FileItem destination = tree.find(remote.rel);
        if (destination != null) {
            String destinationHash = hashUri(destination.uri);
            if (remote.contentHash.equals(destinationHash)) {
                if (deleteSourceAfterDownload) tree.delete(sourceRel);
                updateSnapshot(state, remote, destination);
                return;
            }
            // The destination is the unchanged prior version when an in-place
            // server edit arrives; commitTemp will replace it atomically.
            if (!(prior != null && sourceRel.equals(remote.rel) && prior.contentHash.equals(destinationHash))) {
                preserveConflict(tree, destination, stats);
            }
        }

        FileItem downloaded = download(server, token, base, remote, tree, true);
        stats.downloaded++;
        if (deleteSourceAfterDownload) tree.delete(sourceRel);
        updateSnapshot(state, remote, downloaded);
    }

    private void applyServerDelete(JSONObject change, TreeAccess tree, FabricState state,
                                   SyncStats stats) throws Exception {
        String stableId = change.getString("stableId");
        SnapshotEntry prior = state.entries.get(stableId);
        if (prior == null) return;
        FileItem local = tree.find(prior.rel);
        if (local != null) {
            String hash = hashUri(local.uri);
            if (prior.contentHash.equals(hash)) {
                tree.delete(prior.rel);
                stats.deleted++;
            } else preserveConflict(tree, local, stats);
        }
        state.entries.remove(stableId);
    }

    private FileItem preserveConflict(TreeAccess tree, FileItem local, SyncStats stats) throws Exception {
        String hash = local.contentHash != null ? local.contentHash : hashUri(local.uri);
        String targetRel = conflictRel(local.rel, hash);
        FileItem target = tree.find(targetRel);
        if (target != null) {
            if (!hash.equals(hashUri(target.uri))) throw new Exception("local_conflict_name_collision");
            tree.delete(local.rel);
            stats.conflicts++;
            return target;
        }
        FileItem moved = tree.move(local.rel, targetRel, local.mime, hash);
        stats.conflicts++;
        return moved;
    }

    private void updateSnapshot(FabricState state, SnapshotEntry remote, FileItem local) throws Exception {
        if (local == null) throw new Exception("sync_local_file_missing");
        remote.documentId = local.documentId;
        state.entries.put(remote.stableId, remote);
    }

    private void pushFabric(String server, String token, WorkFolder folder, TreeAccess tree,
                            FabricState state, SyncStats stats) throws Exception {
        ScanResult scan = scan(tree.tree);
        stats.incomplete |= !scan.complete;
        for (FileItem item : scan.files) if (item.tooLarge) stats.skippedLarge++;
        HashMap<String, FileItem> localByRel = new HashMap<>();
        HashMap<String, SnapshotEntry> priorByRel = new HashMap<>();
        for (SnapshotEntry entry : state.entries.values()) priorByRel.put(entry.rel, entry);
        int hashed = 0;
        for (FileItem item : scan.files) {
            throwIfStopped();
            SnapshotEntry prior = priorByRel.get(item.rel);
            if (!item.tooLarge) item.contentHash = hashUri(item.uri);
            else if (prior != null) item.contentHash = prior.contentHash;
            localByRel.put(item.rel, item);
            updateProgress(folder.label, ++hashed, scan.files.size());
        }

        ArrayList<SnapshotEntry> removed = new ArrayList<>();
        for (SnapshotEntry entry : state.entries.values()) if (!localByRel.containsKey(entry.rel)) removed.add(entry);
        ArrayList<FileItem> untracked = new ArrayList<>();
        for (FileItem item : scan.files) if (!priorByRel.containsKey(item.rel)) untracked.add(item);
        Collections.sort(untracked, Comparator.comparing(item -> item.rel));
        HashSet<String> usedRemoved = new HashSet<>();
        HashMap<String, SnapshotEntry> renameForRel = new HashMap<>();
        for (FileItem item : untracked) {
            SnapshotEntry match = null;
            for (SnapshotEntry candidate : removed) {
                if (usedRemoved.contains(candidate.stableId)) continue;
                if (candidate.documentId != null && !candidate.documentId.isEmpty()
                        && candidate.documentId.equals(item.documentId)) { match = candidate; break; }
            }
            if (match == null && item.contentHash != null) for (SnapshotEntry candidate : removed) {
                if (!usedRemoved.contains(candidate.stableId) && candidate.size == item.size
                        && candidate.contentHash.equals(item.contentHash)) { match = candidate; break; }
            }
            if (match != null) {
                usedRemoved.add(match.stableId);
                renameForRel.put(item.rel, match);
            }
        }

        for (FileItem item : untracked) {
            SnapshotEntry prior = renameForRel.get(item.rel);
            if (prior == null) continue;
            JSONObject body = new JSONObject().put("base", folder.base).put("from", prior.rel)
                    .put("to", item.rel).put("stableId", prior.stableId)
                    .put("expectedHash", prior.contentHash).put("deviceId", deviceId());
            JSONObject response = requestJson(server, token, "POST", "/api/sync/rename", body);
            SnapshotEntry renamed = SnapshotEntry.fromServer(response.getJSONObject("entry"));
            updateSnapshot(state, renamed, item);
            if (item.contentHash != null && !item.contentHash.equals(prior.contentHash)) {
                JSONObject uploaded = uploadFabric(server, token, folder.base, item, prior.stableId, prior.contentHash);
                applyUploadResponse(server, token, folder, tree, state, item, renamed, uploaded, stats);
                stats.uploaded++;
            }
            saveFabricState(folder.config, state);
        }

        for (FileItem item : scan.files) {
            SnapshotEntry prior = priorByRel.get(item.rel);
            if (prior == null || item.contentHash == null || item.contentHash.equals(prior.contentHash)) continue;
            JSONObject uploaded = uploadFabric(server, token, folder.base, item, prior.stableId, prior.contentHash);
            applyUploadResponse(server, token, folder, tree, state, item, prior, uploaded, stats);
            stats.uploaded++;
            saveFabricState(folder.config, state);
        }

        if (scan.complete) for (SnapshotEntry prior : removed) {
            if (usedRemoved.contains(prior.stableId)) continue;
            JSONObject body = new JSONObject().put("base", folder.base).put("rel", prior.rel)
                    .put("stableId", prior.stableId).put("expectedHash", prior.contentHash)
                    .put("deviceId", deviceId());
            requestJson(server, token, "POST", "/api/sync/delete", body);
            state.entries.remove(prior.stableId);
            stats.deleted++;
            saveFabricState(folder.config, state);
        }

        for (FileItem item : untracked) {
            if (renameForRel.containsKey(item.rel) || item.contentHash == null) continue;
            JSONObject uploaded = uploadFabric(server, token, folder.base, item, null, null);
            applyUploadResponse(server, token, folder, tree, state, item, null, uploaded, stats);
            stats.uploaded++;
            saveFabricState(folder.config, state);
        }

        // Refresh provider document IDs and mtimes for unchanged files.
        for (FileItem item : scan.files) {
            SnapshotEntry prior = priorByRel.get(item.rel);
            SnapshotEntry current = prior == null ? null : state.entries.get(prior.stableId);
            if (current != null && item.contentHash != null && item.contentHash.equals(current.contentHash)) {
                current.documentId = item.documentId;
            }
        }
        saveFabricState(folder.config, state);
    }

    private void applyUploadResponse(String server, String token, WorkFolder folder, TreeAccess tree,
                                     FabricState state, FileItem local, SnapshotEntry prior,
                                     JSONObject response, SyncStats stats) throws Exception {
        SnapshotEntry saved = SnapshotEntry.fromServer(response.getJSONObject("entry"));
        if (!response.optBoolean("conflict", false)) {
            if (prior != null && !prior.stableId.equals(saved.stableId)) state.entries.remove(prior.stableId);
            updateSnapshot(state, saved, local);
            return;
        }

        String conflictPath = cleanRel(response.getString("conflictRel"));
        FileItem moved;
        if (local.rel.equals(conflictPath)) moved = local;
        else {
            FileItem existing = tree.find(conflictPath);
            if (existing != null && saved.contentHash.equals(hashUri(existing.uri))) {
                tree.delete(local.rel);
                moved = existing;
            } else if (existing != null) throw new Exception("local_conflict_name_collision");
            else moved = tree.move(local.rel, conflictPath, local.mime, saved.contentHash);
        }
        updateSnapshot(state, saved, moved);
        if (prior != null) state.entries.remove(prior.stableId);
        JSONObject currentJson = response.optJSONObject("current");
        if (currentJson != null) {
            SnapshotEntry current = SnapshotEntry.fromServer(currentJson);
            FileItem downloaded = download(server, token, folder.base, current, tree, true);
            updateSnapshot(state, current, downloaded);
            stats.downloaded++;
        }
        stats.conflicts++;
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
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            c.setInstanceFollowRedirects(false);
            c.setDoOutput(true);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Content-Type", "application/json");
            byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(b.length);
            try (OutputStream output = c.getOutputStream()) { output.write(b); }
            int code = c.getResponseCode();
            if (code == 401) throw new Unauthorized();
            if (code >= 300) throw new Exception("check_" + code);
            byte[] buf = readLimited(c.getInputStream(), MAX_JSON_RESPONSE_BYTES);
            JSONArray arr = new JSONObject(new String(buf, StandardCharsets.UTF_8)).optJSONArray("needed");
            HashSet<String> set = new HashSet<>();
            if (arr != null) for (int i = 0; i < arr.length(); i++) set.add(arr.optString(i));
            return set;
        } finally {
            c.disconnect();
        }
    }

    private void upload(String server, String token, String base, FileItem item) throws Exception {
        if (!resumableUploads) { uploadMultipart(server, token, base, item, null, null); return; }
        item.contentHash = hashUri(item.uri);
        try { uploadResumable(server, token, base, item, null, null); }
        catch (HttpFailure unavailable) {
            if (unavailable.status != 404) throw unavailable;
            uploadMultipart(server, token, base, item, null, null);
        }
    }

    private JSONObject uploadFabric(String server, String token, String base, FileItem item,
                                    String stableId, String expectedHash) throws Exception {
        if (item.contentHash == null || !item.contentHash.matches("^[a-f0-9]{64}$"))
            throw new Exception("sync_hash_missing");
        String expected = expectedHash == null ? "missing" : expectedHash;
        if (!resumableUploads) return uploadMultipart(server, token, base, item, stableId, expected);
        try { return uploadResumable(server, token, base, item, stableId, expected); }
        catch (HttpFailure unavailable) {
            if (unavailable.status != 404) throw unavailable;
            return uploadMultipart(server, token, base, item, stableId, expected);
        }
    }

    private JSONObject uploadResumable(String server, String token, String base, FileItem item,
                                       String stableId, String expectedHash) throws Exception {
        if (item.contentHash == null || !item.contentHash.matches("^[a-f0-9]{64}$"))
            throw new Exception("sync_hash_missing");
        String device = deviceId();
        String checkpoint = "sync_resume_" + hex(MessageDigest.getInstance("SHA-256").digest(
                (server + "\n" + base + "\n" + item.rel + "\n" + item.size + "\n" + item.mtimeMs
                        + "\n" + item.contentHash + "\n" + String.valueOf(stableId) + "\n"
                        + String.valueOf(expectedHash)).getBytes(StandardCharsets.UTF_8)));
        String priorId = prefs.getString(checkpoint, "");
        if (!priorId.matches("^[a-f0-9-]{36}$")) {
            prefs.edit().remove(checkpoint).apply();
            priorId = "";
        }
        JSONObject body = new JSONObject().put("base", base).put("rel", item.rel)
                .put("size", item.size).put("mtimeMs", Math.max(0, item.mtimeMs))
                .put("contentHash", item.contentHash).put("deviceId", device);
        if (stableId != null && !stableId.isEmpty()) body.put("stableId", stableId);
        if (expectedHash != null) body.put("expectedHash", expectedHash);
        if (!priorId.isEmpty()) body.put("uploadId", priorId);
        JSONObject initialized = requestJson(server, token, "POST", "/api/sync/upload-resumable/init", body);
        String uploadId = initialized.optString("uploadId", "");
        long offset = initialized.optLong("offset", -1);
        if (!uploadId.matches("^[a-f0-9-]{36}$") || initialized.optLong("size", -1) != item.size
                || offset < 0 || offset > item.size) throw new Exception("invalid_upload_session");
        prefs.edit().putString(checkpoint, uploadId).commit();
        if (initialized.optBoolean("completed", false)) {
            JSONObject completed = initialized.optJSONObject("result");
            if (completed == null || !completed.optBoolean("ok", false))
                throw new Exception("invalid_upload_completion");
            prefs.edit().remove(checkpoint).commit();
            return completed;
        }

        InputStream source = openAt(item.uri, offset);
        try {
            byte[] buffer = new byte[UPLOAD_CHUNK];
            while (offset < item.size) {
                throwIfStopped();
                int wanted = (int) Math.min(buffer.length, item.size - offset);
                int count = 0;
                while (count < wanted) {
                    int read = source.read(buffer, count, wanted - count);
                    if (read < 0) break;
                    if (read > 0) count += read;
                }
                if (count != wanted) throw new Exception("sync_stream_truncated");
                long sentFrom = offset;
                long expectedNext = offset + count;
                try {
                    JSONObject response = patchUpload(server, token, uploadId, offset, buffer, count);
                    long next = response.optLong("offset", -1);
                    if (next <= offset || next > item.size) throw new Exception("invalid_upload_offset");
                    offset = next;
                } catch (HttpFailure mismatch) {
                    if (mismatch.status != 409) throw mismatch;
                    long actual = mismatch.body.optLong("offset", -1);
                    if (actual < 0 || actual > item.size || actual == offset)
                        throw new Exception("invalid_upload_offset");
                    offset = actual;
                }
                if (offset != expectedNext) {
                    source.close();
                    source = openAt(item.uri, offset);
                }
                prefs.edit().putString(checkpoint, uploadId).apply();
                if (offset <= sentFrom && offset < item.size) throw new Exception("upload_made_no_progress");
            }
        } finally { try { source.close(); } catch (Exception ignored) { } }

        JSONObject completed = requestJson(server, token, "POST",
                "/api/sync/upload-resumable/" + Uri.encode(uploadId) + "/complete",
                new JSONObject().put("sha256", item.contentHash));
        if (!completed.optBoolean("ok", false)) throw new Exception("sync_upload_commit_failed");
        prefs.edit().remove(checkpoint).commit();
        return completed;
    }

    private InputStream openAt(Uri uri, long offset) throws Exception {
        InputStream raw = context.getContentResolver().openInputStream(uri);
        if (raw == null) throw new Exception("sync_stream_unavailable");
        BufferedInputStream input = new BufferedInputStream(raw);
        long skipped = 0;
        try {
            byte[] discard = new byte[IO_BUFFER];
            while (skipped < offset) {
                throwIfStopped();
                long step = input.skip(offset - skipped);
                if (step > 0) { skipped += step; continue; }
                int read = input.read(discard, 0, (int) Math.min(discard.length, offset - skipped));
                if (read < 0) throw new Exception("sync_stream_truncated");
                if (read > 0) skipped += read;
            }
            return input;
        } catch (Exception error) {
            try { input.close(); } catch (Exception ignored) { }
            throw error;
        }
    }

    private JSONObject patchUpload(String server, String token, String uploadId, long offset,
                                   byte[] bytes, int count) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(server
                + "/api/sync/upload-resumable/" + Uri.encode(uploadId)).openConnection();
        try {
            connection.setRequestMethod("PATCH");
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(60_000);
            connection.setInstanceFollowRedirects(false);
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/octet-stream");
            connection.setRequestProperty("X-Upload-Offset", String.valueOf(offset));
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(bytes, 0, count);
            connection.setRequestProperty("X-Chunk-SHA256", hex(digest.digest()));
            connection.setFixedLengthStreamingMode(count);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes, 0, count); }
            int status = connection.getResponseCode();
            if (status == 401) throw new Unauthorized();
            InputStream stream = status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream();
            byte[] responseBytes = stream == null ? new byte[0] : readLimited(stream, MAX_JSON_RESPONSE_BYTES);
            JSONObject response;
            try { response = responseBytes.length == 0 ? new JSONObject()
                    : new JSONObject(new String(responseBytes, StandardCharsets.UTF_8)); }
            catch (Exception invalid) { throw new Exception("invalid_sync_response"); }
            if (status < 200 || status >= 300) throw new HttpFailure(status, response);
            return response;
        } finally { connection.disconnect(); }
    }

    private JSONObject uploadMultipart(String server, String token, String base, FileItem item,
                                       String stableId, String expectedHash) throws Exception {
        String boundary = "AerieSync" + Long.toHexString(System.nanoTime());
        HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/sync/upload").openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(20000);
        c.setReadTimeout(120000);
        c.setInstanceFollowRedirects(false);
        c.setDoOutput(true);
        c.setChunkedStreamingMode(64 * 1024);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        c.setRequestProperty("X-Aerie-Upload-Length", String.valueOf(item.size));
        OutputStream raw = null;
        BufferedInputStream in = null;
        try {
            raw = new BufferedOutputStream(c.getOutputStream());
            field(raw, boundary, "base", base);
            field(raw, boundary, "rel", item.rel);
            if (item.mtimeMs > 0) field(raw, boundary, "mtimeMs", String.valueOf(item.mtimeMs));
            if (expectedHash != null) {
                field(raw, boundary, "deviceId", deviceId());
                field(raw, boundary, "contentHash", item.contentHash);
                field(raw, boundary, "expectedHash", expectedHash);
                if (stableId != null && !stableId.isEmpty()) field(raw, boundary, "stableId", stableId);
            }
            write(raw, "--" + boundary + "\r\n");
            String type = item.mime == null || item.mime.isEmpty() ? guess(item.rel) : item.mime;
            String filename = item.rel.substring(item.rel.lastIndexOf('/') + 1)
                    .replace("\"", "_").replace("\r", "_").replace("\n", "_");
            write(raw, "Content-Disposition: form-data; name=\"file\"; filename=\"" + filename + "\"\r\n");
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
            InputStream responseStream = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
            byte[] responseBytes = responseStream == null ? new byte[0]
                    : readLimited(responseStream, MAX_JSON_RESPONSE_BYTES);
            JSONObject response = responseBytes.length == 0 ? new JSONObject()
                    : new JSONObject(new String(responseBytes, StandardCharsets.UTF_8));
            if (code >= 300) throw new HttpFailure(code, response);
            return response;
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
        while ((n = in.read(buf)) >= 0) if (n > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }

    private static byte[] readLimited(InputStream in, int maxBytes) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        try (InputStream input = in) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = input.read(buf)) >= 0) {
                if (n == 0) continue;
                if (n > maxBytes - out.size()) throw new Exception("sync_response_too_large");
                out.write(buf, 0, n);
            }
        }
        return out.toByteArray();
    }

    /** Sandboxed Storage Access Framework view rooted at the persisted tree. */
    private final class TreeAccess {
        final Uri tree;
        final Uri root;
        final ContentResolver resolver;

        TreeAccess(Uri tree) throws Exception {
            this.tree = tree;
            this.resolver = context.getContentResolver();
            String rootId = DocumentsContract.getTreeDocumentId(tree);
            this.root = DocumentsContract.buildDocumentUriUsingTree(tree, rootId);
            if (this.root == null) throw new Exception("sync_tree_unavailable");
        }

        FileItem find(String rel) throws Exception {
            rel = cleanRel(rel);
            String[] parts = rel.split("/");
            Uri current = root;
            StringBuilder walked = new StringBuilder();
            for (int i = 0; i < parts.length; i++) {
                FileItem child = child(current, parts[i], walked.length() == 0 ? parts[i] : walked + "/" + parts[i]);
                if (child == null) return null;
                if (walked.length() > 0) walked.append('/');
                walked.append(parts[i]);
                if (i < parts.length - 1) {
                    if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(child.mime)) return null;
                    current = child.uri;
                } else return child;
            }
            return null;
        }

        private FileItem child(Uri parent, String name, String rel) throws Exception {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent));
            try (Cursor cursor = resolver.query(children, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                    DocumentsContract.Document.COLUMN_MIME_TYPE
            }, null, null, null)) {
                if (cursor == null) throw new Exception("sync_tree_query_failed");
                while (cursor.moveToNext()) {
                    if (!name.equals(cursor.getString(1))) continue;
                    String id = cursor.getString(0);
                    long size = cursor.isNull(2) ? 0 : cursor.getLong(2);
                    long modified = cursor.isNull(3) ? 0 : cursor.getLong(3);
                    String mime = cursor.getString(4);
                    return new FileItem(DocumentsContract.buildDocumentUriUsingTree(tree, id), id, rel,
                            size, modified, mime, size > MAX_FILE);
                }
            }
            return null;
        }

        Uri ensureDirectory(String rel) throws Exception {
            if (rel == null || rel.isEmpty()) return root;
            rel = cleanRel(rel);
            Uri current = root;
            StringBuilder walked = new StringBuilder();
            for (String part : rel.split("/")) {
                String nextRel = walked.length() == 0 ? part : walked + "/" + part;
                FileItem existing = child(current, part, nextRel);
                if (existing == null) {
                    Uri created = DocumentsContract.createDocument(resolver, current,
                            DocumentsContract.Document.MIME_TYPE_DIR, part);
                    if (created == null) throw new Exception("sync_create_directory_failed");
                    current = created;
                } else {
                    if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(existing.mime))
                        throw new Exception("sync_path_is_file");
                    current = existing.uri;
                }
                if (walked.length() > 0) walked.append('/');
                walked.append(part);
            }
            return current;
        }

        FileItem createFile(String rel, String mime) throws Exception {
            rel = cleanRel(rel);
            int slash = rel.lastIndexOf('/');
            String parentRel = slash < 0 ? "" : rel.substring(0, slash);
            String name = slash < 0 ? rel : rel.substring(slash + 1);
            Uri parent = ensureDirectory(parentRel);
            FileItem existing = child(parent, name, rel);
            if (existing != null) return existing;
            String type = mime == null || mime.isEmpty() || DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)
                    ? guess(rel) : mime;
            Uri created = DocumentsContract.createDocument(resolver, parent, type, name);
            if (created == null) throw new Exception("sync_create_file_failed");
            return metadata(created, rel, type);
        }

        FileItem metadata(Uri uri, String rel, String fallbackMime) throws Exception {
            try (Cursor cursor = resolver.query(uri, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                    DocumentsContract.Document.COLUMN_MIME_TYPE
            }, null, null, null)) {
                if (cursor == null || !cursor.moveToFirst()) throw new Exception("sync_document_unavailable");
                String id = cursor.getString(0);
                long size = cursor.isNull(1) ? 0 : cursor.getLong(1);
                long modified = cursor.isNull(2) ? 0 : cursor.getLong(2);
                String mime = cursor.isNull(3) ? fallbackMime : cursor.getString(3);
                return new FileItem(uri, id, cleanRel(rel), size, modified, mime, size > MAX_FILE);
            }
        }

        void delete(String rel) throws Exception {
            FileItem item = find(rel);
            if (item != null && !DocumentsContract.deleteDocument(resolver, item.uri))
                throw new Exception("sync_delete_failed");
        }

        private Uri rename(FileItem item, String name) {
            try { return DocumentsContract.renameDocument(resolver, item.uri, name); }
            catch (Exception ignored) { return null; }
        }

        private void copy(Uri source, Uri destination, boolean append) throws Exception {
            String mode = append ? "wa" : "rwt";
            try (InputStream in = new BufferedInputStream(resolver.openInputStream(source));
                 OutputStream out = new BufferedOutputStream(resolver.openOutputStream(destination, mode))) {
                if (in == null || out == null) throw new Exception("sync_stream_unavailable");
                byte[] buffer = new byte[IO_BUFFER];
                for (int count; (count = in.read(buffer)) >= 0; ) {
                    throwIfStopped();
                    if (count > 0) out.write(buffer, 0, count);
                }
            }
        }

        FileItem move(String fromRel, String toRel, String mime, String expectedHash) throws Exception {
            fromRel = cleanRel(fromRel);
            toRel = cleanRel(toRel);
            if (fromRel.equals(toRel)) return find(toRel);
            FileItem source = find(fromRel);
            if (source == null) {
                FileItem destination = find(toRel);
                if (destination != null) return destination;
                throw new Exception("sync_source_missing");
            }
            if (find(toRel) != null) throw new Exception("sync_destination_exists");
            int fromSlash = fromRel.lastIndexOf('/');
            int toSlash = toRel.lastIndexOf('/');
            String fromParent = fromSlash < 0 ? "" : fromRel.substring(0, fromSlash);
            String toParent = toSlash < 0 ? "" : toRel.substring(0, toSlash);
            String toName = toSlash < 0 ? toRel : toRel.substring(toSlash + 1);
            if (fromParent.equals(toParent)) {
                Uri renamed = rename(source, toName);
                if (renamed != null) return metadata(renamed, toRel, mime);
            }

            // Providers without cross-directory move support get a verified
            // copy-then-delete. The source is retained on every failure.
            String tempRel = sidecarRel(toRel, ".aerie-part");
            delete(tempRel);
            FileItem temp = createFile(tempRel, mime);
            copy(source.uri, temp.uri, false);
            String copiedHash = hashUri(temp.uri);
            if (!expectedHash.equals(copiedHash)) {
                delete(tempRel);
                throw new Exception("sync_local_copy_hash_mismatch");
            }
            FileItem committed = commitTemp(tempRel, toRel, mime, expectedHash);
            if (!DocumentsContract.deleteDocument(resolver, source.uri)) throw new Exception("sync_source_delete_failed");
            return committed;
        }

        FileItem commitTemp(String tempRel, String destinationRel, String mime, String expectedHash) throws Exception {
            FileItem temp = find(tempRel);
            if (temp == null) throw new Exception("sync_temp_missing");
            if (!expectedHash.equals(hashUri(temp.uri))) throw new Exception("download_hash_mismatch");
            FileItem destination = find(destinationRel);
            int slash = destinationRel.lastIndexOf('/');
            String name = slash < 0 ? destinationRel : destinationRel.substring(slash + 1);
            String backupRel = sidecarRel(destinationRel, ".aerie-replaced");
            FileItem backupFromCrash = find(backupRel);
            if (backupFromCrash != null) {
                if (destination == null) {
                    Uri restored = rename(backupFromCrash, name);
                    if (restored == null) throw new Exception("sync_replace_recovery_failed");
                    destination = metadata(restored, destinationRel, mime);
                } else if (!DocumentsContract.deleteDocument(resolver, backupFromCrash.uri)) {
                    throw new Exception("sync_replace_cleanup_failed");
                }
            }

            if (destination != null) {
                String backupName = backupRel.substring(backupRel.lastIndexOf('/') + 1);
                Uri backup = rename(destination, backupName);
                if (backup != null) {
                    Uri committed = rename(temp, name);
                    if (committed == null) {
                        try { DocumentsContract.renameDocument(resolver, backup, name); } catch (Exception ignored) { }
                        throw new Exception("sync_atomic_replace_failed");
                    }
                    try { DocumentsContract.deleteDocument(resolver, backup); } catch (Exception ignored) { }
                    return metadata(committed, destinationRel, mime);
                }

                // Last-resort provider fallback: temp is already verified and
                // the server remains the recovery source if this write fails.
                copy(temp.uri, destination.uri, false);
                if (!expectedHash.equals(hashUri(destination.uri))) throw new Exception("download_hash_mismatch");
                DocumentsContract.deleteDocument(resolver, temp.uri);
                return metadata(destination.uri, destinationRel, mime);
            }

            Uri committed = rename(temp, name);
            if (committed != null) return metadata(committed, destinationRel, mime);
            FileItem created = createFile(destinationRel, mime);
            copy(temp.uri, created.uri, false);
            if (!expectedHash.equals(hashUri(created.uri))) throw new Exception("download_hash_mismatch");
            DocumentsContract.deleteDocument(resolver, temp.uri);
            return metadata(created.uri, destinationRel, mime);
        }
    }

    private static File fabricStateDir(Context context) {
        File dir = new File(context.getFilesDir(), "sync-fabric-state");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private static String safeFolderId(String folderId) {
        return String.valueOf(folderId).replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private static File legacyFabricStateFile(Context context, String folderId) {
        return new File(fabricStateDir(context), safeFolderId(folderId) + ".json");
    }

    private static File fabricStateFile(Context context, String folderId, String server, String base) {
        String safe = String.valueOf(folderId).replaceAll("[^A-Za-z0-9_-]", "_");
        return new File(fabricStateDir(context), safe + ".scope-"
                + SyncJournal.stateScope(server, base) + ".json");
    }

    private static void deleteFabricState(Context context, String folderId) {
        File dir = fabricStateDir(context);
        String safe = safeFolderId(folderId);
        String scopedPrefix = safe + ".scope-";
        String legacyPrefix = safe + ".json";
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) {
            String name = file.getName();
            if (name.startsWith(scopedPrefix) || name.equals(legacyPrefix)
                    || name.equals(legacyPrefix + ".tmp") || name.equals(legacyPrefix + ".old"))
                file.delete();
        }
    }

    private FabricState loadFabricState(JSONObject folder, String server, String base) {
        String id = folder.optString("id", folderId(folder.optString("uri", base)));
        File scoped = fabricStateFile(context, id, server, base);
        File legacy = legacyFabricStateFile(context, id);
        File[] candidates = new File[]{scoped, new File(scoped.getPath() + ".old"),
                legacy, new File(legacy.getPath() + ".old")};
        for (File file : candidates) try {
            byte[] data;
            try (InputStream in = new java.io.FileInputStream(file)) { data = readAll(in); }
            JSONObject json = new JSONObject(new String(data, StandardCharsets.UTF_8));
            int version = json.optInt("version");
            if ((version != 2 && version != 3) || !server.equals(json.optString("server"))
                    || !base.equals(json.optString("base"))) continue;
            FabricState state = new FabricState(server, base);
            state.initialized = json.optBoolean("initialized", false);
            state.cursor = json.optLong("cursor", -1);
            if (state.cursor < 0) continue;
            JSONArray entries = json.optJSONArray("entries");
            if (entries == null) continue;
            for (int i = 0; i < entries.length(); i++) {
                SnapshotEntry entry = SnapshotEntry.fromJson(entries.getJSONObject(i));
                if (state.entries.containsKey(entry.stableId)) throw new Exception("duplicate_stable_id");
                state.entries.put(entry.stableId, entry);
            }
            return state;
        } catch (Exception ignored) { }
        return new FabricState(server, base);
    }

    private void saveFabricState(JSONObject folder, FabricState state) throws Exception {
        JSONObject json = new JSONObject();
        json.put("version", 3);
        json.put("server", state.server);
        json.put("base", state.base);
        json.put("initialized", state.initialized);
        json.put("cursor", state.cursor);
        JSONArray entries = new JSONArray();
        ArrayList<SnapshotEntry> ordered = new ArrayList<>(state.entries.values());
        Collections.sort(ordered, Comparator.comparing(entry -> entry.stableId));
        for (SnapshotEntry entry : ordered) entries.put(entry.toJson());
        json.put("entries", entries);

        File destination = fabricStateFile(context,
                folder.optString("id", folderId(folder.optString("uri", state.base))),
                state.server, state.base);
        File temp = new File(destination.getPath() + ".tmp");
        File old = new File(destination.getPath() + ".old");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(json.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (old.exists() && !old.delete()) throw new Exception("sync_state_cleanup_failed");
        boolean hadOld = destination.exists();
        if (hadOld && !destination.renameTo(old)) throw new Exception("sync_state_replace_failed");
        if (!temp.renameTo(destination)) {
            if (hadOld) old.renameTo(destination);
            throw new Exception("sync_state_replace_failed");
        }
        if (hadOld) old.delete();
    }

    private static class FileItem {
        final Uri uri;
        final String documentId;
        final String rel;
        final long size;
        final long mtimeMs;
        final String mime;
        final boolean tooLarge;
        String contentHash;
        FileItem(Uri uri, String documentId, String rel, long size, long mtimeMs, String mime, boolean tooLarge) {
            this.uri = uri; this.documentId = documentId; this.rel = rel; this.size = size;
            this.mtimeMs = mtimeMs; this.mime = mime; this.tooLarge = tooLarge;
        }
    }

    private static class ScanResult {
        final ArrayList<FileItem> files = new ArrayList<>();
        boolean complete = true;
    }

    private static class SnapshotEntry {
        String stableId;
        String rel;
        String contentHash;
        long size;
        long mtimeMs;
        String documentId;

        static SnapshotEntry fromJson(JSONObject json) throws Exception {
            SnapshotEntry entry = new SnapshotEntry();
            entry.stableId = json.getString("stableId");
            if (!entry.stableId.matches("^[A-Za-z0-9_-]{8,64}$")) throw new Exception("invalid_stable_id");
            entry.rel = cleanRel(json.getString("rel"));
            entry.contentHash = json.getString("contentHash");
            if (!entry.contentHash.matches("^[a-f0-9]{64}$")) throw new Exception("invalid_sync_hash");
            entry.size = Math.max(0, json.optLong("size", 0));
            entry.mtimeMs = Math.max(0, json.optLong("mtimeMs", 0));
            entry.documentId = json.optString("documentId", "");
            return entry;
        }

        static SnapshotEntry fromServer(JSONObject json) throws Exception {
            SnapshotEntry entry = new SnapshotEntry();
            entry.stableId = json.getString("stableId");
            if (!entry.stableId.matches("^[A-Za-z0-9_-]{8,64}$")) throw new Exception("invalid_stable_id");
            entry.rel = cleanRel(json.getString("rel"));
            entry.contentHash = json.getString("contentHash").toLowerCase(Locale.ROOT);
            if (!entry.contentHash.matches("^[a-f0-9]{64}$")) throw new Exception("invalid_sync_hash");
            entry.size = Math.max(0, json.optLong("size", 0));
            entry.mtimeMs = Math.max(0, json.optLong("mtimeMs", 0));
            return entry;
        }

        JSONObject toJson() throws Exception {
            return new JSONObject().put("stableId", stableId).put("rel", rel)
                    .put("contentHash", contentHash).put("size", size).put("mtimeMs", mtimeMs)
                    .put("documentId", documentId == null ? "" : documentId);
        }
    }

    private static class FabricState {
        final String server;
        final String base;
        boolean initialized;
        long cursor;
        final HashMap<String, SnapshotEntry> entries = new HashMap<>();
        FabricState(String server, String base) { this.server = server; this.base = base; }
    }

    private static class SyncStats {
        int uploaded;
        int downloaded;
        int conflicts;
        int deleted;
        int skippedLarge;
        boolean incomplete;
        void add(SyncStats other) {
            uploaded += other.uploaded; downloaded += other.downloaded;
            conflicts += other.conflicts; deleted += other.deleted;
            skippedLarge += other.skippedLarge; incomplete |= other.incomplete;
        }
    }

    private static class EndpointSelection {
        final String server;
        final String token;
        final boolean fabric;
        final boolean resumable;
        EndpointSelection(String server, String token, boolean fabric, boolean resumable) {
            this.server = server; this.token = token; this.fabric = fabric; this.resumable = resumable;
        }
    }

    private static class EndpointCapabilities {
        final boolean fabric;
        final boolean resumable;
        EndpointCapabilities(boolean fabric, boolean resumable) {
            this.fabric = fabric; this.resumable = resumable;
        }
    }

    private static class WorkFolder {
        final String label;
        final String base;
        final JSONObject config;
        final ScanResult scan;
        final boolean camera;
        final ArrayList<FileItem> files = new ArrayList<>();
        WorkFolder(String label, String base, JSONObject config, ScanResult scan, boolean camera) {
            this.label = label; this.base = base; this.config = config; this.scan = scan; this.camera = camera;
        }
    }

    private static class Stopped extends Exception { }
    private static class Unauthorized extends Exception { }
    private static class HttpFailure extends Exception {
        final int status;
        final JSONObject body;
        HttpFailure(int status, JSONObject body) {
            super(body == null ? "http_" + status : body.optString("error", "http_" + status));
            this.status = status;
            this.body = body == null ? new JSONObject() : body;
        }
    }
}
