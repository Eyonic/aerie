package org.aerie.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import androidx.work.Constraints;
import androidx.core.app.NotificationCompat;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/** Scheduling and trust boundary for Aerie's sideloaded app updates. */
final class UpdateManager {
    static final String CHANNEL = "aerie_verified_updates";
    static final int READY_NOTIFICATION_ID = 41;
    private static final String PERIODIC_WORK = "aerie-verified-update-check";
    private static final String STARTUP_WORK = "aerie-startup-update-check";
    private static final String READY_RELEASE = "verified_update_ready_v1";
    private static final String LAST_CHECK = "verified_update_last_check_v1";

    private UpdateManager() { }

    static void schedule(Context context) {
        Context app = context.getApplicationContext();
        // MY_PACKAGE_REPLACED reaches this path after a successful install. Drop
        // the old staged APK and notification before scheduling the next check.
        readyForReview(app);
        ensureChannel(app);
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .setRequiresBatteryNotLow(true)
                .build();
        PeriodicWorkRequest periodic = new PeriodicWorkRequest.Builder(
                UpdateWorker.class, 24, TimeUnit.HOURS)
                .setConstraints(constraints)
                .addTag(PERIODIC_WORK)
                .build();
        WorkManager manager = WorkManager.getInstance(app);
        manager.enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.UPDATE, periodic);

