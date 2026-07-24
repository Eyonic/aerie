package org.aerie.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Small authenticated client for the intentionally driver-safe /api/car tree. */
final class CarCatalogClient {
    private static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    private static final long MAX_MEDIA_MS = 10L * 365 * 24 * 60 * 60 * 1000;
    static final class Item {
        String id;
        String title;
        String subtitle;
        String artworkUrl;
        String streamUrl;
        String mediaType;
        String progressId;
        boolean browsable;
        boolean playable;
        long durationMs;
        long progressMs;
        long progressOffsetMs;
    }

    static final class Queue {
        final List<Item> items = new ArrayList<>();
        int startIndex;
        long startPositionMs;
    }

    private final Context context;
    private final SharedPreferences prefs;
    private volatile String workingBase;
    private volatile String workingToken;

    CarCatalogClient(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
        this.workingBase = clean(prefs.getString("active_base", null));
        this.workingToken = secureToken();
    }

    boolean configured() {
        return !token().isEmpty() && !bases().isEmpty();
    }

    List<Item> browse(String parentId) throws Exception {
        String path = "/api/car/browse";
        if (parentId != null && !parentId.isEmpty()) {
            path += "?parent=" + Uri.encode(parentId);
        }
        return parseItems(request("GET", path, null).getJSONArray("items"));
    }

    List<Item> search(String query) throws Exception {
        return parseItems(request("GET", "/api/car/search?q=" + Uri.encode(query == null ? "" : query), null)
                .getJSONArray("items"));
    }

    Queue resolve(String mediaId) throws Exception {
        JSONObject body = request("GET", "/api/car/resolve?id=" + Uri.encode(mediaId), null);
        Queue q = new Queue();
        q.items.addAll(parseItems(body.getJSONArray("items")));
        q.startIndex = Math.max(0, body.optInt("startIndex", 0));
        q.startPositionMs = Math.max(0, body.optLong("startPositionMs", 0));
        return q;
    }

    void reportProgress(String id, long positionMs, long durationMs) {
        if (id == null || id.isEmpty()) return;
        try {
            JSONObject body = new JSONObject();
            body.put("id", id);
            body.put("positionMs", Math.max(0, positionMs));
            body.put("durationMs", Math.max(0, durationMs));
            request("POST", "/api/car/progress", body);
        } catch (Exception ignored) { /* playback must never stall on telemetry */ }
    }

    String absolute(String relativeOrAbsolute) {
        if (relativeOrAbsolute == null || relativeOrAbsolute.isEmpty()) return "";
        if (relativeOrAbsolute.startsWith("http://") || relativeOrAbsolute.startsWith("https://")) {
            // The Authorization header is attached by ExoPlayer. Never let a
            // compromised catalogue response redirect that credential to an
            // unrelated origin; the server contract normally uses relative URLs.
            for (String base : bases()) {
                if (relativeOrAbsolute.equals(base) || relativeOrAbsolute.startsWith(base + "/")) {
                    return relativeOrAbsolute;
                }
            }
            return "";
        }
        String base = workingBase;
        if (base == null) {
            List<String> all = bases();
            base = all.isEmpty() ? "" : all.get(0);
        }
        return base + (relativeOrAbsolute.startsWith("/") ? relativeOrAbsolute : "/" + relativeOrAbsolute);
    }

