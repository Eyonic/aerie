package org.aerie.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/** Durable, foreground uploader for app-private Sharesheet batches. */
public final class ShareUploadWorker extends Worker {
    static final String INPUT_BATCH = "batchId";
    private static final String CHANNEL = "aerie_share_uploads";
    private static final int CHUNK_BYTES = 8 * 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 256 * 1024;
    private int notificationId = 51;

    public ShareUploadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull @Override public Result doWork() {
        String id = getInputData().getString(INPUT_BATCH);
        try {
            if (id != null) notificationId = 1000 + Math.floorMod(id.hashCode(), 20_000);
            ensureChannel();
            setForegroundAsync(foreground("Preparing upload", 0, 0)).get(10, TimeUnit.SECONDS);
            JSONObject manifest = ShareBatch.read(getApplicationContext(), id);
            String destination = manifest.optString("destination", "");
            JSONArray items = manifest.optJSONArray("items");
            long createdAt = manifest.optLong("createdAt", -1);
            long now = System.currentTimeMillis();
            if (!SharePolicy.destinationAllowed(destination) || items == null || items.length() == 0
                    || items.length() > SharePolicy.MAX_ITEMS || createdAt <= 0
                    || createdAt > now + 5 * 60_000L || now - createdAt > ShareBatch.MAX_AGE_MS)
                throw new Permanent("invalid_share_manifest");
            long total = manifest.optLong("totalBytes", -1);
            if (total < 0 || total > SharePolicy.MAX_BATCH_BYTES) throw new Permanent("invalid_share_size");
            long completedBefore = 0;
            long declaredTotal = 0;
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) throw new Permanent("invalid_share_item");
                declaredTotal = SharePolicy.checkedTotal(declaredTotal, item.optLong("size", -1));
            }
            if (declaredTotal != total) throw new Permanent("invalid_share_size");
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) throw new Permanent("invalid_share_item");
                long size = item.optLong("size", -1);
                if (item.optBoolean("complete", false)) { completedBefore += Math.max(0, size); continue; }
                File file = stagedFile(id, item, i);
                uploadItem(id, manifest, item, file, destination, completedBefore, total);
                completedBefore += size;
                item.put("complete", true).put("offset", size).remove("uploadId");
                ShareBatch.write(getApplicationContext(), id, manifest);
                if (file.exists() && !file.delete()) throw new Exception("share_cleanup_failed");
            }
            notifyFinished("Shared to Aerie", "Your items are now in " + destination, false);
            ShareBatch.remove(getApplicationContext(), id);
            return Result.success();
        } catch (Permanent invalid) {
            notifyFinished("Share couldn't be uploaded", "Please share the items to Aerie again", true);
            ShareBatch.remove(getApplicationContext(), id);
            return Result.failure();
        } catch (Exception retryable) {
            notifyFinished("Share paused", "Aerie will resume when your server is reachable", true);
            return Result.retry();
        }
    }

    private void uploadItem(String batchId, JSONObject manifest, JSONObject item, File file,
                            String destination, long completedBefore, long total) throws Exception {
        String hash = item.optString("sha256", "");
        if (!hash.matches("^[a-f0-9]{64}$")) {
            hash = sha256(file);
            item.put("sha256", hash);
            ShareBatch.write(getApplicationContext(), batchId, manifest);
        }
        String preferred = item.optString("server", null);
        List<String> servers = ServerEndpointResolver.candidates(getApplicationContext(), preferred);
        if (servers.isEmpty()) throw new Exception("server_not_configured");
        Exception last = null;
        for (String server : servers) {
            if (isStopped()) throw new Exception("share_cancelled");
            String token = DeviceAuthClient.validToken(getApplicationContext(), server);
            if (token == null || token.isEmpty()) continue;
            try {
                if (!server.equals(item.optString("server", null))) {
                    item.put("server", server).put("uploadId", JSONObject.NULL).put("offset", 0);
                    ShareBatch.write(getApplicationContext(), batchId, manifest);
                }
                JSONObject initBody = new JSONObject().put("path", destination)
                        .put("relativePath", item.getString("name")).put("size", item.getLong("size"))
                        .put("lastModified", item.optLong("lastModified", 0));
                String priorId = item.optString("uploadId", "");
                if (priorId.matches("^[a-f0-9-]{36}$")) initBody.put("uploadId", priorId);
                JSONObject init = json(server, token, "POST", "/api/files/upload-resumable/init", initBody);
                String uploadId = init.optString("uploadId", "");
                long offset = init.optLong("offset", -1);
                long size = item.getLong("size");
                if (!uploadId.matches("^[a-f0-9-]{36}$") || offset < 0 || offset > size
                        || init.optLong("size", -1) != size) throw new Exception("invalid_upload_session");
                item.put("uploadId", uploadId).put("offset", offset);
                ShareBatch.write(getApplicationContext(), batchId, manifest);

                try (FileInputStream input = new FileInputStream(file)) {
                    byte[] buffer = new byte[CHUNK_BYTES];
                    while (offset < size) {
                        if (isStopped()) throw new Exception("share_cancelled");
                        input.getChannel().position(offset);
                        int wanted = (int) Math.min(buffer.length, size - offset);
                        int count = 0;
                        while (count < wanted) {
                            int read = input.read(buffer, count, wanted - count);
                            if (read < 0) break;
                            if (read > 0) count += read;
                        }
                        if (count != wanted) throw new Permanent("share_staging_truncated");
                        byte[] chunk = count == buffer.length ? buffer : Arrays.copyOf(buffer, count);
                        try {
                            JSONObject response = patch(server, token, uploadId, offset, chunk);
                            long next = response.optLong("offset", -1);
                            if (next <= offset || next > size) throw new Exception("invalid_upload_offset");
                            offset = next;
                        } catch (HttpFailure failure) {
                            if (failure.status != 409) throw failure;
                            long actual = failure.body.optLong("offset", -1);
                            if (actual < 0 || actual > size || actual == offset)
                                throw new Exception("invalid_upload_offset");
                            offset = actual;
                        }
                        item.put("offset", offset);
                        ShareBatch.write(getApplicationContext(), batchId, manifest);
                        int percent = total <= 0 ? 0 : (int) Math.min(100,
                                ((completedBefore + offset) * 100L) / total);
                        updateForeground("Uploading " + item.getString("name"), percent, 100);
                        setProgressAsync(new androidx.work.Data.Builder().putInt("progress", percent)
                                .putString("name", item.getString("name")).build());
                    }
                }
                JSONObject complete = json(server, token, "POST",
                        "/api/files/upload-resumable/" + Uri.encode(uploadId) + "/complete",
                        new JSONObject().put("sha256", hash));
                if (!complete.optBoolean("ok", false)) throw new Exception("upload_commit_failed");
                getApplicationContext().getSharedPreferences("aerie", Context.MODE_PRIVATE).edit()
                        .putString("active_base", server).apply();
                return;
            } catch (HttpFailure failure) {
                if (failure.status == 400 || failure.status == 403 || failure.status == 413)
                    throw new Permanent(failure.getMessage());
                last = failure;
            } catch (Permanent permanent) { throw permanent; }
            catch (Exception error) { last = error; }
        }
        throw last == null ? new Exception("authentication_required") : last;
    }

    private File stagedFile(String batchId, JSONObject item, int index) throws Exception {
        String local = item.optString("local", "");
        String name = item.optString("name", "");
        long size = item.optLong("size", -1);
        if (!local.equals(String.format(Locale.US, "item-%04d.data", index))
                || !SharePolicy.safeFilename(name, index).equals(name)
                || size < 0 || size > SharePolicy.MAX_ITEM_BYTES) throw new Permanent("invalid_share_item");
        File dir = ShareBatch.directory(getApplicationContext(), batchId).getCanonicalFile();
        File file = new File(dir, local).getCanonicalFile();
        if (!dir.equals(file.getParentFile()) || !file.isFile() || file.length() != size)
            throw new Permanent("share_staging_missing");
        return file;
    }

    private JSONObject patch(String server, String token, String id, long offset, byte[] chunk) throws Exception {
        HttpURLConnection connection = open(server + "/api/files/upload-resumable/" + Uri.encode(id), token, "PATCH");
        try {
            connection.setRequestProperty("Content-Type", "application/octet-stream");
            connection.setRequestProperty("X-Upload-Offset", String.valueOf(offset));
            connection.setRequestProperty("X-Chunk-SHA256", sha256(chunk));
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(chunk.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(chunk); }
            return response(connection);
        } finally { connection.disconnect(); }
    }

    private JSONObject json(String server, String token, String method, String endpoint, JSONObject body) throws Exception {
        HttpURLConnection connection = open(server + endpoint, token, method);
        try {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            return response(connection);
        } finally { connection.disconnect(); }
    }

    private static HttpURLConnection open(String url, String token, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Accept-Encoding", "identity");
        return connection;
    }

    private static JSONObject response(HttpURLConnection connection) throws Exception {
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300
                ? connection.getInputStream() : connection.getErrorStream();
        byte[] bytes = stream == null ? new byte[0] : readLimited(stream, MAX_RESPONSE_BYTES);
        JSONObject body;
        try { body = bytes.length == 0 ? new JSONObject() : new JSONObject(new String(bytes, StandardCharsets.UTF_8)); }
        catch (Exception invalid) { throw new Exception("invalid_upload_response"); }
        if (status < 200 || status >= 300) throw new HttpFailure(status, body);
        return body;
    }

    private ForegroundInfo foreground(String text, int done, int total) {
        return new ForegroundInfo(notificationId, notification(text, done, total, true),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    }

    private void updateForeground(String text, int done, int total) {
        NotificationManager manager = getApplicationContext().getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(notificationId, notification(text, done, total, true));
    }

    private Notification notification(String text, int done, int total, boolean ongoing) {
        Intent open = new Intent(getApplicationContext(), MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getApplicationContext(), CHANNEL)
                .setSmallIcon(ongoing ? android.R.drawable.stat_sys_upload : android.R.drawable.stat_sys_upload_done)
                .setContentTitle(ongoing ? "Sharing to Aerie" : "Aerie share")
                .setContentText(text).setOnlyAlertOnce(ongoing).setOngoing(ongoing)
                .setContentIntent(PendingIntent.getActivity(getApplicationContext(), 0, open,
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        if (ongoing) builder.setProgress(total, Math.min(done, total), total <= 0);
        return builder.build();
    }

    private void notifyFinished(String title, String text, boolean error) {
        NotificationManager manager = getApplicationContext().getSystemService(NotificationManager.class);
        if (manager == null) return;
        Intent open = new Intent(getApplicationContext(), MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Notification notification = new NotificationCompat.Builder(getApplicationContext(), CHANNEL)
                .setSmallIcon(error ? android.R.drawable.stat_notify_error : android.R.drawable.stat_sys_upload_done)
                .setContentTitle(title).setContentText(text).setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(getApplicationContext(), notificationId, open,
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build();
        manager.notify(notificationId, notification);
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getApplicationContext().getSystemService(NotificationManager.class);
        if (manager != null && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Shared uploads",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Progress for items shared to Aerie");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[64 * 1024];
            for (int count; (count = input.read(buffer)) >= 0; ) if (count > 0) digest.update(buffer, 0, count);
        }
        return hex(digest.digest());
    }

    private static String sha256(byte[] bytes) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.US, "%02x", value & 0xff));
        return out.toString();
    }

    private static byte[] readLimited(InputStream input, int max) throws Exception {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int count; (count = in.read(buffer)) >= 0; ) {
                if (count <= 0) continue;
                if (count > max - out.size()) throw new Exception("upload_response_too_large");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    private static final class Permanent extends Exception {
        Permanent(String reason) { super(reason); }
    }

    private static final class HttpFailure extends Exception {
        final int status;
        final JSONObject body;
        HttpFailure(int status, JSONObject body) {
            super(body.optString("error", "http_" + status));
            this.status = status; this.body = body;
        }
    }
}