        long checked = app.getSharedPreferences("aerie", Context.MODE_PRIVATE).getLong(LAST_CHECK, 0);
        if (checked <= 0 || System.currentTimeMillis() - checked >= TimeUnit.HOURS.toMillis(12)) {
            OneTimeWorkRequest startup = new OneTimeWorkRequest.Builder(UpdateWorker.class)
                    .setConstraints(constraints).addTag(STARTUP_WORK).build();
            manager.enqueueUniqueWork(STARTUP_WORK, ExistingWorkPolicy.KEEP, startup);
        }
    }

    static void checked(Context context) {
        context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit()
                .putLong(LAST_CHECK, System.currentTimeMillis()).apply();
    }

    static File updateDir(Context context) {
        File dir = new File(context.getFilesDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) return null;
        return dir.isDirectory() ? dir : null;
    }

    static File partFile(Context context, Release release) {
        File dir = updateDir(context);
        return dir == null ? null : new File(dir, "aerie-update-" + release.build + ".apk.part");
    }

    static File apkFile(Context context, Release release) {
        File dir = updateDir(context);
        return dir == null ? null : new File(dir, "aerie-update-" + release.build + ".apk");
    }

    static long installedBuild(Context context) throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    static void validateStaged(Context context, Release release, File apk) throws Exception {
        UpdatePolicy.validateRelease(true, true, release.filename, release.url, release.size,
                release.sha256, release.version, release.build, release.certificateSha256,
                installedBuild(context));
        File expected = apkFile(context, release);
        if (expected == null || apk == null || !expected.getCanonicalFile().equals(apk.getCanonicalFile())
                || !apk.isFile() || apk.length() != release.size)
            throw new Exception("staged_update_missing");
        if (!release.sha256.equals(sha256(apk))) throw new Exception("staged_update_hash_mismatch");

        PackageManager pm = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28
                ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        PackageInfo installed = pm.getPackageInfo(context.getPackageName(), flags);
        if (archive == null || !context.getPackageName().equals(archive.packageName))
            throw new Exception("update_package_mismatch");
        long archiveBuild = Build.VERSION.SDK_INT >= 28
                ? archive.getLongVersionCode() : archive.versionCode;
        if (archiveBuild != release.build || archiveBuild <= installedBuild(context)
                || archive.versionName == null || !archive.versionName.equals(release.version))
            throw new Exception("update_version_mismatch");
        if (!UpdatePolicy.sameSignerSet(signers(installed), signers(archive), release.certificateSha256))
            throw new Exception("update_signer_mismatch");
    }

    static synchronized void saveReady(Context context, Release release) {
        context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit()
                .putString(READY_RELEASE, release.toJson().toString()).commit();
    }

    static synchronized Release ready(Context context) {
        try {
            String raw = context.getSharedPreferences("aerie", Context.MODE_PRIVATE)
                    .getString(READY_RELEASE, null);
            return raw == null ? null : Release.fromStored(new JSONObject(raw));
        } catch (Exception ignored) { return null; }
    }

    /**
     * Returns a staged release worth presenting to the user. This is deliberately
     * only a cheap metadata/file-size gate; UpdateInstallActivity performs the
     * full hash, package, version, and signer checks away from the UI thread.
     */
    static synchronized Release readyForReview(Context context) {
        SharedPreferences preferences = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
        Release release = ready(context);
        if (release == null) {
            // Corrupt persisted metadata must not leave a dead notification that
            // can only ever open an unavailable update.
            if (preferences.contains(READY_RELEASE)) clearReady(context, null);
            return null;
        }
        try {
            File apk = apkFile(context, release);
            long stagedBytes = apk != null && apk.isFile() ? apk.length() : -1;
            if (!UpdatePolicy.canOfferReadyRelease(release.build, installedBuild(context),
                    release.size, stagedBytes)) {
                clearReady(context, release);
                return null;
            }
            return release;
        } catch (Exception ignored) {
            // PackageManager can fail transiently. Preserve the verified state so
            // a later foreground/scheduled pass can retry instead of redownloading.
            return null;
        }
    }

    static synchronized void clearReady(Context context, Release release) {
        context.getSharedPreferences("aerie", Context.MODE_PRIVATE).edit().remove(READY_RELEASE).commit();
        if (release != null) {
            File apk = apkFile(context, release);
            if (apk != null && apk.isFile()) apk.delete();
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(READY_NOTIFICATION_ID);
    }

    static void notifyReady(Context context, Release release) {
        ensureChannel(context);
        Intent open = new Intent(context, UpdateInstallActivity.class);
        PendingIntent pending = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        android.app.Notification notification = new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Aerie " + release.version + " is ready")
                .setContentText("Tap to review and let Android install the verified update")
                .setContentIntent(pending).setAutoCancel(false).setOnlyAlertOnce(true).build();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(READY_NOTIFICATION_ID, notification);
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "App updates",
                    NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Verified Aerie updates that are ready for your approval");
            manager.createNotificationChannel(channel);
        }
    }

    static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[64 * 1024];
            for (int count; (count = input.read(buffer)) >= 0; ) if (count > 0) digest.update(buffer, 0, count);
        }
        StringBuilder out = new StringBuilder(64);
        for (byte value : digest.digest()) out.append(String.format(Locale.US, "%02x", value & 0xff));
        return out.toString();
    }

    private static Set<String> signers(PackageInfo info) throws Exception {
        Signature[] values;
        if (Build.VERSION.SDK_INT >= 28) {
            if (info.signingInfo == null) throw new Exception("update_signer_missing");
            values = info.signingInfo.getApkContentsSigners();
        } else values = info.signatures;
        HashSet<String> result = new HashSet<>();
        if (values != null) for (Signature signature : values) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(signature.toByteArray());
            StringBuilder out = new StringBuilder(64);
            for (byte value : hash) out.append(String.format(Locale.US, "%02x", value & 0xff));
            result.add(out.toString());
        }
        return result;
    }

    static final class Release {
        final String server;
        final String filename;
        final String url;
        final long size;
        final String sha256;
        final String version;
        final long build;
        final String certificateSha256;
        final String notes;

        Release(String server, String filename, String url, long size, String sha256,
                String version, long build, String certificateSha256, String notes) {
            this.server = server; this.filename = filename; this.url = url; this.size = size;
            this.sha256 = sha256.toLowerCase(Locale.ROOT); this.version = version; this.build = build;
            this.certificateSha256 = certificateSha256.toLowerCase(Locale.ROOT); this.notes = notes;
        }

        static Release fromCatalog(String server, JSONObject root, long installedBuild) throws Exception {
            if (root.optInt("schemaVersion", 0) != 1) throw new Exception("invalid_release_catalog");
            JSONArray platforms = root.optJSONArray("platforms");
            if (platforms == null) throw new Exception("invalid_release_catalog");
            for (int i = 0; i < platforms.length(); i++) {
                JSONObject item = platforms.optJSONObject(i);
                if (item == null || !"android".equals(item.optString("key"))) continue;
                if (!item.optBoolean("available", false)) return null;
                String filename = item.optString("filename", null);
                String url = item.optString("url", null);
                long size = item.optLong("sizeBytes", -1);
                String hash = item.optString("sha256", null);
                String version = item.optString("version", null);
                long build = item.optLong("build", -1);
                String certificate = item.optString("certificateSha256", null);
                try {
                    UpdatePolicy.validateRelease(true, item.optBoolean("verified", false), filename,
                            url, size, hash, version, build, certificate, installedBuild);
                } catch (IllegalArgumentException invalid) {
                    if ("update_not_newer".equals(invalid.getMessage())) return null;
                    throw invalid;
                }
                return new Release(ServerEndpointResolver.normalize(server), filename, url, size,
                        hash, version, build, certificate, bounded(item.optString("notes", ""), 500));
            }
            return null;
        }

        static Release fromStored(JSONObject item) throws Exception {
            String server = ServerEndpointResolver.normalize(item.optString("server", null));
            Release release = new Release(server, item.optString("filename", null),
                    item.optString("url", null), item.optLong("size", -1),
                    item.optString("sha256", null), item.optString("version", null),
                    item.optLong("build", -1), item.optString("certificateSha256", null),
                    bounded(item.optString("notes", ""), 500));
            if (server == null) throw new Exception("invalid_update_server");
            UpdatePolicy.validateRelease(true, true, release.filename, release.url, release.size,
                    release.sha256, release.version, release.build, release.certificateSha256, 0);
            return release;
        }

        JSONObject toJson() {
            try {
                return new JSONObject().put("schemaVersion", 1).put("server", server)
                        .put("filename", filename).put("url", url).put("size", size)
                        .put("sha256", sha256).put("version", version).put("build", build)
                        .put("certificateSha256", certificateSha256).put("notes", notes);
            } catch (Exception impossible) { return new JSONObject(); }
        }

        private static String bounded(String value, int max) {
            if (value == null) return "";
            String clean = value.trim();
            return clean.substring(0, Math.min(max, clean.length()));
        }
    }
}
