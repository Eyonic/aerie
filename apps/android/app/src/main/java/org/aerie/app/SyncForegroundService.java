package org.aerie.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public class SyncForegroundService extends Service {
    private static final String CHANNEL = "aerie_sync";
    private static final int NOTE_ID = 44013;
    private static final String EXTRA_BASE = "base";
    private static final long WAKE_MS = 30L * 60L * 1000L;

    private volatile boolean running;

    static void start(Context context, String activeBase) {
        try {
            Intent i = new Intent(context, SyncForegroundService.class);
            if (activeBase != null) i.putExtra(EXTRA_BASE, activeBase);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
            else context.startService(i);
        } catch (Exception ignored) { }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Aerie sync", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        } catch (Exception ignored) { }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            startSyncForeground(buildNotification("", 0, 0));
        } catch (Exception ignored) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (running) return START_NOT_STICKY;
        running = true;
        final String base = intent != null ? intent.getStringExtra(EXTRA_BASE) : null;
        new Thread(() -> {
            PowerManager.WakeLock lock = null;
            try {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                if (pm != null) {
                    lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Aerie:sync");
                    lock.acquire(WAKE_MS);
                }
                SyncEngine engine = new SyncEngine(SyncForegroundService.this);
                engine.setProgressListener((folder, done, total) -> {
                    try {
                        NotificationManager nm = getSystemService(NotificationManager.class);
                        if (nm != null) nm.notify(NOTE_ID, buildNotification(folder, done, total));
                    } catch (Exception ignored) { }
                });
                engine.runOnce(base);
            } catch (Exception ignored) {
            } finally {
                try {
                    if (lock != null && lock.isHeld()) lock.release();
                } catch (Exception ignored) { }
                running = false;
                try {
                    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
                    else stopForeground(true);
                } catch (Exception ignored) { }
                stopSelf();
            }
        }, "aerie-sync-fg").start();
        return START_NOT_STICKY;
    }

    private void startSyncForeground(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(NOTE_ID, n);
    }

    private Notification buildNotification(String folder, int done, int total) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        String text = total > 0
                ? "Uploading " + done + " of " + total + (folder == null || folder.isEmpty() ? "" : " — " + folder)
                : "Preparing upload";
        b.setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Syncing folders")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(PendingIntent.getActivity(this, 0,
                        new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_IMMUTABLE));
        if (total > 0) b.setProgress(total, done, false);
        else b.setProgress(0, 0, true);
        return b.build();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
