package org.aerie.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.SearchManager;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.provider.MediaStore;

import androidx.annotation.Nullable;
import androidx.media.MediaBrowserServiceCompat;
import androidx.media.MediaSessionManager;
import androidx.media.session.MediaButtonReceiver;
import androidx.media.utils.MediaConstants;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;

import android.support.v4.media.MediaBrowserCompat;
import android.support.v4.media.MediaDescriptionCompat;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native audio engine and browse service for Android Auto.
 *
 * Unlike the WebView-mirroring MediaService, this service owns an ExoPlayer. It
 * can therefore be created by the car while Aerie's activity is closed, browse
 * the member's server-side catalogue, resume an audiobook, and keep playing in
 * the background with steering-wheel/voice controls.
 */
@UnstableApi
public final class CarMediaService extends MediaBrowserServiceCompat {
    private static final String ROOT = "aerie_car_root";
    private static final String CHANNEL = "aerie_car_playback";
    private static final int NOTIFICATION_ID = 8;
    private static final long PROGRESS_INTERVAL_MS = 15_000;

    private static final String ACTION_PLAY = BuildConfig.APPLICATION_ID + ".car.PLAY";
    private static final String ACTION_PAUSE = BuildConfig.APPLICATION_ID + ".car.PAUSE";
    private static final String ACTION_NEXT = BuildConfig.APPLICATION_ID + ".car.NEXT";
    private static final String ACTION_PREVIOUS = BuildConfig.APPLICATION_ID + ".car.PREVIOUS";
    private static final String ACTION_STOP = BuildConfig.APPLICATION_ID + ".car.STOP";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor(r -> new Thread(r, "aerie-car-api"));
    private final List<CarCatalogClient.Item> activeQueue = new ArrayList<>();
    private CarCatalogClient catalog;
    private ExoPlayer player;
    private MediaSessionCompat session;
    private DefaultHttpDataSource.Factory httpFactory;
    private boolean foreground;

    private final Runnable progressTick = new Runnable() {
        @Override public void run() {
            reportProgress(player == null ? -1 : player.getCurrentMediaItemIndex(),
                    player == null ? 0 : player.getCurrentPosition());
            if (player != null && player.isPlaying()) main.postDelayed(this, PROGRESS_INTERVAL_MS);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        catalog = new CarCatalogClient(this);

        Map<String, String> headers = new HashMap<>();
        String token = catalog.token();
        if (!token.isEmpty()) headers.put("Authorization", "Bearer " + token);
        httpFactory = new DefaultHttpDataSource.Factory()
                .setUserAgent("Aerie-AndroidAuto/" + BuildConfig.VERSION_NAME)
                .setConnectTimeoutMs(10_000)
                .setReadTimeoutMs(30_000)
                .setAllowCrossProtocolRedirects(false)
                .setDefaultRequestProperties(headers);
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(
                        NativeMediaCache.factory(this, httpFactory)))
                .build();
        player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(), true);
        player.setHandleAudioBecomingNoisy(true);
        player.setWakeMode(C.WAKE_MODE_LOCAL);
        player.addListener(new Player.Listener() {
            @Override public void onEvents(Player ignored, Player.Events events) {
                publishState();
                renderNotification();
                if (player.isPlaying()) {
                    main.removeCallbacks(progressTick);
                    main.postDelayed(progressTick, PROGRESS_INTERVAL_MS);
                } else {
                    main.removeCallbacks(progressTick);
                    reportProgress(player.getCurrentMediaItemIndex(), player.getCurrentPosition());
                }
            }

            @Override public void onPositionDiscontinuity(Player.PositionInfo oldPosition,
                                                           Player.PositionInfo newPosition,
                                                           int reason) {
                reportProgress(oldPosition.mediaItemIndex, oldPosition.positionMs);
            }

            @Override public void onPlayerError(PlaybackException error) {
                main.removeCallbacks(progressTick);
                reportProgress(player.getCurrentMediaItemIndex(), player.getCurrentPosition());
                setError("Playback stopped — check Aerie's connection");
            }
        });

