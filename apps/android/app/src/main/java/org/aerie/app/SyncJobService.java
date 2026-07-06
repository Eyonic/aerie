package org.aerie.app;

import android.app.job.JobParameters;
import android.app.job.JobService;

public class SyncJobService extends JobService {
    private volatile SyncEngine engine;

    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(() -> {
            boolean needsMore = false;
            try {
                SyncEngine e = new SyncEngine(SyncJobService.this);
                engine = e;
                e.setDeadlineMs(System.currentTimeMillis() + 8L * 60L * 1000L);
                needsMore = e.runOnce(null);
            }
            catch (Exception ignored) { }
            finally { engine = null; }
            jobFinished(params, needsMore);
        }, "aerie-sync-job").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        SyncEngine e = engine;
        if (e != null) e.cancel();
        return true;
    }
}
