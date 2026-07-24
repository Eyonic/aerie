package org.aerie.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/** One canonical endpoint order shared by native background consumers. */
final class ServerEndpointResolver {
    private ServerEndpointResolver() { }

    static List<String> candidates(Context context, String preferred) {
        SharedPreferences prefs = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
        LinkedHashSet<String> result = new LinkedHashSet<>();
        add(result, preferred);
        add(result, prefs.getString("active_base", null));
        add(result, prefs.getString("url", null));
        add(result, BuildConfig.LAN_URL);
        add(result, prefs.getString("srv_lan", null));
        add(result, BuildConfig.DEFAULT_URL);
        add(result, prefs.getString("srv_public", null));
        return new ArrayList<>(result);
    }

    static List<String> ordered(String... values) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        if (values != null) for (String value : values) add(result, value);
        return new ArrayList<>(result);
    }

    static String normalize(String value) {
        if (value == null) return null;
        String raw = value.trim().replaceAll("/+$", "");
        if (raw.isEmpty()) return null;
        try {
            URI uri = new URI(raw);
            String scheme = uri.getScheme();
            if (!("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme))
                    || uri.getHost() == null || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null) return null;
            String normalizedScheme = scheme.toLowerCase(java.util.Locale.ROOT);
            int port = uri.getPort();
            int defaultPort = "https".equals(normalizedScheme) ? 443 : 80;
            String host = uri.getHost().toLowerCase(java.util.Locale.ROOT);
            if ("http".equals(normalizedScheme) && !privateHttpHost(host)) return null;
            if (host.indexOf(':') >= 0 && !(host.startsWith("[") && host.endsWith("]")))
                host = "[" + host + "]";
            String path = uri.getRawPath();
            if (path == null || "/".equals(path)) path = "";
            else {
                for (String segment : path.split("/", -1)) {
                    if (segment.matches("(?i)(?:\\.|%2e){1,2}")) return null;
                }
                path = path.replaceAll("/+$", "");
            }
            return normalizedScheme + "://" + host
                    + (port == -1 || port == defaultPort ? "" : ":" + port) + path;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void add(LinkedHashSet<String> result, String value) {
        String normalized = normalize(value);
        if (normalized != null) result.add(normalized);
    }

    /** Plain HTTP is allowed only for literal/private LAN destinations. */
    static boolean privateHttpHost(String value) {
        if (value == null) return false;
        String host = value.toLowerCase(java.util.Locale.ROOT).replaceAll("\\.$", "");
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        if (host.equals("localhost") || host.endsWith(".localhost") || host.endsWith(".local")
                || host.indexOf('.') < 0 && host.indexOf(':') < 0) return true;
        if (host.indexOf(':') >= 0) {
            return host.equals("::1") || host.startsWith("fc") || host.startsWith("fd")
                    || host.matches("^fe[89ab].*");
        }
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int i = 0; i < 4; i++) {
                if (parts[i].isEmpty() || parts[i].length() > 3) return false;
                octets[i] = Integer.parseInt(parts[i]);
                if (octets[i] < 0 || octets[i] > 255) return false;
            }
        } catch (NumberFormatException ignored) { return false; }
        return octets[0] == 10 || octets[0] == 127
                || octets[0] == 169 && octets[1] == 254
                || octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31
                || octets[0] == 192 && octets[1] == 168
                || octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127;
    }
}
