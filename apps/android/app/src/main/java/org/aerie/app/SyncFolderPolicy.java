package org.aerie.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** Pure folder/run invariants kept separate so JVM tests need no Android runtime. */
final class SyncFolderPolicy {
    private static final long STALE_RUN_MS = 15L * 60L * 1000L;

    private SyncFolderPolicy() { }

    static boolean staleRun(boolean running, long heartbeatMs, long nowMs) {
        return running && (heartbeatMs <= 0 || heartbeatMs > nowMs + 60_000L
                || nowMs - heartbeatMs > STALE_RUN_MS);
    }

    static boolean accessSatisfies(boolean read, boolean write, String mode) {
        return read && (!"two".equals(mode) || write);
    }

    /** Exact legacy formula: existing installs must keep using their current base. */
    static String legacyRemoteBase(String model, String label, boolean camera) {
        return camera ? "Photos/Camera/" + legacySegment(model, "Phone")
                : "Sync/" + legacySegment(model, "Phone") + " " + legacySegment(label, "Folder");
    }

    /** New folders get a stable device suffix so equal phone models cannot collide. */
    static String newRemoteBase(String model, String label, boolean camera, String deviceId) {
        String tag = digest(deviceId).substring(0, 10);
        String device = boundedSegment(model, "Phone", 100) + "-" + tag;
        return camera ? "Photos/Camera/" + device
                : "Sync/" + device + " " + boundedSegment(label, "Folder", 100);
    }

    static boolean validRemoteBase(String value) {
        if (value == null || value.isEmpty() || value.length() > 4096
                || !(value.startsWith("Sync/") || value.startsWith("Photos/Camera/"))) return false;
        for (String part : value.split("/", -1)) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) return false;
        }
        return value.indexOf('\\') < 0 && value.indexOf('\0') < 0;
    }

    private static String legacySegment(String value, String fallback) {
        String result = value == null ? fallback : value.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return result.isEmpty() ? fallback : result;
    }

    private static String boundedSegment(String value, String fallback, int maxBytes) {
        String result = legacySegment(value, fallback);
        while (!result.isEmpty() && result.getBytes(StandardCharsets.UTF_8).length > maxBytes) {
            result = result.substring(0, result.offsetByCodePoints(0,
                    result.codePointCount(0, result.length()) - 1));
        }
        return result.isEmpty() ? fallback : result;
    }

    private static String digest(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256")
                    .digest(String.valueOf(value).getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(bytes.length * 2);
            for (byte item : bytes) out.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            return out.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException("sync_device_hash_unavailable", impossible);
        }
    }
}