        session = new MediaSessionCompat(this, "AerieCar");
        session.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
                | MediaSessionCompat.FLAG_HANDLES_QUEUE_COMMANDS);
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() {
                if (player.getMediaItemCount() > 0) {
                    if (player.getPlaybackState() == Player.STATE_ENDED) {
                        player.seekTo(0, 0);
                        player.prepare();
                    }
                    player.play();
                } else loadDefault(true);
            }
            @Override public void onPrepare() {
                if (player.getMediaItemCount() > 0) player.prepare();
                else loadDefault(false);
            }
            @Override public void onPause() { player.pause(); }
            @Override public void onStop() { stopPlayback(); }
            @Override public void onSeekTo(long pos) { player.seekTo(Math.max(0, pos)); }
            @Override public void onSkipToNext() { if (player.hasNextMediaItem()) player.seekToNextMediaItem(); }
            @Override public void onSkipToPrevious() {
                if (player.getCurrentPosition() > 10_000) player.seekTo(0);
                else if (player.hasPreviousMediaItem()) player.seekToPreviousMediaItem();
            }
            @Override public void onFastForward() { player.seekTo(player.getCurrentPosition() + 30_000); }
            @Override public void onRewind() { player.seekTo(Math.max(0, player.getCurrentPosition() - 30_000)); }
            @Override public void onSkipToQueueItem(long id) {
                int index = (int) id;
                if (index >= 0 && index < player.getMediaItemCount()) player.seekTo(index, 0);
            }
            @Override public void onPlayFromMediaId(String mediaId, Bundle extras) { loadAndPlay(mediaId); }
            @Override public void onPrepareFromMediaId(String mediaId, Bundle extras) { load(mediaId, false); }
            @Override public void onPlayFromSearch(String query, Bundle extras) {
                searchAndLoad(voiceQuery(query, extras), true);
            }
            @Override public void onPrepareFromSearch(String query, Bundle extras) {
                searchAndLoad(voiceQuery(query, extras), false);
            }
        });
        session.setActive(true);
        setSessionToken(session.getSessionToken());

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Aerie in the car", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        publishState();
    }

    @Nullable @Override public BrowserRoot onGetRoot(String clientPackageName, int clientUid, Bundle rootHints) {
        // The exported browser service exposes a private library and narrowly
        // scoped artwork capabilities. Verify that the UID owns the claimed package and only
        // accept this app, Android Auto, or a system-trusted media controller.
        if (!isTrustedBrowser(clientPackageName, clientUid)) return null;

        // Authentication/network work deliberately stays out of this fast path;
        // Android Auto times out slow roots. Search support must be advertised
        // here or the host won't expose browsable search results.
        Bundle extras = new Bundle();
        extras.putBoolean(MediaConstants.BROWSER_SERVICE_EXTRAS_KEY_SEARCH_SUPPORTED, true);
        return new BrowserRoot(ROOT, extras);
    }

    private boolean isTrustedBrowser(String packageName, int uid) {
        if (packageName == null || packageName.isEmpty()) return false;
        String[] packages = getPackageManager().getPackagesForUid(uid);
        boolean ownsPackage = false;
        if (packages != null) for (String candidate : packages) {
            if (packageName.equals(candidate)) { ownsPackage = true; break; }
        }
        if (!ownsPackage) return false;
        if (uid == Process.myUid() || uid == Process.SYSTEM_UID
                || "com.google.android.projection.gearhead".equals(packageName)) return true;
        return MediaSessionManager.getSessionManager(this).isTrustedForMediaControl(
                new MediaSessionManager.RemoteUserInfo(
                        packageName, -1, uid));
    }

    @Override public void onLoadChildren(String parentId, Result<List<MediaBrowserCompat.MediaItem>> result) {
        result.detach();
        io.execute(() -> {
            if (!catalog.configured()) {
                setAuthenticationRequired();
                main.post(() -> result.sendResult(null));
                return;
            }
            List<MediaBrowserCompat.MediaItem> items = new ArrayList<>();
            boolean succeeded = true;
            try {
                String parent = ROOT.equals(parentId) ? null : parentId;
                for (CarCatalogClient.Item item : catalog.browse(parent)) items.add(browserItem(item));
            } catch (Exception e) {
                succeeded = false;
                setError("Can't reach your Aerie server");
            }
            List<MediaBrowserCompat.MediaItem> delivered = succeeded ? items : null;
            main.post(() -> result.sendResult(delivered));
        });
    }

    @Override public void onSearch(String query, Bundle extras,
                                   Result<List<MediaBrowserCompat.MediaItem>> result) {
        result.detach();
        io.execute(() -> {
            if (!catalog.configured()) {
                setAuthenticationRequired();
                main.post(() -> result.sendResult(null));
                return;
            }
            List<MediaBrowserCompat.MediaItem> items = new ArrayList<>();
            boolean succeeded = true;
            try {
                for (CarCatalogClient.Item item : catalog.search(query)) items.add(browserItem(item));
            } catch (Exception e) {
                succeeded = false;
                setError("Search unavailable while Aerie is offline");
            }
            List<MediaBrowserCompat.MediaItem> delivered = succeeded ? items : null;
            main.post(() -> result.sendResult(delivered));
        });
    }

    private MediaBrowserCompat.MediaItem browserItem(CarCatalogClient.Item item) {
        MediaDescriptionCompat.Builder description = new MediaDescriptionCompat.Builder()
                .setMediaId(item.id)
                .setTitle(item.title)
                .setSubtitle(item.subtitle);
        if ("audiobook".equals(item.mediaType) && item.durationMs > 0) {
            double completion = Math.min(1d, Math.max(0d,
                    (double) item.progressMs / (double) item.durationMs));
            Bundle extras = new Bundle();
            extras.putDouble(MediaConstants.DESCRIPTION_EXTRAS_KEY_COMPLETION_PERCENTAGE, completion);
            extras.putInt(MediaConstants.DESCRIPTION_EXTRAS_KEY_COMPLETION_STATUS,
                    completion > 0d
                            ? MediaConstants.DESCRIPTION_EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED
                            : MediaConstants.DESCRIPTION_EXTRAS_VALUE_COMPLETION_STATUS_NOT_PLAYED);
            description.setExtras(extras);
        }
        String art = catalog.artwork(item.artworkUrl);
        if (!art.isEmpty()) description.setIconUri(Uri.parse(art));
        int flags = (item.browsable ? MediaBrowserCompat.MediaItem.FLAG_BROWSABLE : 0)
                | (item.playable ? MediaBrowserCompat.MediaItem.FLAG_PLAYABLE : 0);
        return new MediaBrowserCompat.MediaItem(description.build(), flags);
    }

    private void loadDefault(boolean play) {
        setConnecting();
        io.execute(() -> {
            try {
                List<CarCatalogClient.Item> items = catalog.search("");
                for (CarCatalogClient.Item item : items) {
                    if (item.playable) { main.post(() -> load(item.id, play)); return; }
                }
                setError("Choose something to play in Aerie");
            } catch (Exception e) { setError("Open Aerie on your phone to connect"); }
        });
    }

    private void searchAndLoad(String query, boolean play) {
        setConnecting();
        io.execute(() -> {
            try {
                List<CarCatalogClient.Item> items = catalog.search(query == null ? "" : query);
                for (CarCatalogClient.Item item : items) {
                    if (item.playable) { main.post(() -> load(item.id, play)); return; }
                }
                setError("No matching music or audiobook");
            } catch (Exception e) { setError("Voice search couldn't reach Aerie"); }
        });
    }

    private String voiceQuery(String query, Bundle extras) {
        if (query != null && !query.trim().isEmpty()) return query.trim();
        if (extras == null) return "";
        String[] keys = {
                MediaStore.EXTRA_MEDIA_TITLE,
                MediaStore.EXTRA_MEDIA_ALBUM,
                MediaStore.EXTRA_MEDIA_ARTIST,
                MediaStore.EXTRA_MEDIA_GENRE,
                MediaStore.EXTRA_MEDIA_PLAYLIST,
        };
        for (String key : keys) {
            String value = extras.getString(key);
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return "";
    }

    private void loadAndPlay(String mediaId) { load(mediaId, true); }

    private void load(String mediaId, boolean play) {
        if (mediaId == null || mediaId.isEmpty()) return;
        setConnecting();
        io.execute(() -> {
            try {
                CarCatalogClient.Queue resolved = catalog.resolve(mediaId);
                refreshStreamCredentials();
                List<androidx.media3.common.MediaItem> media = new ArrayList<>();
                for (CarCatalogClient.Item item : resolved.items) media.add(playerItem(item));
                main.post(() -> {
                    if (media.isEmpty()) { setError("This item has no playable audio"); return; }
                    activeQueue.clear();
                    activeQueue.addAll(resolved.items);
                    int start = Math.min(Math.max(0, resolved.startIndex), media.size() - 1);
                    boolean speech = "audiobook".equals(resolved.items.get(start).mediaType);
                    player.setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(C.USAGE_MEDIA)
                            .setContentType(speech ? C.AUDIO_CONTENT_TYPE_SPEECH : C.AUDIO_CONTENT_TYPE_MUSIC)
                            .build(), true);
                    player.setMediaItems(media, start, Math.max(0, resolved.startPositionMs));
                    player.prepare();
                    publishQueue();
                    if (play) player.play();
                });
            } catch (Exception e) { setError("Aerie couldn't prepare this audio"); }
        });
    }

    private androidx.media3.common.MediaItem playerItem(CarCatalogClient.Item item) {
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .setTitle(item.title)
                .setArtist(item.subtitle)
                .setIsPlayable(true)
                .setIsBrowsable(false);
        String art = catalog.artwork(item.artworkUrl);
        if (!art.isEmpty()) metadata.setArtworkUri(Uri.parse(art));
        return new androidx.media3.common.MediaItem.Builder()
                .setMediaId(item.id)
                .setUri(catalog.absolute(item.streamUrl))
                .setCustomCacheKey(NativeMediaCache.cacheKey(this, item.id, item.streamUrl))
                .setMediaMetadata(metadata.build())
                .build();
    }

    private void publishQueue() {
        List<MediaSessionCompat.QueueItem> queue = new ArrayList<>();
        for (int i = 0; i < activeQueue.size(); i++) {
            CarCatalogClient.Item item = activeQueue.get(i);
            MediaDescriptionCompat.Builder d = new MediaDescriptionCompat.Builder()
                    .setMediaId(item.id).setTitle(item.title).setSubtitle(item.subtitle);
            String art = catalog.artwork(item.artworkUrl);
            if (!art.isEmpty()) d.setIconUri(Uri.parse(art));
            queue.add(new MediaSessionCompat.QueueItem(d.build(), i));
        }
        session.setQueue(queue);
        session.setQueueTitle("Aerie queue");
        publishState();
    }

    private void publishState() {
        if (session == null || player == null) return;
        int index = player.getCurrentMediaItemIndex();
        CarCatalogClient.Item item = index >= 0 && index < activeQueue.size() ? activeQueue.get(index) : null;
        if (item != null) {
            MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, item.id)
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, item.title)
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, item.subtitle)
                    .putLong(MediaMetadataCompat.METADATA_KEY_DURATION,
                            item.durationMs > 0 ? item.durationMs : Math.max(0, player.getDuration()));
            String art = catalog.artwork(item.artworkUrl);
            if (!art.isEmpty()) metadata.putString(MediaMetadataCompat.METADATA_KEY_ART_URI, art);
            session.setMetadata(metadata.build());
        }

        long actions = PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_STOP
                | PlaybackStateCompat.ACTION_SEEK_TO | PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID
                | PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH | PlaybackStateCompat.ACTION_PREPARE_FROM_MEDIA_ID
                | PlaybackStateCompat.ACTION_PREPARE | PlaybackStateCompat.ACTION_PREPARE_FROM_SEARCH
                | PlaybackStateCompat.ACTION_FAST_FORWARD | PlaybackStateCompat.ACTION_REWIND;
        if (player.getMediaItemCount() > 0) actions |= PlaybackStateCompat.ACTION_SKIP_TO_QUEUE_ITEM;
        if (player.hasNextMediaItem()) actions |= PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
        if (player.hasPreviousMediaItem() || player.getCurrentPosition() > 0) actions |= PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;
        int state = player.isPlaying() ? PlaybackStateCompat.STATE_PLAYING
                : player.getPlaybackState() == Player.STATE_BUFFERING ? PlaybackStateCompat.STATE_BUFFERING
                : player.getPlaybackState() == Player.STATE_ENDED ? PlaybackStateCompat.STATE_STOPPED
                : player.getMediaItemCount() > 0 ? PlaybackStateCompat.STATE_PAUSED
                : PlaybackStateCompat.STATE_STOPPED;
        PlaybackStateCompat.Builder playback = new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setActiveQueueItemId(index >= 0 ? index : MediaSessionCompat.QueueItem.UNKNOWN_ID)
                .setBufferedPosition(Math.max(0, player.getBufferedPosition()))
                .setState(state, Math.max(0, player.getCurrentPosition()), player.isPlaying() ? 1f : 0f);
        if (item != null) {
            Bundle stateExtras = new Bundle();
            stateExtras.putString(MediaConstants.PLAYBACK_STATE_EXTRAS_KEY_MEDIA_ID, item.id);
            playback.setExtras(stateExtras);
        }
        session.setPlaybackState(playback.build());
    }

    private void setConnecting() {
        main.post(() -> session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_STOP)
                .setState(PlaybackStateCompat.STATE_CONNECTING, 0, 0f).build()));
    }

    private void setError(String message) {
        main.post(() -> session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID | PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH)
                .setErrorMessage(PlaybackStateCompat.ERROR_CODE_APP_ERROR, message)
                .setState(PlaybackStateCompat.STATE_ERROR, 0, 0f).build()));
    }

    private void setAuthenticationRequired() {
        main.post(() -> {
            PendingIntent openPhone = PendingIntent.getActivity(this, 41,
                    new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Bundle extras = new Bundle();
            extras.putString(MediaConstants.PLAYBACK_STATE_EXTRAS_KEY_ERROR_RESOLUTION_ACTION_LABEL,
                    "Open Aerie on phone");
            extras.putParcelable(MediaConstants.PLAYBACK_STATE_EXTRAS_KEY_ERROR_RESOLUTION_ACTION_INTENT,
                    openPhone);
            session.setPlaybackState(new PlaybackStateCompat.Builder()
                    .setActions(PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID
                            | PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH)
                    .setErrorMessage(PlaybackStateCompat.ERROR_CODE_AUTHENTICATION_EXPIRED,
                            "Sign in to Aerie on your phone")
                    .setExtras(extras)
                    .setState(PlaybackStateCompat.STATE_ERROR, 0, 0f)
                    .build());
        });
    }

    private void reportProgress(int index, long itemPositionMs) {
        if (index < 0 || index >= activeQueue.size()) return;
        CarCatalogClient.Item item = activeQueue.get(index);
        long duration = item.durationMs;
        if ("audiobook".equals(item.mediaType)) {
            duration = 0;
            for (CarCatalogClient.Item q : activeQueue) duration += Math.max(0, q.durationMs);
        }
        final long total = duration;
        final long position = item.progressOffsetMs + Math.max(0, itemPositionMs);
        io.execute(() -> {
            catalog.reportProgress(item.progressId, position, total);
            refreshStreamCredentials();
        });
    }

    /** DefaultHttpDataSource shares these request properties with active data
     * sources, so a long audiobook can reconnect after a 15-minute JWT rotates. */
    private void refreshStreamCredentials() {
        if (httpFactory == null) return;
        Map<String, String> headers = new HashMap<>();
        String token = catalog.token();
        if (!token.isEmpty()) headers.put("Authorization", "Bearer " + token);
        httpFactory.setDefaultRequestProperties(headers);
    }

    private void renderNotification() {
        if (session == null || player == null || player.getMediaItemCount() == 0) return;
        int index = player.getCurrentMediaItemIndex();
        CarCatalogClient.Item item = index >= 0 && index < activeQueue.size() ? activeQueue.get(index) : null;
        if (item == null) return;
        boolean playing = player.isPlaying();
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_aerie_car)
                .setContentTitle(item.title)
                .setContentText(item.subtitle)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(playing)
                .setOnlyAlertOnce(true)
                .setContentIntent(PendingIntent.getActivity(this, 0,
                        new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        if (player.hasPreviousMediaItem() || player.getCurrentPosition() > 0) {
            b.addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous,
                    "Previous", actionIntent(ACTION_PREVIOUS)).build());
        }
        b.addAction(new Notification.Action.Builder(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Pause" : "Play", actionIntent(playing ? ACTION_PAUSE : ACTION_PLAY)).build());
        if (player.hasNextMediaItem()) {
            b.addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next,
                    "Next", actionIntent(ACTION_NEXT)).build());
        }
        Object token = session.getSessionToken().getToken();
        Notification.MediaStyle style = new Notification.MediaStyle();
        if (token instanceof MediaSession.Token) style.setMediaSession((MediaSession.Token) token);
        b.setStyle(style);
        Notification note = b.build();
        if (playing) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTIFICATION_ID, note);
            foreground = true;
        } else {
            if (foreground) {
                stopForeground(STOP_FOREGROUND_DETACH);
                foreground = false;
            }
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, note);
        }
    }

    private PendingIntent actionIntent(String action) {
        return PendingIntent.getService(this, action.hashCode(),
                new Intent(this, CarMediaService.class).setAction(action),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) MediaButtonReceiver.handleIntent(session, intent);
        String action = intent == null ? null : intent.getAction();
        if (ACTION_PLAY.equals(action)) session.getController().getTransportControls().play();
        else if (ACTION_PAUSE.equals(action)) session.getController().getTransportControls().pause();
        else if (ACTION_NEXT.equals(action)) session.getController().getTransportControls().skipToNext();
        else if (ACTION_PREVIOUS.equals(action)) session.getController().getTransportControls().skipToPrevious();
        else if (ACTION_STOP.equals(action)) session.getController().getTransportControls().stop();
        else if (MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH.equals(action)) {
            String query = intent.getStringExtra(SearchManager.QUERY);
            session.getController().getTransportControls().playFromSearch(
                    voiceQuery(query, intent.getExtras()), intent.getExtras());
        }
        // The browser host will bind again when needed. A sticky null-intent
        // restart cannot reconstruct an in-memory queue and only leaves an idle
        // playback service resident after process death.
        return START_NOT_STICKY;
    }

    private void stopPlayback() {
        reportProgress(player.getCurrentMediaItemIndex(), player.getCurrentPosition());
        player.stop();
        activeQueue.clear();
        session.setQueue(Collections.emptyList());
        stopForeground(STOP_FOREGROUND_REMOVE);
        getSystemService(NotificationManager.class).cancel(NOTIFICATION_ID);
        foreground = false;
        stopSelf();
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        // A car playback session is independent of the WebView and intentionally
        // survives the phone UI being swiped away. Stop only when nothing plays.
        if (!player.isPlaying()) stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override public void onDestroy() {
        main.removeCallbacks(progressTick);
        if (player != null) {
            reportProgress(player.getCurrentMediaItemIndex(), player.getCurrentPosition());
            player.release();
        }
        if (session != null) { session.setActive(false); session.release(); }
        io.shutdown();
        super.onDestroy();
    }
}
