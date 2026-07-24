package org.aerie.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.provider.DocumentsContract;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;

/**
 * Stable namespace for Storage Access Framework ids. The namespace survives
 * ordinary JWT/device-session rotation, but changes when the credential
 * lifecycle ends so persisted grants cannot cross accounts or servers.
 */
final class DocumentGrantScope {
    private static final String PREFS = "aerie";
    private static final String SCOPE = "documents_grant_scope_v1";
    private static final String ACCOUNT = "documents_grant_account_v1";
    private static final String ACTIVE = "documents_grant_active_v1";

    private DocumentGrantScope() { }

    static synchronized String current(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String value = prefs.getString(SCOPE, null);
        if (value != null && value.matches("^[a-f0-9]{32}$")) return value;
        value = newScope();
        prefs.edit().putString(SCOPE, value).apply();
        return value;
    }

    static synchronized void observeToken(Context context, String token) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (token == null || token.isEmpty()) {
            if (prefs.getBoolean(ACTIVE, false)) rotate(context, prefs);
            return;
        }

        current(context);
        String nextAccount = accountKey(token);
        String previousAccount = prefs.getString(ACCOUNT, null);
        if (prefs.getBoolean(ACTIVE, false) && previousAccount != null
                && nextAccount != null && !previousAccount.equals(nextAccount)) {
            rotate(context, prefs);
        }
        SharedPreferences.Editor edit = prefs.edit().putBoolean(ACTIVE, true);
        if (nextAccount != null) edit.putString(ACCOUNT, nextAccount);
        edit.apply();
    }

    /** Explicitly ends the namespace when the user selects another server. */
    static synchronized void invalidate(Context context) {
        rotate(context, context.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
    }

    private static void rotate(Context context, SharedPreferences prefs) {
        prefs.edit().putString(SCOPE, newScope()).remove(ACCOUNT).putBoolean(ACTIVE, false).apply();
        try {
            context.getContentResolver().notifyChange(DocumentsContract.buildRootsUri(
                    BuildConfig.APPLICATION_ID + ".documents"), null, false);
        } catch (Exception ignored) { }
    }

    private static String accountKey(String token) {
        try {
            String[] parts = token.split("\\.", -1);
            if (parts.length != 3) return null;
            JSONObject payload = new JSONObject(new String(Base64.decode(parts[1],
                    Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8));
            Object id = payload.opt("id");
            if (id == null || id == JSONObject.NULL) return null;
            // Numeric user id is the stable account identity; usernames may be
            // renamed without ending the credential lifecycle.
            String material = String.valueOf(id);
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(material.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte value : digest) out.append(String.format(java.util.Locale.US, "%02x", value & 0xff));
            return out.toString();
        } catch (Exception ignored) { return null; }
    }

    private static String newScope() {
        return UUID.randomUUID().toString().replace("-", "");
    }
}
