package org.aerie.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Locale;
import java.util.Set;

/** Pure journal invariants shared by the Android sync engine and its JVM tests. */
final class SyncJournal {
    private SyncJournal() { }

    interface CheckedStep {
        void run() throws Exception;
    }

    /** The acknowledgement must never get ahead of local application or durable state. */
    static void commitRemoteApply(CheckedStep apply, CheckedStep persist, CheckedStep acknowledge)
            throws Exception {
        apply.run();
        persist.run();
        acknowledge.run();
    }

    static String selectStableDeviceId(String stored, String trusted, String generated) {
        if (validDeviceId(stored)) return stored;
        if (validDeviceId(trusted)) return trusted;
        if (validDeviceId(generated)) return generated;
        throw new IllegalArgumentException("invalid_sync_device_id");
    }

    static long validatePageCursor(long current, long next, boolean hasMore, long... itemCursors) {
        if (current < 0 || next < current) throw new IllegalArgumentException("invalid_sync_cursor");
        if (itemCursors.length == 0) {
            if (hasMore || next != current) throw new IllegalArgumentException("stalled_sync_cursor");
            return next;
        }
        long previous = current;
        for (long itemCursor : itemCursors) {
            if (itemCursor <= previous || itemCursor > next)
                throw new IllegalArgumentException("invalid_sync_cursor");
            previous = itemCursor;
        }
        if (previous != next) throw new IllegalArgumentException("invalid_sync_cursor");
        return next;
    }

    static ArrayList<String> absentFromManifest(Set<String> tracked, Set<String> manifest) {
        ArrayList<String> absent = new ArrayList<>();
        for (String stableId : tracked) if (!manifest.contains(stableId)) absent.add(stableId);
        Collections.sort(absent);
        return absent;
    }

    /** Partitions durable state when the same local tree is used with another server/base. */
    static String stateScope(String server, String base) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest((String.valueOf(server) + "\u0000" + String.valueOf(base))
                    .getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(24);
            for (int i = 0; i < 12; i++)
                out.append(String.format(Locale.ROOT, "%02x", bytes[i] & 0xff));
            return out.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException("sync_scope_unavailable", impossible);
        }
    }

    private static boolean validDeviceId(String value) {
        return value != null && value.matches("^[A-Za-z0-9_-]{1,64}$");
    }
}
