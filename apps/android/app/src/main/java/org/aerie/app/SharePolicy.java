package org.aerie.app;

import java.util.Locale;

/** Pure limits/path handling for Android's untrusted share intents. */
final class SharePolicy {
    static final int MAX_ITEMS = 50;
    static final long MAX_ITEM_BYTES = 5L * 1024L * 1024L * 1024L;
    static final long MAX_BATCH_BYTES = 10L * 1024L * 1024L * 1024L;
    static final String[] DESTINATIONS = { "/Inbox", "/Photos/Shared", "/Documents" };

    private SharePolicy() { }

    static boolean destinationAllowed(String value) {
        if (value == null) return false;
        for (String allowed : DESTINATIONS) if (allowed.equals(value)) return true;
        return false;
    }

    static String safeFilename(String value, int index) {
        String name = value == null ? "" : value.trim();
        name = name.replace('\\', '_').replace('/', '_').replace('\r', '_').replace('\n', '_');
        StringBuilder clean = new StringBuilder();
        for (int i = 0; i < name.length() && clean.length() < 140; i++) {
            char c = name.charAt(i);
            if (c >= 0x20 && c != 0x7f) clean.append(c);
        }
        name = clean.toString().replaceAll("^[. ]+|[. ]+$", "");
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "Shared file " + (index + 1);
        return name;
    }

    static String makeUnique(String name, java.util.Set<String> used) {
        String candidate = name;
        int dot = name.lastIndexOf('.');
        boolean ordinaryExtension = dot > 0 && name.length() - dot <= 20;
        String stem = ordinaryExtension ? name.substring(0, dot) : name;
        String ext = ordinaryExtension ? name.substring(dot) : "";
        int suffix = 2;
        while (!used.add(candidate.toLowerCase(Locale.ROOT))) {
            String marker = " (" + suffix++ + ")";
            int allowedStem = Math.max(1, 140 - marker.length() - ext.length());
            candidate = stem.substring(0, Math.min(stem.length(), allowedStem)) + marker + ext;
        }
        return candidate;
    }

    static long checkedTotal(long current, long count) {
        if (current < 0 || count < 0 || count > MAX_ITEM_BYTES || current > MAX_BATCH_BYTES - count)
            throw new IllegalArgumentException("share_too_large");
        return current + count;
    }

    static long checkedItem(long current, long count) {
        if (current < 0 || count < 0 || current > MAX_ITEM_BYTES - count)
            throw new IllegalArgumentException("share_item_too_large");
        return current + count;
    }
}
