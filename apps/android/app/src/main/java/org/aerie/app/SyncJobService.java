package org.aerie.app;

import android.app.job.JobParameters;
import android.app.job.JobService;

public class SyncJobService extends JobService {
    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(() -> {
            try { new SyncEngine(SyncJobService.this).runOnce(null); }
            catch (Exception ignored) { }
            jobFinished(params, false);
        }, "aerie-sync-job").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
