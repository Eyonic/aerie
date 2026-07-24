package org.aerie.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.DocumentsContract;
import android.text.InputType;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.lang.ref.WeakReference;

/**
 * Aerie Android — a full-screen WebView wrapper around the Aerie web app.
 * Supports file uploads (photo/video backup), cleartext LAN URLs, back navigation,
 * and a first-run server-URL prompt (re-shown if the server can't be reached).
 */
public class MainActivity extends Activity {

    private static final String STATE_OFFERED_UPDATE_BUILD = "offered_update_build";
    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILECHOOSER_RESULT = 1;
    private static final int SYNC_TREE_RESULT = 2;
    private boolean syncCameraPending;
    private SharedPreferences prefs;
    // Optional baked-in endpoints, set at build time (see apps/build-android.sh):
    // a public/cloud address and a LAN address. On home WiFi often only the LAN
    // address works (many routers can't hairpin the public hostname); on mobile
    // data only the cloud address works. When both are set the app probes and
    // hops between them automatically. Either or both may be "" in a generic
    // build — the user is then prompted for their server on first run.
    private static final String CLOUD_URL = BuildConfig.DEFAULT_URL;
    private static final String LAN_URL = BuildConfig.LAN_URL;

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile String activeBase;       // origin the WebView is currently using
    private volatile boolean switching;
    private volatile long lastSwitchAt;
    private ConnectivityManager.NetworkCallback netCallback;
    private AlertDialog urlDialog;
    private long offeredUpdateBuild = -1;
    private final Runnable failoverTicker = new Runnable() {
        @Override public void run() { checkFailover(); main.postDelayed(this, 10_000); }
    };

    // The media notification/lock-screen controls need a way back into the page.
    private static WeakReference<MainActivity> current = new WeakReference<>(null);

    // Origin of the page currently loaded — the media bridge only trusts the
    // configured server (any page in the WebView can call the JS interface).
    private volatile String currentOrigin;

