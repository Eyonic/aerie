package org.aerie.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/** Persistent nightly folder sync. WorkManager recreates this after process
 * death/reboot and retries interrupted uploads under the same constraints. */
public class SyncWorker extends Worker {
    private static final String CHANNEL = "aerie_sync";
    private static final int NOTE_ID = 44013;
    private volatile SyncEngine engine;
    private volatile boolean manual;

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            manual = getInputData().getBoolean(SyncEngine.WORK_INPUT_MANUAL, false);
            if (manual) setForegroundAsync(foreground("Preparing sync", 0, 0))
                    .get(10, TimeUnit.SECONDS);
            SyncEngine e = new SyncEngine(getApplicationContext());
            engine = e;
            e.setDeadlineMs(System.currentTimeMillis() + 8L * 60L * 1000L);
            if (manual) e.setProgressListener((folder, done, total) -> {
                String label = folder == null || folder.isEmpty() ? "Syncing folders" : "Syncing " + folder;
                getApplicationContext().getSystemService(NotificationManager.class)
                        .notify(NOTE_ID, notification(label, done, total));
                setProgressAsync(new androidx.work.Data.Builder()
                        .putString("folder", folder == null ? "" : folder)
                        .putInt("done", done).putInt("total", total).build());
            });
            String preferred = getInputData().getString(SyncEngine.WORK_INPUT_BASE);
            return e.runOnce(preferred, manual) ? Result.retry() : Result.success();
        } catch (Exception ignored) {
            return Result.retry();
        } finally {
            engine = null;
        }
    }

    @Override
    public void onStopped() {
        SyncEngine e = engine;
        if (e != null) e.cancel();
        super.onStopped();
    }

    private ForegroundInfo foreground(String text, int done, int total) {
        return new ForegroundInfo(NOTE_ID, notification(text, done, total),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    }

    private Notification notification(String text, int done, int total) {
        Context context = getApplicationContext();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Aerie sync",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
        builder.setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Syncing folders")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(PendingIntent.getActivity(context, 0,
                        new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        if (total > 0) builder.setProgress(total, Math.min(done, total), false);
        else builder.setProgress(0, 0, true);
        return builder.build();
    }
}
