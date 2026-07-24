package org.aerie.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Stores session credentials under an Android Keystore AES-GCM key. Existing
 * installs are migrated from the old SharedPreferences "token" value on first
 * read. If a vendor Keystore is temporarily unavailable we leave that legacy
 * value intact, preserving sign-in instead of destroying the only credential.
 */
final class SecureCredentialStore {
    private static final String PREFS = "aerie";
    private static final String KEY_ALIAS = "aerie_session_credentials_v1";
    private static final String TOKEN_DATA = "secure_token_data_v1";
    private static final String TOKEN_IV = "secure_token_iv_v1";
    private static final String LEGACY_TOKEN = "token";
    private static final byte[] AAD = "org.aerie.app/session/v1".getBytes(StandardCharsets.UTF_8);

    private SecureCredentialStore() { }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        java.security.Key existing = store.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    static synchronized String getToken(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String data = prefs.getString(TOKEN_DATA, null);
        String iv = prefs.getString(TOKEN_IV, null);
        if (data != null && iv != null) {
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128,
                        Base64.decode(iv, Base64.NO_WRAP)));
                cipher.updateAAD(AAD);
                return new String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), StandardCharsets.UTF_8);
            } catch (Exception ignored) {
                // A restored preference blob cannot be decrypted by a new
                // hardware key. Fall through to a possible legacy credential.
            }
        }

        String legacy = prefs.getString(LEGACY_TOKEN, null);
        if (legacy == null || legacy.isEmpty()) return null;
        // Migrate only after encryption succeeds. setToken removes the plaintext.
        if (writeEncrypted(prefs, legacy)) return legacy;
        return legacy;
    }

    static synchronized void setToken(Context context, String token) {
        DocumentGrantScope.observeToken(context, token);
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (token == null || token.isEmpty()) {
            clear(prefs);
            return;
        }
        // On unusual devices without a functioning Keystore, retain the old
        // storage behavior so a native update does not silently log users out.
        if (!writeEncrypted(prefs, token)) prefs.edit().putString(LEGACY_TOKEN, token).apply();
    }

    static synchronized void clear(Context context) {
        DocumentGrantScope.observeToken(context, null);
        clear(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
    }

    private static void clear(SharedPreferences prefs) {
        prefs.edit().remove(TOKEN_DATA).remove(TOKEN_IV).remove(LEGACY_TOKEN).apply();
    }

    private static boolean writeEncrypted(SharedPreferences prefs, String token) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(AAD);
            byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            // Commit the ciphertext and plaintext removal atomically in one
            // SharedPreferences transaction.
            return prefs.edit()
                    .putString(TOKEN_DATA, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                    .putString(TOKEN_IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                    .remove(LEGACY_TOKEN)
                    .commit();
        } catch (Exception ignored) {
            return false;
        }
    }
}
