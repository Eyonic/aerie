package org.aerie.app;

import java.nio.charset.StandardCharsets;

/** Opaque DocumentsProvider ids with one strict path canonicalizer. */
final class AerieDocumentId {
    private static final int MAX_PATH_BYTES = 4096;
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private AerieDocumentId() { }

    static String rootId(String scope) {
        validateScope(scope);
        return "aerie:" + scope;
    }

    static String forPath(String scope, String value) {
        validateScope(scope);
        String path = normalize(value);
        if ("/".equals(path)) return "g:" + scope + ":root";
        byte[] bytes = path.getBytes(StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder(35 + bytes.length * 2).append("g:").append(scope).append(":p:");
        for (byte valueByte : bytes) {
            int n = valueByte & 0xff;
            out.append(HEX[n >>> 4]).append(HEX[n & 15]);
        }
        return out.toString();
    }

    static String pathFor(String scope, String id) {
        validateScope(scope);
        String prefix = "g:" + scope + ":";
        if (id == null || !id.startsWith(prefix)) throw new IllegalArgumentException("invalid_document_id");
        String scoped = id.substring(prefix.length());
        if ("root".equals(scoped)) return "/";
        if (!scoped.startsWith("p:") || ((scoped.length() - 2) & 1) != 0
                || scoped.length() > 2 + MAX_PATH_BYTES * 2)
            throw new IllegalArgumentException("invalid_document_id");
        byte[] bytes = new byte[(scoped.length() - 2) / 2];
        for (int i = 0; i < bytes.length; i++) {
            int hi = Character.digit(scoped.charAt(2 + i * 2), 16);
            int lo = Character.digit(scoped.charAt(3 + i * 2), 16);
            if (hi < 0 || lo < 0) throw new IllegalArgumentException("invalid_document_id");
            bytes[i] = (byte) ((hi << 4) | lo);
        }
        String decoded = new String(bytes, StandardCharsets.UTF_8);
        // Reject malformed UTF-8 that was silently replaced while decoding.
        if (!java.util.Arrays.equals(bytes, decoded.getBytes(StandardCharsets.UTF_8)))
            throw new IllegalArgumentException("invalid_document_id");
        String path = normalize(decoded);
        // One canonical id per path avoids aliases that can confuse grants and
        // descendant checks (the root is represented only by ROOT).
        if ("/".equals(path) || !id.equals(forPath(scope, path)))
            throw new IllegalArgumentException("invalid_document_id");
        return path;
    }

    static String normalize(String value) {
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("invalid_document_path");
        if (!value.startsWith("/") || value.indexOf('\\') >= 0 || value.indexOf('\0') >= 0)
            throw new IllegalArgumentException("invalid_document_path");
        String[] parts = value.split("/", -1);
        StringBuilder out = new StringBuilder("/");
        for (int i = 1; i < parts.length; i++) {
            String part = parts[i];
            if (part.isEmpty() && i == parts.length - 1) continue;
            validateName(part);
            if (out.length() > 1) out.append('/');
            out.append(part);
        }
        if (out.toString().getBytes(StandardCharsets.UTF_8).length > MAX_PATH_BYTES)
            throw new IllegalArgumentException("document_path_too_long");
        return out.toString();
    }

    static String child(String parent, String name) {
        String safeParent = normalize(parent);
        validateName(name);
        return normalize(("/".equals(safeParent) ? "" : safeParent) + "/" + name);
    }

    static String parent(String path) {
        String safe = normalize(path);
        if ("/".equals(safe)) return "/";
        int split = safe.lastIndexOf('/');
        return split <= 0 ? "/" : safe.substring(0, split);
    }

    static boolean isChild(String parent, String child) {
        String p = normalize(parent), c = normalize(child);
        return !p.equals(c) && ("/".equals(p) ? c.startsWith("/") : c.startsWith(p + "/"));
    }

    static void validateName(String name) {
        if (name == null || name.isEmpty() || ".".equals(name) || "..".equals(name)
                || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0
                || name.getBytes(StandardCharsets.UTF_8).length > 255)
            throw new IllegalArgumentException("invalid_document_name");
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c == 0 || c < 0x20 || c == 0x7f) throw new IllegalArgumentException("invalid_document_name");
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= name.length() || !Character.isLowSurrogate(name.charAt(i + 1)))
                    throw new IllegalArgumentException("invalid_document_name");
                i++;
            } else if (Character.isLowSurrogate(c)) {
                throw new IllegalArgumentException("invalid_document_name");
            }
        }
    }

    private static void validateScope(String scope) {
        if (scope == null || !scope.matches("^[a-f0-9]{32}$"))
            throw new IllegalArgumentException("invalid_document_scope");
    }
}
