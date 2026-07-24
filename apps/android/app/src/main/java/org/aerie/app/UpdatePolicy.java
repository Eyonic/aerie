package org.aerie.app;

import java.net.URI;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Pure validation rules shared by the update worker, installer, and tests. */
final class UpdatePolicy {
    static final long MAX_APK_BYTES = 1024L * 1024L * 1024L;
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern VERSION = Pattern.compile(
            "^[0-9]+(?:\\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$");
    private static final Pattern CONTENT_RANGE = Pattern.compile("^bytes (\\d+)-(\\d+)/(\\d+)$",
            Pattern.CASE_INSENSITIVE);

    private UpdatePolicy() { }

    static void validateRelease(boolean available, boolean verified, String filename, String url,
                                long size, String sha256, String version, long build,
                                String certificateSha256, long installedBuild) {
        if (!available || !verified) throw invalid("unverified_release");
        if (!safeFilename(filename) || !filename.toLowerCase(Locale.ROOT).endsWith(".apk"))
            throw invalid("invalid_apk_filename");
        if (!safeDownloadUrl(filename, url)) throw invalid("invalid_apk_url");
        if (size <= 0 || size > MAX_APK_BYTES) throw invalid("invalid_apk_size");
        if (!sha(sha256)) throw invalid("invalid_apk_hash");
        if (!VERSION.matcher(value(version)).matches()) throw invalid("invalid_apk_version");
        if (build <= installedBuild || build > Integer.MAX_VALUE)
            throw invalid("update_not_newer");
        if (!sha(certificateSha256)) throw invalid("invalid_apk_certificate");
    }

    static boolean safeFilename(String filename) {
        if (filename == null || filename.isEmpty() || filename.length() > 180) return false;
        if (filename.equals(".") || filename.equals("..") || filename.trim().length() != filename.length())
            return false;
        for (int i = 0; i < filename.length(); i++) {
            char c = filename.charAt(i);
            if (c == '/' || c == '\\' || c == '\r' || c == '\n' || c == 0 || c < 0x20) return false;
        }
        return true;
    }

    static boolean safeDownloadUrl(String filename, String url) {
        if (!safeFilename(filename) || url == null || url.length() > 512 || url.indexOf('+') >= 0) return false;
        try {
            URI uri = new URI(url);
            return !uri.isAbsolute() && uri.getRawAuthority() == null && uri.getRawQuery() == null
                    && uri.getRawFragment() == null && ("/downloads/" + filename).equals(uri.getPath());
        } catch (Exception ignored) { return false; }
    }

    static final class DownloadPlan {
        final boolean append;
        final long expectedBytes;
        DownloadPlan(boolean append, long expectedBytes) {
            this.append = append;
            this.expectedBytes = expectedBytes;
        }
    }

    static DownloadPlan validateDownloadResponse(int status, long offset, long total,
                                                 String contentLength, String contentRange) {
        if (total <= 0 || total > MAX_APK_BYTES || offset < 0 || offset > total)
            throw invalid("invalid_download_size");
        boolean append;
        long expected;
        if (status == 206) {
            if (offset <= 0 || offset >= total || contentRange == null)
                throw invalid("invalid_download_range");
            Matcher matcher = CONTENT_RANGE.matcher(contentRange.trim());
            if (!matcher.matches()) throw invalid("invalid_download_range");
            try {
                long start = Long.parseLong(matcher.group(1));
                long end = Long.parseLong(matcher.group(2));
                long declaredTotal = Long.parseLong(matcher.group(3));
                if (start != offset || end != total - 1 || declaredTotal != total || end < start)
                    throw invalid("invalid_download_range");
            } catch (NumberFormatException ignored) { throw invalid("invalid_download_range"); }
            append = true;
            expected = total - offset;
        } else if (status == 200) {
            if (contentRange != null && !contentRange.trim().isEmpty())
                throw invalid("unexpected_download_range");
            append = false;
            expected = total;
        } else throw invalid("invalid_download_status");
        if (contentLength != null && !contentLength.isEmpty()) {
            try {
                if (!contentLength.matches("^[0-9]{1,19}$")
                        || Long.parseLong(contentLength) != expected)
                    throw invalid("invalid_download_length");
            } catch (NumberFormatException ignored) { throw invalid("invalid_download_length"); }
        }
        return new DownloadPlan(append, expected);
    }

    static long checkedByteCount(long received, int count, long expected) {
        if (received < 0 || expected < 0 || expected > MAX_APK_BYTES || received > expected)
            throw invalid("invalid_download_count");
        if (count <= 0) return received;
        if ((long) count > expected - received) throw invalid("download_too_large");
        return received + count;
    }

    static boolean sameSignerSet(Set<String> installed, Set<String> archive, String declared) {
        if (installed == null || archive == null || installed.isEmpty() || !sha(declared)) return false;
        return installed.equals(archive) && archive.contains(declared.toLowerCase(Locale.ROOT));
    }

    /** Cheap gate used before offering a previously verified download on the UI thread. */
    static boolean canOfferReadyRelease(long readyBuild, long installedBuild,
                                        long expectedBytes, long stagedBytes) {
        return readyBuild > installedBuild && readyBuild <= Integer.MAX_VALUE
                && expectedBytes > 0 && expectedBytes <= MAX_APK_BYTES
                && stagedBytes == expectedBytes;
    }

    private static boolean sha(String value) {
        return SHA256.matcher(value(value).toLowerCase(Locale.ROOT)).matches();
    }

    private static String value(String value) { return value == null ? "" : value; }
    private static IllegalArgumentException invalid(String reason) {
        return new IllegalArgumentException(reason);
    }
}
