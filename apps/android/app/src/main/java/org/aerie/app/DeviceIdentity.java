package org.aerie.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.regex.Pattern;

/** Hardware/OS-keystore device identity used for challenge-based pairing. */
final class DeviceIdentity {
    private static final String KEY_ALIAS = "aerie_trusted_device_identity_v1";
    private static final Pattern PROOF = Pattern.compile(
            "^aerie-device-proof:v1:(pair|authenticate):[A-Za-z0-9_-]{3,100}:" +
                    "[A-Za-z0-9_-]{16,100}:device_[A-Za-z0-9_-]{20,64}$");

    private DeviceIdentity() { }

    private static KeyStore.PrivateKeyEntry entry() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        KeyStore.Entry existing = store.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.PrivateKeyEntry) return (KeyStore.PrivateKeyEntry) existing;

        KeyPairGenerator generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        generator.initialize(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build());
        generator.generateKeyPair();
        return (KeyStore.PrivateKeyEntry) store.getEntry(KEY_ALIAS, null);
    }

    static String publicKey() throws Exception {
        return Base64.encodeToString(entry().getCertificate().getPublicKey().getEncoded(),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    static String fingerprint() throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(entry().getCertificate().getPublicKey().getEncoded());
        return Base64.encodeToString(digest, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    static String sign(String payload) throws Exception {
        if (payload == null || payload.length() > 512 || !PROOF.matcher(payload).matches())
            throw new IllegalArgumentException("invalid_device_challenge");
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign(entry().getPrivateKey());
        signature.update(payload.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(signature.sign(), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
}
