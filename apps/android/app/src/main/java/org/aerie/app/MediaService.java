package org.aerie.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Mirrors the web player into a system MediaSession + MediaStyle notification, so
 * backgrounding the app leaves Spotify-style controls (lock screen, notification,
 * headset buttons). The WebView keeps playing the actual audio; this service only
 * reflects its state and forwards control taps back into the page. A WebView on
 * its own never surfaces web audio to the OS — that's why this exists.
 */
public class MediaService extends Service {

    // Derived from the applicationId so forks/rebrands never collide.
    static final String ACT_UPDATE = BuildConfig.APPLICATION_ID + ".action.UPDATE";
    static final String ACT_PLAY = BuildConfig.APPLICATION_ID + ".action.PLAY";
    static final String ACT_PAUSE = BuildConfig.APPLICATION_ID + ".action.PAUSE";
    static final String ACT_NEXT = BuildConfig.APPLICATION_ID + ".action.NEXT";
    static final String ACT_PREV = BuildConfig.APPLICATION_ID + ".action.PREV";
    static final String ACT_STOP = BuildConfig.APPLICATION_ID + ".action.STOP";

    // Internal channel ID — kept stable across the CloudBox→Aerie rebrand so
    // existing installs don't grow a duplicate notification channel.
    private static final String CHANNEL = "cloudbox_playback";
    private static final int NOTE_ID = 7;

    /** Set while the service lives, so the JS bridge can call update() directly —
     *  startService() from a backgrounded app would throw on API 26+. */
    static volatile MediaService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaSession session;

    private String title = "", artist = "", artUrl = "";
    private boolean playing;
    private long positionMs, durationMs;
    private boolean hasQueue;
    private Bitmap art;
    private boolean inForeground;
    private boolean fgSatisfied;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        session = new MediaSession(this, "Aerie");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MainActivity.dispatchMediaControl("play", null); }
            @Override public void onPause() { MainActivity.dispatchMediaControl("pause", null); }
            @Override public void onSkipToNext() { MainActivity.dispatchMediaControl("next", null); }
            @Override public void onSkipToPrevious() { MainActivity.dispatchMediaControl("prev", null); }
            @Override public void onSeekTo(long pos) { MainActivity.dispatchMediaControl("seek", pos / 1000.0); }
        });
        session.setActive(true);

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Aerie playback", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String act = intent != null ? intent.getAction() : null;
        if (act == null) return START_NOT_STICKY;
        switch (act) {
            case ACT_PLAY: MainActivity.dispatchMediaControl("play", null); break;
            case ACT_PAUSE: MainActivity.dispatchMediaControl("pause", null); break;
            case ACT_NEXT: MainActivity.dispatchMediaControl("next", null); break;
            case ACT_PREV: MainActivity.dispatchMediaControl("prev", null); break;
            case ACT_STOP:
                MainActivity.dispatchMediaControl("pause", null);
                stopPlayback();
                break;
            case ACT_UPDATE:
                update(intent.getStringExtra("title"), intent.getStringExtra("artist"),
                        intent.getStringExtra("artUrl"), intent.getBooleanExtra("playing", false),
                        intent.getLongExtra("position", 0), intent.getLongExtra("duration", 0),
                        intent.getBooleanExtra("hasQueue", false));
                break;
        }
        return START_NOT_STICKY;
    }

    /** Full state report from the web player (also the first-start path). */
    void update(String title, String artist, String artUrl, boolean playing,
                long positionMs, long durationMs, boolean hasQueue) {
        this.title = title == null ? "" : title;
        this.artist = artist == null ? "" : artist;
        this.playing = playing;
        this.positionMs = positionMs;
        this.durationMs = durationMs;
        this.hasQueue = hasQueue;
        String au = artUrl == null ? "" : artUrl;
        if (!au.equals(this.artUrl)) { this.artUrl = au; loadArt(au); }
        main.post(this::render);
    }

    /** Cheap periodic position correction while playing. */
    void position(long positionMs, long durationMs) {
        this.positionMs = positionMs;
        if (durationMs > 0) this.durationMs = durationMs;
        main.post(this::render);
    }

    void stopPlayback() {
        main.post(() -> {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
            // A paused notification was DETACHed and re-posted — it is no longer
            // service-owned, so stopForeground alone leaves it behind.
            getSystemService(NotificationManager.class).cancel(NOTE_ID);
            inForeground = false;
            stopSelf();
        });
    }

    private void render() {
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs > 0 ? durationMs : -1);
        if (art != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(md.build());

        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SEEK_TO
                | (hasQueue ? PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS : 0);
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        positionMs, playing ? 1f : 0f)
                .build());

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(title)
                .setContentText(artist)
                .setLargeIcon(art)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(playing)
                .setOnlyAlertOnce(true)
                .setContentIntent(PendingIntent.getActivity(this, 0,
                        new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_IMMUTABLE))
                .setDeleteIntent(serviceIntent(ACT_STOP));

        if (hasQueue) b.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_previous, "Previous", serviceIntent(ACT_PREV)).build());
        b.addAction(new Notification.Action.Builder(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Pause" : "Play", serviceIntent(playing ? ACT_PAUSE : ACT_PLAY)).build());
        if (hasQueue) b.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_next, "Next", serviceIntent(ACT_NEXT)).build());

        Notification.MediaStyle style = new Notification.MediaStyle().setMediaSession(session.getSessionToken());
        style.setShowActionsInCompactView(hasQueue ? new int[]{0, 1, 2} : new int[]{0});
        b.setStyle(style);

        Notification n = b.build();
        if (playing) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTE_ID, n);
            inForeground = true;
            fgSatisfied = true;
        } else {
            // A startForegroundService() launch MUST reach startForeground() once,
            // even when the first report is paused — skipping it is a fatal
            // RemoteServiceException / ForegroundServiceDidNotStartInTimeException.
            // Promote once, then immediately demote to a dismissible notification.
            if (!fgSatisfied && Build.VERSION.SDK_INT >= 26) {
                try {
                    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                    else startForeground(NOTE_ID, n);
                    inForeground = true;
                } catch (Exception ignored) { /* background-start denial — notify below */ }
                fgSatisfied = true;
            }
            // Paused: keep the notification but let the user swipe it away.
            if (inForeground) {
                if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_DETACH);
                else stopForeground(false);
                inForeground = false;
            }
            getSystemService(NotificationManager.class).notify(NOTE_ID, n);
        }
    }

    private PendingIntent serviceIntent(String action) {
        return PendingIntent.getService(this, action.hashCode(),
                new Intent(this, MediaService.class).setAction(action), PendingIntent.FLAG_IMMUTABLE);
    }

    private void loadArt(String url) {
        art = null;
        if (url == null || url.isEmpty()) return;
        final String want = url;
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(want).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                try (InputStream in = c.getInputStream()) {
                    Bitmap bmp = BitmapFactory.decodeStream(in);
                    if (bmp != null && want.equals(artUrl)) {
                        art = bmp;
                        main.post(this::render);
                    }
                }
            } catch (Exception ignored) { /* no artwork — notification still works */ }
        }, "cb-art").start();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App swiped away: the WebView (and its audio) died with it.
        stopPlayback();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        try { getSystemService(NotificationManager.class).cancel(NOTE_ID); } catch (Exception ignored) { }
        if (session != null) { session.setActive(false); session.release(); }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
