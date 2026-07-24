package org.aerie.app;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;

/**
 * Backwards-compatible service entry point. WorkManager owns every real sync,
 * so even an old pending intent joins the same serialized queue.
 */
public class SyncForegroundService extends Service {
    private static final String EXTRA_BASE = "base";

    static void start(Context context, String activeBase) {
        SyncEngine.requestManual(context, activeBase);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SyncEngine.requestManual(this, intent == null ? null : intent.getStringExtra(EXTRA_BASE));
        stopSelf(startId);
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