    String artwork(String path) {
        String absolute = absolute(path);
        if (absolute.isEmpty()) return absolute;
        // The Android Auto host loads artwork itself and cannot attach Aerie's
        // Authorization header. The catalogue therefore returns a short-lived,
        // exact-artwork capability. Never put the account/session JWT in a URL.
        for (String base : bases()) {
            String prefix = base + "/api/car-artwork/";
            if (!absolute.startsWith(prefix)) continue;
            String capability = absolute.substring(prefix.length());
            if (capability.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")) return absolute;
        }
        return "";
    }

    String token() {
        String cached = workingToken;
        return cached == null || cached.isEmpty() ? secureToken() : cached;
    }

    private String secureToken() {
        // SecureCredentialStore transparently migrates the legacy preference and
        // uses Android Keystore on supported devices.
        try {
            String value = SecureCredentialStore.getToken(context);
            return value == null ? "" : value;
        } catch (Throwable ignored) {
            String value = prefs.getString("token", "");
            return value == null ? "" : value;
        }
    }

    private JSONObject request(String method, String path, JSONObject body) throws Exception {
        Exception last = null;
        // Android Auto's quality bar requires browse content within 10 seconds.
        // Bound failover as one operation rather than allowing every stale LAN
        // and cloud candidate to consume a full timeout independently.
        final long deadline = System.currentTimeMillis() + 9_000;
        for (String base : bases()) {
            long remaining = deadline - System.currentTimeMillis();
            if (remaining <= 0) break;
            HttpURLConnection c = null;
            try {
                String accessToken = DeviceAuthClient.validToken(context, base);
                if (accessToken == null) accessToken = "";
                c = (HttpURLConnection) new URL(base + path).openConnection();
                remaining = Math.max(250, deadline - System.currentTimeMillis());
                c.setConnectTimeout((int) Math.min(2_500, remaining));
                c.setReadTimeout((int) Math.min(6_000, remaining));
                c.setRequestMethod(method);
                c.setInstanceFollowRedirects(false);
                c.setRequestProperty("Accept", "application/json");
                if (!accessToken.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + accessToken);
                if (body != null) {
                    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    c.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
                }
                int status = c.getResponseCode();
                InputStream stream = status >= 200 && status < 300 ? c.getInputStream() : c.getErrorStream();
                String text = read(stream);
                if (status >= 200 && status < 300) {
                    workingBase = base;
                    workingToken = accessToken;
                    prefs.edit().putString("active_base", base).apply();
                    return text.isEmpty() ? new JSONObject() : new JSONObject(text);
                }
                if (status == 401 || status == 403 || status == 404) {
                    throw new IllegalStateException("aerie_http_" + status + (text.isEmpty() ? "" : ":" + text));
                }
                last = new IllegalStateException("aerie_http_" + status);
            } catch (Exception e) {
                last = e;
            } finally {
                if (c != null) c.disconnect();
            }
        }
        throw last != null ? last : new IllegalStateException("aerie_server_not_configured");
    }

    private List<String> bases() {
        return ServerEndpointResolver.candidates(context, workingBase);
    }

    private static String clean(String value) {
        return ServerEndpointResolver.normalize(value);
    }

    private static List<Item> parseItems(JSONArray array) {
        List<Item> out = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject o = array.optJSONObject(i);
            if (o == null) continue;
            Item item = new Item();
            item.id = limited(o.optString("id", ""), 4096);
            item.title = limited(o.optString("title", "Untitled"), 512);
            item.subtitle = limited(o.optString("subtitle", ""), 512);
            item.artworkUrl = limited(o.optString("artworkUrl", ""), 8192);
            item.streamUrl = limited(o.optString("streamUrl", ""), 8192);
            item.mediaType = "audiobook".equals(o.optString("mediaType")) ? "audiobook" : "music";
            item.progressId = limited(o.optString("progressId", ""), 512);
            item.browsable = o.optBoolean("browsable", false);
            item.playable = o.optBoolean("playable", false);
            item.durationMs = boundedMs(o.optLong("durationMs", 0));
            item.progressMs = boundedMs(o.optLong("progressMs", 0));
            item.progressOffsetMs = boundedMs(o.optLong("progressOffsetMs", 0));
            if (!item.id.isEmpty()) out.add(item);
        }
        return out;
    }

    private static long boundedMs(long value) {
        return Math.min(MAX_MEDIA_MS, Math.max(0, value));
    }

    private static String limited(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, max);
    }

    private static String read(InputStream stream) throws Exception {
        if (stream == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream input = stream) {
            byte[] chunk = new byte[8192];
            for (int count; (count = input.read(chunk)) >= 0; ) {
                if (count == 0) continue;
                if (count > MAX_JSON_BYTES - out.size()) {
                    throw new IllegalStateException("aerie_response_too_large");
                }
                out.write(chunk, 0, count);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
}
