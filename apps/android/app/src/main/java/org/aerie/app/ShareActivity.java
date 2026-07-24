package org.aerie.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Android Sharesheet target. URI grants are staged before this activity exits. */
public final class ShareActivity extends Activity {
    private final ExecutorService staging = Executors.newSingleThreadExecutor(
            runnable -> new Thread(runnable, "aerie-share-staging"));
    private TextView status;
    private ProgressBar progress;
    private String activeBatch;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER_HORIZONTAL);
        layout.setPadding(48, 48, 48, 48);
        status = new TextView(this);
        status.setText("Preparing your share…");
        status.setTextSize(18);
        status.setGravity(Gravity.CENTER);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        layout.addView(status, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(-1, -2);
        progressParams.topMargin = 32;
        layout.addView(progress, progressParams);
        setContentView(layout);

        Intent intent = getIntent();
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            fail("This share request isn't supported.");
            return;
        }
        List<Uri> uris = sharedUris(intent);
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        // EXTRA_TEXT commonly accompanies a streamed file as a caption. Avoid
        // surprising users with an additional synthetic text document.
        if (!uris.isEmpty()) text = null;
        if (uris.isEmpty() && (text == null || text.length() == 0)) {
            fail("No file or text was included.");
            return;
        }
        if (uris.size() > SharePolicy.MAX_ITEMS || text != null && text.length() > 1_000_000) {
            fail("That share is too large to stage safely.");
            return;
        }
        chooseDestination(uris, text);
    }

    private void chooseDestination(List<Uri> uris, CharSequence text) {
        String[] labels = { "Inbox", "Photos / Shared", "Documents" };
        new AlertDialog.Builder(this).setTitle("Save in Aerie")
                .setItems(labels, (dialog, which) -> stage(uris, text, SharePolicy.DESTINATIONS[which]))
                .setNegativeButton("Cancel", (dialog, which) -> finish())
                .setOnCancelListener(dialog -> finish()).show();
    }

    private void stage(List<Uri> uris, CharSequence sharedText, String destination) {
        if (!SharePolicy.destinationAllowed(destination)) { fail("Invalid destination."); return; }
        activeBatch = ShareBatch.newId();
        status.setText("Copying shared items into Aerie…");
        progress.setIndeterminate(false);
        progress.setMax(Math.max(1, uris.size() + (sharedText == null ? 0 : 1)));
        progress.setProgress(0);
        staging.execute(() -> {
            try {
                File dir = ShareBatch.directory(this, activeBatch);
                if (!dir.mkdirs() && !dir.isDirectory()) throw new Exception("share_staging_unavailable");
                JSONArray items = new JSONArray();
                Set<String> names = new HashSet<>();
                long batchBytes = 0;
                int index = 0;
                for (Uri uri : uris) {
                    if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                    String name = SharePolicy.makeUnique(SharePolicy.safeFilename(displayName(uri), index), names);
                    String mime = getContentResolver().getType(uri);
                    if (mime == null || mime.length() > 128 || mime.indexOf('/') <= 0)
                        mime = "application/octet-stream";
                    File target = new File(dir, String.format(java.util.Locale.US, "item-%04d.data", index));
                    long size = copyUri(uri, target);
                    batchBytes = SharePolicy.checkedTotal(batchBytes, size);
                    items.put(new JSONObject().put("local", target.getName()).put("name", name)
                            .put("mime", mime).put("size", size).put("lastModified", System.currentTimeMillis())
                            .put("uploadId", JSONObject.NULL).put("server", JSONObject.NULL)
                            .put("offset", 0).put("complete", false));
                    int done = ++index;
                    runOnUiThread(() -> { progress.setProgress(done); status.setText("Prepared " + done + " item(s)…"); });
                }
                if (sharedText != null && sharedText.length() > 0) {
                    byte[] bytes = sharedText.toString().getBytes(StandardCharsets.UTF_8);
                    batchBytes = SharePolicy.checkedTotal(batchBytes, bytes.length);
                    String name = SharePolicy.makeUnique("Shared text.txt", names);
                    File target = new File(dir, String.format(java.util.Locale.US, "item-%04d.data", index));
                    try (FileOutputStream output = new FileOutputStream(target, false)) {
                        output.write(bytes); output.getFD().sync();
                    }
                    items.put(new JSONObject().put("local", target.getName()).put("name", name)
                            .put("mime", "text/plain").put("size", bytes.length)
                            .put("lastModified", System.currentTimeMillis()).put("uploadId", JSONObject.NULL)
                            .put("server", JSONObject.NULL).put("offset", 0).put("complete", false));
                    int done = ++index;
                    runOnUiThread(() -> progress.setProgress(done));
                }
                JSONObject manifest = new JSONObject().put("schemaVersion", 1).put("id", activeBatch)
                        .put("destination", destination).put("createdAt", System.currentTimeMillis())
                        .put("totalBytes", batchBytes).put("items", items);
                ShareBatch.write(this, activeBatch, manifest);
                enqueue(activeBatch);
                runOnUiThread(() -> {
                    Toast.makeText(this, "Upload queued — Aerie will keep it going in the background",
                            Toast.LENGTH_LONG).show();
                    activeBatch = null;
                    finish();
                });
            } catch (Exception error) {
                String failed = activeBatch;
                if (failed != null) ShareBatch.remove(this, failed);
                runOnUiThread(() -> fail("Aerie couldn't safely stage this share."));
            }
        });
    }

    private long copyUri(Uri uri, File target) throws Exception {
        if (uri == null || !"content".equalsIgnoreCase(uri.getScheme()))
            throw new Exception("unsupported_share_uri");
        long total = 0;
        try (InputStream source = getContentResolver().openInputStream(uri);
             BufferedInputStream input = source == null ? null : new BufferedInputStream(source);
             FileOutputStream file = new FileOutputStream(target, false);
             BufferedOutputStream output = new BufferedOutputStream(file)) {
            if (input == null) throw new Exception("share_uri_unavailable");
            byte[] buffer = new byte[64 * 1024];
            for (int count; (count = input.read(buffer)) >= 0; ) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                if (count <= 0) continue;
                total = SharePolicy.checkedItem(total, count);
                output.write(buffer, 0, count);
            }
            output.flush();
            file.getFD().sync();
        }
        return total;
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri,
                new String[]{ OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (Exception ignored) { }
        return uri == null ? null : uri.getLastPathSegment();
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> sharedUris(Intent intent) {
        LinkedHashSet<Uri> result = new LinkedHashSet<>();
        try {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) result.addAll(many);
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) result.add(one);
            ClipData clip = intent.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) result.add(uri);
            }
        } catch (Exception ignored) { }
        result.remove(null);
        return new ArrayList<>(result);
    }

    private void enqueue(String id) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        Data input = new Data.Builder().putString(ShareUploadWorker.INPUT_BATCH, id).build();
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(ShareUploadWorker.class)
                .setInputData(input).setConstraints(constraints).addTag("aerie-share-upload").build();
        WorkManager.getInstance(getApplicationContext()).enqueueUniqueWork(
                "aerie-share-upload-" + id, ExistingWorkPolicy.KEEP, work);
    }

    private void fail(String message) {
        new AlertDialog.Builder(this).setTitle("Can't share to Aerie").setMessage(message)
                .setPositiveButton("OK", (dialog, which) -> finish()).setCancelable(false).show();
    }

    @Override protected void onDestroy() {
        staging.shutdownNow();
        super.onDestroy();
    }
}
