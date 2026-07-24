package org.aerie.app;

import android.app.Notification;
import android.content.Context;
import android.content.pm.ServiceInfo;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;

/** Downloads only release artifacts whose server metadata and APK identity agree. */
public final class UpdateWorker extends Worker {
    private static final int DOWNLOAD_NOTIFICATION_ID = 40;
    private static final int MAX_CATALOG_BYTES = 256 * 1024;

    public UpdateWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        List<String> servers = ServerEndpointResolver.candidates(context, null);
        if (servers.isEmpty()) return Result.success();
        Exception last = null;
        boolean catalogReached = false;
        boolean updateAvailable = false;
        try {
            long installed = UpdateManager.installedBuild(context);
            for (String server : servers) {
                if (isStopped()) return Result.failure();
                try {
                    JSONObject catalog = catalog(server);
                    catalogReached = true;
                    UpdateManager.Release release = UpdateManager.Release.fromCatalog(server, catalog, installed);
                    if (release == null) {
                        UpdateManager.checked(context);
                        return Result.success();
                    }
                    updateAvailable = true;
                    File apk = UpdateManager.apkFile(context, release);
                    if (apk == null) throw new Exception("update_storage_unavailable");
                    try {
                        UpdateManager.validateStaged(context, release, apk);
                    } catch (Exception invalidExisting) {
                        if (apk.exists()) apk.delete();
                        download(release, apk, true);
                        UpdateManager.validateStaged(context, release, apk);
                    }
                    UpdateManager.saveReady(context, release);
                    UpdateManager.notifyReady(context, release);
                    UpdateManager.checked(context);
                    cleanupOtherUpdates(apk);
                    return Result.success();
                } catch (IllegalArgumentException invalidMetadata) {
                    // A reachable server supplied an unsafe/unverified catalog.
                    // Never downgrade this into an unverified download.
                    last = invalidMetadata;
                } catch (Exception error) {
                    last = error;
                }
            }
        } catch (Exception error) { last = error; }
        if (catalogReached) {
            UpdateManager.checked(context);
            return updateAvailable ? Result.retry() : Result.success();
        }
        return last == null ? Result.success() : Result.retry();
    }

    private JSONObject catalog(String server) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(server + "/api/apps").openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(20_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Accept-Encoding", "identity");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new Exception("update_catalog_" + status);
            return new JSONObject(new String(readLimited(connection.getInputStream(), MAX_CATALOG_BYTES),
                    StandardCharsets.UTF_8));
        } finally { connection.disconnect(); }
    }

    private void download(UpdateManager.Release release, File destination, boolean retry) throws Exception {
        File part = UpdateManager.partFile(getApplicationContext(), release);
        if (part == null) throw new Exception("update_storage_unavailable");
        long offset = part.isFile() ? part.length() : 0;
        if (offset > release.size) {
            part.delete();
            offset = 0;
        }
        if (offset < release.size) {
            Notification progress = new NotificationCompat.Builder(getApplicationContext(), UpdateManager.CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_sys_download)
                    .setContentTitle("Downloading Aerie " + release.version)
                    .setContentText("The package will be verified before you can install it")
                    .setOnlyAlertOnce(true).setOngoing(true).setProgress(100, 0, true).build();
            setForegroundAsync(new ForegroundInfo(DOWNLOAD_NOTIFICATION_ID, progress,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC));

            HttpURLConnection connection = (HttpURLConnection) new URL(release.server + release.url).openConnection();
            try {
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(60_000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Accept-Encoding", "identity");
                if (offset > 0) connection.setRequestProperty("Range", "bytes=" + offset + "-");
                int status = connection.getResponseCode();
                if (status == 416 && retry) {
                    connection.disconnect();
                    part.delete();
                    download(release, destination, false);
                    return;
                }
                UpdatePolicy.DownloadPlan plan = UpdatePolicy.validateDownloadResponse(status, offset,
                        release.size, connection.getHeaderField("Content-Length"),
                        connection.getHeaderField("Content-Range"));
                try (InputStream input = new BufferedInputStream(connection.getInputStream());
                     FileOutputStream output = new FileOutputStream(part, plan.append)) {
                    byte[] buffer = new byte[64 * 1024];
                    long received = 0;
                    for (int count; (count = input.read(buffer)) >= 0; ) {
                        if (isStopped()) throw new Exception("update_cancelled");
                        if (count <= 0) continue;
                        received = UpdatePolicy.checkedByteCount(received, count, plan.expectedBytes);
                        output.write(buffer, 0, count);
                        int complete = (int) Math.min(100, ((offset + received) * 100L) / release.size);
                        setProgressAsync(new androidx.work.Data.Builder().putInt("progress", complete).build());
                    }
                    output.getFD().sync();
                    if (received != plan.expectedBytes) throw new Exception("update_download_truncated");
                }
            } catch (Exception error) {
                if (part.length() > release.size) part.delete();
                throw error;
            } finally { connection.disconnect(); }
        }
        if (part.length() != release.size || !release.sha256.equals(UpdateManager.sha256(part))) {
            part.delete();
            if (retry) {
                download(release, destination, false);
                return;
            }
            throw new Exception("update_download_hash_mismatch");
        }
        if (destination.exists() && !destination.delete()) throw new Exception("update_replace_failed");
        if (!part.renameTo(destination)) throw new Exception("update_commit_failed");
    }

    private void cleanupOtherUpdates(File keep) {
        File dir = keep.getParentFile();
        File[] files = dir == null ? null : dir.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (!file.equals(keep) && file.getName().matches("^aerie-update-[0-9]+\\.apk(?:\\.part)?$"))
                file.delete();
        }
    }

    private static byte[] readLimited(InputStream input, int max) throws Exception {
        if (input == null) throw new Exception("empty_update_catalog");
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int count; (count = in.read(buffer)) >= 0; ) {
                if (count <= 0) continue;
                if (count > max - out.size()) throw new Exception("update_catalog_too_large");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }
}
