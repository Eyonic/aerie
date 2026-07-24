package org.aerie.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Refreshes short-lived device sessions by signing a server challenge. */
final class DeviceAuthClient {
    private static final int TIMEOUT_MS = 10_000;
    private static final int MAX_RESPONSE = 64 * 1024;

    private DeviceAuthClient() { }

    /** Must be called off the UI thread. Falls back to the existing token so
     * older servers and unpaired installs retain the password-login behavior. */
    static synchronized String validToken(Context context, String server) {
        String existing = SecureCredentialStore.getToken(context);
        if (existing != null && !expiresSoon(existing)) {
            DocumentGrantScope.observeToken(context, existing);
            return existing;
        }
        SharedPreferences prefs = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
        if (prefs.getBoolean("device_auth_suspended", false)) return existing;
        String deviceId = prefs.getString("trusted_device_id", null);
        if (deviceId == null || !deviceId.matches("^device_[A-Za-z0-9_-]{20,64}$")) return existing;
        try {
            String registeredFingerprint = prefs.getString("trusted_device_fingerprint", null);
            if (registeredFingerprint != null && !registeredFingerprint.equals(DeviceIdentity.fingerprint())) {
                prefs.edit().remove("trusted_device_id").remove("trusted_device_fingerprint").apply();
                return existing;
            }
            String base = ServerEndpointResolver.normalize(server);
            if (base == null) throw new Exception("invalid_server_origin");
            JSONObject challenge = post(base + "/api/device-pairing/challenge",
                    new JSONObject().put("deviceId", deviceId));
            String challengeId = challenge.getString("challengeId");
            String payload = challenge.getString("signingPayload");
            JSONObject authenticated = post(base + "/api/device-pairing/authenticate", new JSONObject()
                    .put("deviceId", deviceId)
                    .put("challengeId", challengeId)
                    .put("signature", DeviceIdentity.sign(payload)));
            String token = authenticated.getString("token");
            if (token.length() < 20 || token.length() > 8192) throw new Exception("invalid_device_session");
            SecureCredentialStore.setToken(context, token);
            return token;
        } catch (Exception ignored) {
            return existing;
        }
    }

    private static boolean expiresSoon(String token) {
        try {
            String[] parts = token.split("\\.");
            if (parts.length != 3) return false; // retain compatibility with opaque credentials
            byte[] decoded = Base64.decode(parts[1], Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            long exp = new JSONObject(new String(decoded, StandardCharsets.UTF_8)).optLong("exp", 0);
            return exp > 0 && exp * 1000L <= System.currentTimeMillis() + 120_000L;
        } catch (Exception ignored) { return false; }
    }

    private static JSONObject post(String endpoint, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        connection.setRequestMethod("POST");
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setDoOutput(true);
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
        int status = connection.getResponseCode();
        InputStream input = status >= 200 && status < 300
                ? connection.getInputStream() : connection.getErrorStream();
        byte[] response = readLimited(input);
        connection.disconnect();
        JSONObject json = response.length == 0 ? new JSONObject() :
                new JSONObject(new String(response, StandardCharsets.UTF_8));
        if (status < 200 || status >= 300) throw new Exception(json.optString("error", "http_" + status));
        return json;
    }

    private static byte[] readLimited(InputStream input) throws Exception {
        if (input == null) return new byte[0];
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int total = 0;
            for (int n; (n = in.read(buf)) >= 0; ) {
                total += n;
                if (total > MAX_RESPONSE) throw new Exception("device_auth_response_too_large");
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }
}
