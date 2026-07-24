package org.aerie.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.widget.TextView;

import androidx.core.content.FileProvider;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Re-verifies the staged APK, then hands it to Android's user-controlled installer. */
public final class UpdateInstallActivity extends Activity {
    private final ExecutorService verifier = Executors.newSingleThreadExecutor(
            runnable -> new Thread(runnable, "aerie-update-verifier"));
    private boolean validating;
    private boolean reviewVisible;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        TextView progress = new TextView(this);
        progress.setText("Verifying the Aerie update…");
        progress.setTextSize(18);
        progress.setGravity(Gravity.CENTER);
        progress.setPadding(48, 64, 48, 64);
        setContentView(progress);
        validateAndReview();
    }

    @Override protected void onResume() {
        super.onResume();
        // Returning from “Install unknown apps” never starts installation by
        // itself. It presents the review again and requires another tap.
        if (!validating && !reviewVisible) validateAndReview();
    }

    private void validateAndReview() {
        if (validating || reviewVisible || isFinishing()) return;
        validating = true;
        verifier.execute(() -> {
            UpdateManager.Release release = UpdateManager.readyForReview(this);
            File apk = release == null ? null : UpdateManager.apkFile(this, release);
            Exception error = null;
            try {
                if (release == null || apk == null) throw new Exception("No verified update is ready.");
                UpdateManager.validateStaged(this, release, apk);
            } catch (Exception invalid) { error = invalid; }
            UpdateManager.Release checked = release;
            File checkedApk = apk;
            Exception finalError = error;
            runOnUiThread(() -> {
                validating = false;
                if (finalError != null) {
                    UpdateManager.clearReady(this, checked);
                    reviewVisible = true;
                    new AlertDialog.Builder(this).setTitle("Update unavailable")
                            .setMessage("The downloaded package could not be verified and was removed. "
                                    + "Aerie will check for a fresh copy later.")
                            .setPositiveButton("OK", (dialog, which) -> finish()).setCancelable(false).show();
                } else showReview(checked, checkedApk);
            });
        });
    }

    private void showReview(UpdateManager.Release release, File apk) {
        reviewVisible = true;
        StringBuilder message = new StringBuilder("The package, app identity, version, and signing certificate all match.\n\n")
                .append("Version ").append(release.version).append(" (build ").append(release.build).append(")")
                .append("\nSize: ").append(readableSize(release.size));
        if (release.notes != null && !release.notes.isEmpty()) message.append("\n\n").append(release.notes);
        new AlertDialog.Builder(this).setTitle("Install verified Aerie update?")
                .setMessage(message.toString())
                .setNegativeButton("Later", (dialog, which) -> finish())
                .setPositiveButton("Continue", (dialog, which) -> {
                    reviewVisible = false;
                    continueToInstaller(release, apk);
                }).setCancelable(false).show();
    }

    private void continueToInstaller(UpdateManager.Release release, File apk) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            reviewVisible = true;
            new AlertDialog.Builder(this).setTitle("Allow updates from Aerie")
                    .setMessage("Android must allow Aerie to open its package installer. Enable this app on the next screen, then return and tap Continue again.")
                    .setNegativeButton("Cancel", (dialog, which) -> finish())
                    .setPositiveButton("Open settings", (dialog, which) -> {
                        reviewVisible = false;
                        Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + getPackageName()));
                        startActivity(settings);
                    }).show();
            return;
        }
        validating = true;
        TextView progress = new TextView(this);
        progress.setText("Checking the package one last time…");
        progress.setTextSize(18); progress.setGravity(Gravity.CENTER); progress.setPadding(48, 64, 48, 64);
        setContentView(progress);
        verifier.execute(() -> {
            Exception failure = null;
            Intent install = null;
            try {
                // Re-check immediately before crossing the FileProvider boundary.
                UpdateManager.validateStaged(this, release, apk);
                Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".updates", apk);
                install = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                if (install.resolveActivity(getPackageManager()) == null)
                    throw new Exception("installer_unavailable");
            } catch (Exception error) { failure = error; }
            Intent checkedIntent = install;
            Exception checkedFailure = failure;
            runOnUiThread(() -> {
                validating = false;
                if (checkedFailure == null) {
                    startActivity(checkedIntent);
                    finish();
                    return;
                }
                UpdateManager.clearReady(this, release);
                reviewVisible = true;
                new AlertDialog.Builder(this).setTitle("Can't open the installer")
                        .setMessage("The staged update was removed. Aerie will download a fresh verified package later.")
                        .setPositiveButton("OK", (dialog, which) -> finish()).show();
            });
        });
    }

    private static String readableSize(long bytes) {
        if (bytes < 1024L * 1024L) return Math.max(1, bytes / 1024L) + " KB";
        return String.format(java.util.Locale.getDefault(), "%.1f MB", bytes / (1024d * 1024d));
    }

    @Override protected void onDestroy() {
        verifier.shutdownNow();
        super.onDestroy();
    }
}
