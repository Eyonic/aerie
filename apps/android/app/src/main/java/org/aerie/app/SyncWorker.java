package org.aerie.app;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** Persistent nightly folder sync. WorkManager recreates this after process
 * death/reboot and retries interrupted uploads under the same constraints. */
public class SyncWorker extends Worker {
    private volatile SyncEngine engine;

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            SyncEngine e = new SyncEngine(getApplicationContext());
            engine = e;
            e.setDeadlineMs(System.currentTimeMillis() + 8L * 60L * 1000L);
            return e.runOnce(null) ? Result.retry() : Result.success();
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
}