    private static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            if (u.getScheme() == null || u.getHost() == null) return null;
            int port = u.getPort();
            return u.getScheme() + "://" + u.getHost() + (port == -1 ? "" : ":" + port);
        } catch (Exception e) { return null; }
    }

    private boolean trustedNavigation(String url) {
        String origin = originOf(url);
        if (origin == null) return false;
        for (String base : candidates()) {
            String allowed = originOf(base);
            if (origin.equals(allowed)) return true;
        }
        return false;
    }

    private boolean openExternalNavigation(String url) {
        if (trustedNavigation(url)) return false;
        try {
            Uri target = Uri.parse(url);
            if ("http".equalsIgnoreCase(target.getScheme()) || "https".equalsIgnoreCase(target.getScheme())) {
                startActivity(new Intent(Intent.ACTION_VIEW, target));
            }
        } catch (Exception ignored) { }
        return true;
    }

    /** Called by MediaService (notification taps, headset buttons, lock screen). */
    static void dispatchMediaControl(String action, Double value) {
        MainActivity a = current.get();
        if (a == null || a.web == null) return;
        String arg = value == null ? "" : String.valueOf(value);
        a.runOnUiThread(() -> a.web.evaluateJavascript(
                "window.__cbMediaControl && window.__cbMediaControl('" + action + "'" +
                        (arg.isEmpty() ? "" : ", " + arg) + ")", null));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) {
            offeredUpdateBuild = savedInstanceState.getLong(STATE_OFFERED_UPDATE_BUILD, -1);
        }
        prefs = getSharedPreferences("aerie", MODE_PRIVATE);
        current = new WeakReference<>(this);
        // WorkManager KEEP semantics make this an inexpensive schedule repair
        // after an app update, force-stop recovery, or OEM job cleanup.
        SyncEngine.schedule(this);
        UpdateManager.schedule(this);
        new Thread(() -> ShareBatch.pruneStale(getApplicationContext()), "aerie-share-prune").start();

        // Migration: older builds persisted the auto-selected origin into the
        // custom-server slot, which inverted LAN-first probing at home.
        // (Guard against empty baked-in constants: "" must never match.)
        String storedUrl = prefs.getString("url", null);
        if ((!LAN_URL.isEmpty() && LAN_URL.equals(storedUrl))
                || (!CLOUD_URL.isEmpty() && CLOUD_URL.equals(storedUrl))) {
            prefs.edit().remove("url").apply();
        }

        createWebView();
        if (!openPairingIntent(getIntent())) startupNavigate();
        watchNetwork();
    }

    @Override
    protected void onResume() {
        super.onResume();
        UpdateManager.Release release = UpdateManager.readyForReview(this);
        if (release == null || release.build == offeredUpdateBuild || isFinishing()) return;
        // Opening Aerie is the user gesture. The app may present its review here,
        // but Android's installer still opens only after an explicit Continue tap.
        offeredUpdateBuild = release.build;
        startActivity(new Intent(this, UpdateInstallActivity.class));
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        outState.putLong(STATE_OFFERED_UPDATE_BUILD, offeredUpdateBuild);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openPairingIntent(intent);
    }

    /** Consume an aerie://pair QR only after its server proves it is Aerie. */
    private boolean openPairingIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"aerie".equalsIgnoreCase(data.getScheme())
                || !"pair".equalsIgnoreCase(data.getHost())) return false;
        final String server = normalizeLearned(data.getQueryParameter("server"));
        final String code = data.getQueryParameter("code");
        if (server == null || code == null
                || !code.toUpperCase(java.util.Locale.ROOT).matches("^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$")) {
            return false;
        }
        boolean knownServer = false;
        for (String candidate : candidates()) {
            if (server.equals(originOf(candidate))) { knownServer = true; break; }
        }
        String existingToken = SecureCredentialStore.getToken(this);
        if (!knownServer && (candidates().length > 0 || (existingToken != null && !existingToken.isEmpty()))) {
            new AlertDialog.Builder(this)
                    .setTitle("Different Aerie server")
                    .setMessage("For your safety, sign out and change servers before pairing with a different Aerie installation.")
                    .setPositiveButton("OK", null).show();
            // On cold start let onCreate continue to the already-configured
            // server; onNewIntent simply leaves the current page untouched.
            return false;
        }
        new Thread(() -> {
            final boolean verified = healthy(server);
            main.post(() -> {
                if (!verified || web == null) {
                    new AlertDialog.Builder(MainActivity.this)
                            .setTitle("Pairing link unavailable")
                            .setMessage("This link did not point to a reachable Aerie server.")
                            .setPositiveButton("OK", null).show();
                    if (activeBase == null) startupNavigate();
                    return;
                }
                if (urlDialog != null) { try { urlDialog.dismiss(); } catch (Exception ignored) { } urlDialog = null; }
                prefs.edit().putString("url", server).putString("active_base", server).apply();
                activeBase = server;
                web.loadUrl(server + "/pair?code=" + Uri.encode(code.toUpperCase(java.util.Locale.ROOT)));
            });
        }, "aerie-pair-link").start();
        return true;
    }

    // ---- Endpoint selection + failover ----

    /** Endpoints worth probing, in order: user-set server, LAN, cloud, then any
     *  server-advertised endpoints learned from /api/health (see learnEndpoints;
     *  LAN appended before cloud to match the LAN-first startup probing).
     *  Only non-empty values — a generic build may have no baked-in defaults. */
    private String[] candidates() {
        String custom = prefs.getString("url", null);
        java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<>();
        String saved = normalizeLearned(custom);
        if (saved != null) set.add(saved);
        String bakedLan = normalizeLearned(LAN_URL);
        String bakedCloud = normalizeLearned(CLOUD_URL);
        if (bakedLan != null) set.add(bakedLan);
        if (bakedCloud != null) set.add(bakedCloud);
        // Learned endpoints only ever APPEND: they must not displace the
        // user-set/baked-in ordering above (the set dedups ones already there).
        // Re-validated on read in case an old build wrote something odd.
        String srvLan = normalizeLearned(prefs.getString("srv_lan", null));
        String srvPublic = normalizeLearned(prefs.getString("srv_public", null));
        if (srvLan != null) set.add(srvLan);
        if (srvPublic != null) set.add(srvPublic);
        return set.toArray(new String[0]);
    }

    /** Trim + strip trailing slashes; null unless it is an unambiguous HTTP(S)
     *  server base without credentials, a query, or a fragment.
     *  Applied to server-advertised endpoints both when persisting and reading,
     *  so a bad value can never enter candidates() (and thus never be trusted). */
    private static String normalizeLearned(String u) {
        return ServerEndpointResolver.normalize(u);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        runOnUiThread(() -> requestPermissions(
                new String[]{Manifest.permission.POST_NOTIFICATIONS}, 43));
    }

    private boolean healthy(String base) {
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(base + "/api/health").openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(3000);
            c.setRequestMethod("GET");
            if (c.getResponseCode() != 200) { c.disconnect(); return false; }
            // Verify it's actually our server — a captive portal or stray service
            // answering 200 must never be treated as our server (the handoff
            // hands it the session token). Accept EITHER marker: a new server
            // reports the name "Aerie" (plus a compat "CloudBox" field), while
            // an old server answers with "CloudBox" only.
            // Read a small bounded response (looping — one read() may return
            // less). Four KiB leaves room for configured failover URLs without
            // letting a bogus endpoint stream an unbounded body at the app.
            byte[] buf = new byte[4096];
            int n = 0;
            java.io.InputStream in = c.getInputStream();
            while (n < buf.length) {
                int r = in.read(buf, n, buf.length - n);
                if (r <= 0) break;
                n += r;
            }
            c.disconnect();
            if (n <= 0) return false;
            String body = new String(buf, 0, n);
            JSONObject health = new JSONObject(body);
            String name = health.optString("name", "");
            String compat = health.optString("compat", "");
            if (!health.optBoolean("ok", false)
                    || (!("Aerie".equals(name) || "CloudBox".equals(name))
                    && !"CloudBox".equals(compat))) return false;
            // Only a VERIFIED server may teach us new endpoints — and only
            // candidates() (already-trusted origins) are ever probed here.
            learnEndpoints(body);
            return true;
        } catch (Exception e) { return false; }
    }

    /** Persist server-advertised failover endpoints (publicUrl/lanUrl in the
     *  health JSON, operator-set on the Integrations page). Best-effort: any
     *  parse failure — absent fields, old server, or a body beyond the cap —
     *  must never affect the health verdict or existing stored values. */
    private void learnEndpoints(String body) {
        try {
            JSONObject o = new JSONObject(body);
            String pub = normalizeLearned(o.optString("publicUrl", ""));
            String lan = normalizeLearned(o.optString("lanUrl", ""));
            SharedPreferences.Editor e = null;
            if (pub != null && !pub.equals(prefs.getString("srv_public", null))) {
                e = prefs.edit().putString("srv_public", pub);
            }
            if (lan != null && !lan.equals(prefs.getString("srv_lan", null))) {
                if (e == null) e = prefs.edit();
                e.putString("srv_lan", lan);
            }
            if (e != null) e.apply();
        } catch (Exception ignored) { /* not JSON we can use — learn nothing */ }
    }

    /** First load: pick whichever endpoint answers (LAN preferred) — no prompt. */
    private void startupNavigate() {
        if (candidates().length == 0) {
            // Generic build with no baked-in server and nothing saved yet:
            // there is nothing to probe, ask the user straight away.
            if (urlDialog == null) promptUrl();
            return;
        }
        new Thread(() -> {
            String best = null;
            for (String base : candidates()) {
                if (healthy(base)) { best = base; break; }
            }
            final String chosen = best;
            final String sessionToken = chosen == null ? null : DeviceAuthClient.validToken(MainActivity.this, chosen);
            main.post(() -> {
                if (web == null) return;
                if (chosen != null) {
                    if (urlDialog != null) { try { urlDialog.dismiss(); } catch (Exception ignored) { } urlDialog = null; }
                    activeBase = chosen;
                    prefs.edit().putString("active_base", chosen).apply();
                    // Carry the last-known session token so a cold start on an
                    // origin the user never logged into doesn't show Login.
                    String tok = sessionToken;
                    String frag = "";
                    if (tok != null && !tok.isEmpty()) {
                        try {
                            org.json.JSONObject o = new org.json.JSONObject();
                            o.put("token", tok);
                            o.put("path", "/");
                            frag = "#cbho=" + Base64.encodeToString(
                                    o.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8),
                                    Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                        } catch (Exception ignored) { }
                    }
                    web.loadUrl(chosen + "/" + frag);
                } else if (urlDialog == null) {
                    // Nothing reachable — only now is the manual prompt useful.
                    // The watchdog keeps probing and dismisses it on recovery.
                    promptUrl();
                }
            });
        }, "cb-startup").start();
    }

    /** Watchdog: on connectivity changes (and every 10s) verify the current
     *  endpoint still answers; hop to the other one — carrying playback via the
     *  web app's handoff hook — when it doesn't. */
    private void watchNetwork() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm != null) {
            netCallback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network n) { scheduleCheck(2000); scheduleCheck(6000); }
                @Override public void onLost(Network n) { scheduleCheck(2500); }
            };
            try { cm.registerDefaultNetworkCallback(netCallback); } catch (Exception ignored) { }
        }
        main.postDelayed(failoverTicker, 10_000);
    }

    private void scheduleCheck(long delayMs) { main.postDelayed(this::checkFailover, delayMs); }

    private void checkFailover() {
        final String current = activeBase;
        if (web == null) return;
        if (switching) {
            // A switch whose evaluateJavascript callback died (renderer crash)
            // must not disable failover forever — recover after 15s.
            if (SystemClock.elapsedRealtime() - lastSwitchAt < 15_000) return;
            switching = false;
        }
        if (SystemClock.elapsedRealtime() - lastSwitchAt < 8000) return;
        new Thread(() -> {
            if (current == null) {
                // Startup found nothing (prompt may be showing) — keep probing.
                for (String base : candidates()) {
                    if (healthy(base)) { main.post(() -> { if (activeBase == null) startupNavigate(); }); return; }
                }
                return;
            }
            if (healthy(current)) return;
            for (String base : candidates()) {
                if (base.equals(current)) continue;
                if (healthy(base)) { switchTo(base); return; }
            }
        }, "cb-failover").start();
    }

    /** Hop origins, carrying auth + live playback state in the #cbho= hash. */
    private synchronized void switchTo(String base) {
        // Re-check everything at claim time: probe threads run for seconds and
        // a second probe must not clobber a hop that already happened.
        if (switching || base.equals(activeBase)
                || SystemClock.elapsedRealtime() - lastSwitchAt < 8000) return;
        switching = true;
        lastSwitchAt = SystemClock.elapsedRealtime();
        main.post(() -> {
            if (web == null) { switching = false; return; }
            web.evaluateJavascript("window.__cbHandoff ? window.__cbHandoff() : null", value -> {
                String frag = "";
                if (value != null && !value.isEmpty() && !"null".equals(value)) {
                    frag = "#cbho=" + Base64.encodeToString(
                            value.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                            Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                }
                activeBase = base;
                prefs.edit().putString("active_base", base).apply();
                // NOTE: deliberately NOT persisted to prefs "url" — that slot is
                // for user-entered custom servers only; persisting the auto-pick
                // would invert LAN-first probing on the next cold start.
                web.loadUrl(base + "/" + frag);
                switching = false;
            });
        });
    }

    /** Builds (or rebuilds, after renderer death) the WebView and loads the app. */
    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        web = new WebView(this);
        // Android 15 enforces edge-to-edge for apps targeting API 35+, so a
        // bare full-screen WebView starts at y=0 underneath the status icons.
        // Keep the system-bar/cutout policy native: the dark container paints
        // behind transparent bars while its padding gives the web viewport a
        // genuinely safe layout rectangle on every rotation and cutout shape.
        FrameLayout content = new FrameLayout(this);
        content.setBackgroundColor(Color.rgb(10, 10, 15));
        web.setBackgroundColor(Color.rgb(10, 10, 15));
        content.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(content);
        applySafeWindowInsets(content);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " AerieApp/1.0");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternalNavigation(request.getUrl().toString());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternalNavigation(url);
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                currentOrigin = originOf(url);
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // A custom server the user typed is unreachable: let them fix it.
                // (Compare origins — loadUrl appends "/" so equals() never matches.)
                String saved = prefs.getString("url", null);
                if (failingUrl != null && saved != null && urlDialog == null) {
                    String a = originOf(failingUrl), b = originOf(saved);
                    if (a != null && a.equals(b)) promptUrl();
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Default behavior kills the whole app. Recover: drop the dead
                // WebView (its audio died with the renderer) and rebuild.
                MediaService svc = MediaService.instance;
                if (svc != null) svc.stopPlayback();
                if (view.getParent() instanceof ViewGroup)
                    ((ViewGroup) view.getParent()).removeView(view);
                view.destroy();
                if (view == web) {
                    web = null;
                    createWebView();
                    // A pending switchTo callback on the dead view never fires.
                    switching = false;
                    if (activeBase != null) web.loadUrl(activeBase + "/");
                    else startupNavigate();
                }
                return true;
            }
        });

        // Bridge for the web player: it reports now-playing state here and we mirror
        // it into a system MediaSession (MediaService) so backgrounding the app
        // keeps Spotify-style controls.
        web.addJavascriptInterface(new MediaBridge(), "CloudBoxNative");

        web.setWebChromeClient(new WebChromeClient() {
            // Grant the web app's getUserMedia (mic) requests, backed by the OS permission above.
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    String requestOrigin = request.getOrigin() == null ? null : request.getOrigin().toString();
                    boolean wantsAudio = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) wantsAudio = true;
                    }
                    if (!wantsAudio || !trustedNavigation(requestOrigin)) {
                        request.deny();
                    } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 42);
                        request.deny();
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
                filePathCallback = callback;
                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                try {
                    startActivityForResult(intent, FILECHOOSER_RESULT);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                Uri target = Uri.parse(url);
                String scheme = target.getScheme();
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                    startActivity(new Intent(Intent.ACTION_VIEW, target));
                }
            } catch (Exception ignored) { }
        });
        // Navigation happens in startupNavigate() — endpoints are probed first,
        // so the user never sees the server-URL prompt unless nothing answers.
    }

    /** Reserve the safe drawing area required by enforced edge-to-edge. Older
     * Android releases still fit the decor automatically, so applying padding
     * there as well would risk double-insetting the WebView. */
    private void applySafeWindowInsets(View content) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return;
        content.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            int safeTypes = WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout();
            Insets safe = windowInsets.getInsets(safeTypes);
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            // The native frame consumed these edges. Send zero values for just
            // those types to Chromium so viewport-fit=cover / CSS env(safe-area-*)
            // cannot apply the same inset again; preserve IME and gesture data.
            return new WindowInsets.Builder(windowInsets)
                    .setInsets(safeTypes, Insets.NONE)
                    .build();
        });
        content.requestApplyInsets();
    }

    private void promptUrl() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://aerie.example.com");
        input.setText(prefs.getString("url", BuildConfig.DEFAULT_URL));
        urlDialog = new AlertDialog.Builder(this)
                .setTitle("Connect to Aerie")
                .setMessage("Enter your Aerie server address")
                .setView(input)
                .setPositiveButton("Connect", (dialog, which) -> {
                    urlDialog = null;
                    String u = input.getText().toString().trim();
                    if (u.isEmpty()) u = BuildConfig.DEFAULT_URL;
                    if (u.isEmpty()) { promptUrl(); return; }
                    String lower = u.toLowerCase(java.util.Locale.ROOT);
                    if (!lower.startsWith("http://") && !lower.startsWith("https://")) u = "https://" + u;
                    u = normalizeLearned(u);
                    if (u == null) {
                        android.widget.Toast.makeText(MainActivity.this,
                                "Enter a valid HTTP or HTTPS Aerie address.",
                                android.widget.Toast.LENGTH_LONG).show();
                        promptUrl();
                        return;
                    }
                    String nextOrigin = originOf(u);
                    boolean knownAlias = false;
                    for (String candidate : candidates()) {
                        if (nextOrigin != null && nextOrigin.equals(originOf(candidate))) { knownAlias = true; break; }
                    }
                    if (!knownAlias) {
                        // Device ids and JWTs belong to one Aerie installation.
                        // Never carry them to a manually entered, unrelated host.
                        DocumentGrantScope.invalidate(MainActivity.this);
                        SecureCredentialStore.clear(MainActivity.this);
                        prefs.edit().remove("trusted_device_id").remove("trusted_device_fingerprint")
                                .remove("device_auth_suspended").apply();
                    }
                    prefs.edit().putString("url", u).apply();
                    activeBase = u;
                    prefs.edit().putString("active_base", u).apply();
                    web.loadUrl(u + "/");
                })
                .setNeutralButton("Reset", (dialog, which) -> {
                    prefs.edit().remove("url").apply();
                    urlDialog = null;
                    promptUrl();
                })
                .setCancelable(false)
                .show();
    }

    @Override
    @SuppressLint("WrongConstant")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILECHOOSER_RESULT) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                filePathCallback = null;
            }
        } else if (requestCode == SYNC_TREE_RESULT) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri uri = data.getData();
                int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                try { getContentResolver().takePersistableUriPermission(uri, flags); } catch (Exception ignored) { }
                String problem = SyncEngine.addTree(this, uri,
                        syncCameraPending ? "Camera backup" : labelForTree(uri));
                syncCameraPending = false;
                if (problem == null) {
                    SyncEngine.requestManual(this, activeBase);
                } else {
                    new AlertDialog.Builder(this)
                            .setTitle("Folder access needed")
                            .setMessage("Aerie could not keep the required folder permission. Select the same folder again and allow access; two-way sync also needs write access.")
                            .setPositiveButton("OK", null)
                            .show();
                }
            }
            syncCameraPending = false;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        // The WebView IS the audio engine — after the activity dies nothing can
        // control it, so tear playback down instead of leaking a ghost player.
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm != null && netCallback != null) {
            try { cm.unregisterNetworkCallback(netCallback); } catch (Exception ignored) { }
            netCallback = null;
        }
        main.removeCallbacksAndMessages(null);
        if (current.get() == this) current = new WeakReference<>(null);
        MediaService svc = MediaService.instance;
        if (svc != null) svc.stopPlayback();
        if (web != null) {
            if (web.getParent() instanceof ViewGroup)
                ((ViewGroup) web.getParent()).removeView(web);
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** JS-facing bridge (window.CloudBoxNative) — called from the WebView thread. */
    private class MediaBridge {
        /** Only Aerie's own origins (cloud, LAN, or a user-set server) may
         *  drive the media session. */
        private boolean trusted() {
            String cur = currentOrigin;
            if (cur == null) return false;
            for (String base : candidates()) {
                String o = originOf(base);
                if (o != null && o.equals(cur)) return true;
            }
            return false;
        }

        @JavascriptInterface
        public void mediaState(String json) {
            if (!trusted()) return;
            try {
                JSONObject o = new JSONObject(json);
                String title = o.optString("title", "");
                String artist = o.optString("artist", "");
                String artUrl = o.optString("artUrl", "");
                boolean playing = o.optBoolean("playing", false);
                if (playing) requestNotificationPermissionIfNeeded();
                long position = o.optLong("position", 0);
                long duration = o.optLong("duration", 0);
                boolean hasQueue = o.optBoolean("hasQueue", false);
                MediaService svc = MediaService.instance;
                if (svc != null) {
                    // Direct call: startService() would throw once the app is backgrounded.
                    svc.update(title, artist, artUrl, playing, position, duration, hasQueue);
                } else if (playing) {
                    // First start always happens while the user is in the app (they
                    // pressed play), so a foreground-service start is permitted. A
                    // paused report with no live service needs no notification at all.
                    Intent i = new Intent(MainActivity.this, MediaService.class)
                            .setAction(MediaService.ACT_UPDATE)
                            .putExtra("title", title).putExtra("artist", artist)
                            .putExtra("artUrl", artUrl).putExtra("playing", playing)
                            .putExtra("position", position).putExtra("duration", duration)
                            .putExtra("hasQueue", hasQueue);
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
                    else startService(i);
                }
            } catch (Exception ignored) { /* malformed state report — skip */ }
        }

        @JavascriptInterface
        public void mediaPosition(long positionMs, long durationMs) {
            if (!trusted()) return;
            MediaService svc = MediaService.instance;
            if (svc != null) svc.position(positionMs, durationMs);
        }

        @JavascriptInterface
        public void mediaStop() {
            if (!trusted()) return;
            MediaService svc = MediaService.instance;
            if (svc != null) svc.stopPlayback();
        }

        // The web app reports its auth token here on login/logout so a cold start
        // on the other origin can restore the session without a re-login.
        @JavascriptInterface
        public void authToken(String t) {
            if (!trusted()) return;
            SecureCredentialStore.setToken(MainActivity.this, t);
            // A deliberate logout must not be immediately undone by the
            // background challenge flow. Keep the registration (so re-pairing
            // is unnecessary) but suspend passwordless authentication until a
            // subsequent successful login or explicit device registration.
            prefs.edit().putBoolean("device_auth_suspended", t == null || t.isEmpty()).apply();
        }

        /** Public-key identity for the server's QR/code pairing flow. The
         * private key never leaves Android Keystore. */
        @JavascriptInterface
        public String deviceIdentity() {
            if (!trusted()) return "{}";
            try {
                String fingerprint = DeviceIdentity.fingerprint();
                String deviceId = prefs.getString("trusted_device_id", null);
                String registeredFingerprint = prefs.getString("trusted_device_fingerprint", null);
                // SharedPreferences may be restored onto a new phone while
                // AndroidKeyStore keys intentionally are not. Never associate
                // the restored device id with a different newly-created key.
                if (deviceId != null && registeredFingerprint != null
                        && !registeredFingerprint.equals(fingerprint)) {
                    prefs.edit().remove("trusted_device_id").remove("trusted_device_fingerprint").apply();
                    deviceId = null;
                }
                JSONObject out = new JSONObject();
                out.put("algorithm", "ES256");
                out.put("publicKey", DeviceIdentity.publicKey());
                out.put("fingerprint", fingerprint);
                out.put("deviceId", deviceId);
                out.put("name", (Build.MANUFACTURER + " " + Build.MODEL).trim());
                out.put("type", "android");
                out.put("persistent", true);
                out.put("capabilities", new org.json.JSONArray()
                        .put("sync").put("handoff").put("media-session").put("secure-storage"));
                return out.toString();
            } catch (Exception ignored) { return "{}"; }
        }

        @JavascriptInterface
        public String signDeviceChallenge(String payload) {
            if (!trusted() || (prefs.getBoolean("device_auth_suspended", false)
                    && payload != null && payload.contains(":authenticate:"))) return "";
            try { return DeviceIdentity.sign(payload); }
            catch (Exception ignored) { return ""; }
        }

        @JavascriptInterface
        public boolean registerTrustedDevice(String deviceId) {
            if (!trusted() || deviceId == null ||
                    !deviceId.matches("^device_[A-Za-z0-9_-]{20,64}$")) return false;
            try {
                return prefs.edit().putString("trusted_device_id", deviceId)
                        .putString("trusted_device_fingerprint", DeviceIdentity.fingerprint())
                        .putBoolean("device_auth_suspended", false).commit();
            } catch (Exception ignored) { return false; }
        }

        @JavascriptInterface
        public String syncList() {
            if (!trusted()) return "{\"folders\":[]}";
            return SyncEngine.listJson(MainActivity.this);
        }

        @JavascriptInterface
        public void syncAdd() {
            if (!trusted()) return;
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                    startActivityForResult(i, SYNC_TREE_RESULT);
                } catch (Exception ignored) { }
            });
        }

        @JavascriptInterface
        public void syncAddCamera() {
            if (!trusted()) return;
            runOnUiThread(() -> {
                try {
                    syncCameraPending = true;
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                    if (Build.VERSION.SDK_INT >= 26) i.putExtra("android.provider.extra.INITIAL_URI",
                            Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADCIM%2FCamera"));
                    startActivityForResult(i, SYNC_TREE_RESULT);
                } catch (Exception ignored) { syncCameraPending = false; }
            });
        }

        @JavascriptInterface
        public void syncRemove(String uri) {
            if (!trusted()) return;
            SyncEngine.remove(MainActivity.this, uri);
            SyncEngine.schedule(MainActivity.this);
        }

        @JavascriptInterface
        public void syncNow() {
            if (!trusted()) return;
            requestNotificationPermissionIfNeeded();
            SyncEngine.requestManual(MainActivity.this, activeBase);
        }

        @JavascriptInterface
        public void syncCancel() {
            if (!trusted()) return;
            SyncEngine.cancelManual(MainActivity.this);
        }

        @JavascriptInterface
        public String syncStatus() {
            if (!trusted()) return "{\"running\":false,\"folders\":[]}";
            return SyncEngine.statusJson(MainActivity.this);
        }

        @JavascriptInterface
        public String appVersion() {
            if (!trusted()) return "{}";
            try {
                return new JSONObject()
                        .put("platform", "android")
                        .put("version", BuildConfig.VERSION_NAME)
                        .put("build", BuildConfig.VERSION_CODE)
                        .toString();
            } catch (Exception ignored) { return "{}"; }
        }
    }

    private String labelForTree(Uri uri) {
        android.database.Cursor c = null;
        try {
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri));
            c = getContentResolver().query(doc, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null && !name.trim().isEmpty()) return name;
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return "Folder";
    }
}
