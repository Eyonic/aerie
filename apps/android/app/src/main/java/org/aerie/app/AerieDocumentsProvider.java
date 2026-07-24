package org.aerie.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import android.util.JsonReader;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Storage Access Framework facade over Aerie Drive. Metadata is fetched lazily
 * from the authenticated Files API; file bytes stream through WebDAV pipes and
 * are never accumulated into a full in-memory buffer.
 */
public final class AerieDocumentsProvider extends DocumentsProvider {
    private static final int BUFFER_SIZE = 64 * 1024;
    private static final int CONNECT_TIMEOUT = 8_000;
    private static final int READ_TIMEOUT = 30_000;
    private static final ExecutorService TRANSFERS = Executors.newFixedThreadPool(4, runnable -> {
        Thread thread = new Thread(runnable, "aerie-documents-transfer");
        thread.setDaemon(true);
        return thread;
    });
    private static final String[] ROOT_PROJECTION = {
            DocumentsContract.Root.COLUMN_ROOT_ID,
            DocumentsContract.Root.COLUMN_MIME_TYPES,
            DocumentsContract.Root.COLUMN_FLAGS,
            DocumentsContract.Root.COLUMN_ICON,
            DocumentsContract.Root.COLUMN_TITLE,
            DocumentsContract.Root.COLUMN_SUMMARY,
            DocumentsContract.Root.COLUMN_DOCUMENT_ID
    };
    private static final String[] DOCUMENT_PROJECTION = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_FLAGS,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED
    };

    private Context context;
    private SharedPreferences prefs;

    @Override public boolean onCreate() {
        context = getContext();
        if (context == null) return false;
        prefs = context.getSharedPreferences("aerie", Context.MODE_PRIVATE);
        return true;
    }

    @Override public Cursor queryRoots(String[] projection) {
        String grantScope = scope();
        String[] columns = projection == null ? ROOT_PROJECTION : projection;
        MatrixCursor result = new MatrixCursor(columns);
        Object[] row = new Object[columns.length];
        boolean configured = !servers().isEmpty() && SecureCredentialStore.getToken(context) != null;
        for (int i = 0; i < columns.length; i++) {
            switch (columns[i]) {
                case DocumentsContract.Root.COLUMN_ROOT_ID: row[i] = AerieDocumentId.rootId(grantScope); break;
                case DocumentsContract.Root.COLUMN_MIME_TYPES: row[i] = "*/*"; break;
                case DocumentsContract.Root.COLUMN_FLAGS:
                    row[i] = DocumentsContract.Root.FLAG_SUPPORTS_CREATE | DocumentsContract.Root.FLAG_SUPPORTS_IS_CHILD;
                    break;
                case DocumentsContract.Root.COLUMN_ICON: row[i] = R.mipmap.ic_launcher; break;
                case DocumentsContract.Root.COLUMN_TITLE: row[i] = "Aerie Drive"; break;
                case DocumentsContract.Root.COLUMN_SUMMARY:
                    row[i] = configured ? "Private files from your Aerie server" : "Open Aerie to connect";
                    break;
                case DocumentsContract.Root.COLUMN_DOCUMENT_ID:
                    row[i] = AerieDocumentId.forPath(grantScope, "/"); break;
                default: row[i] = null;
            }
        }
        result.addRow(row);
        return result;
    }

    @Override public Cursor queryDocument(String documentId, String[] projection) throws FileNotFoundException {
        String grantScope = scope();
        String path = decodeId(documentId, grantScope);
        MatrixCursor result = new MatrixCursor(projection == null ? DOCUMENT_PROJECTION : projection);
        result.setNotificationUri(context.getContentResolver(), documentUri(path, grantScope));
        if ("/".equals(path)) {
            addDocument(result, new FileMeta("/", "Aerie Drive",
                    DocumentsContract.Document.MIME_TYPE_DIR, 0, 0, true), grantScope);
            return result;
        }
        FileMeta wanted = null;
        for (FileMeta item : list(AerieDocumentId.parent(path), null, grantScope)) {
            if (path.equals(item.path)) { wanted = item; break; }
        }
        if (wanted == null) throw new FileNotFoundException(path);
        addDocument(result, wanted, grantScope);
        return result;
    }

    @Override public Cursor queryChildDocuments(String parentDocumentId, String[] projection,
                                                String sortOrder) throws FileNotFoundException {
        return queryChildren(parentDocumentId, projection, null);
    }

    private Cursor queryChildren(String parentDocumentId, String[] projection, CancellationSignal cancellation)
            throws FileNotFoundException {
        String grantScope = scope();
        String parent = decodeId(parentDocumentId, grantScope);
        MatrixCursor result = new MatrixCursor(projection == null ? DOCUMENT_PROJECTION : projection);
        for (FileMeta item : list(parent, cancellation, grantScope)) {
            throwIfCancelled(cancellation);
            addDocument(result, item, grantScope);
        }
        result.setNotificationUri(context.getContentResolver(), childrenUri(parent, grantScope));
        return result;
    }

    @Override public String createDocument(String parentDocumentId, String mimeType, String displayName)
            throws FileNotFoundException {
        String grantScope = scope();
        String parent = decodeId(parentDocumentId, grantScope);
        String path;
        try { path = AerieDocumentId.child(parent, displayName); }
        catch (IllegalArgumentException error) { throw missing(error.getMessage(), error); }
        if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType))
            mutate("MKCOL", path, null, false, grantScope);
        else mutate("PUT", path, null, true, grantScope);
        notifyChanged(parent, grantScope);
        notifyDocument(path, grantScope);
        return AerieDocumentId.forPath(grantScope, path);
    }

    @Override public void deleteDocument(String documentId) throws FileNotFoundException {
        String grantScope = scope();
        String path = decodeId(documentId, grantScope);
        if ("/".equals(path)) throw new FileNotFoundException("cannot_delete_root");
        mutate("DELETE", path, null, false, grantScope);
        notifyChanged(AerieDocumentId.parent(path), grantScope);
        notifyDocument(path, grantScope);
    }

    @Override public String renameDocument(String documentId, String displayName) throws FileNotFoundException {
        String grantScope = scope();
        String from = decodeId(documentId, grantScope);
        if ("/".equals(from)) throw new FileNotFoundException("cannot_rename_root");
        String to;
        try { to = AerieDocumentId.child(AerieDocumentId.parent(from), displayName); }
        catch (IllegalArgumentException error) { throw missing(error.getMessage(), error); }
        mutate("MOVE", from, to, false, grantScope);
        notifyChanged(AerieDocumentId.parent(from), grantScope);
        notifyDocument(from, grantScope);
        notifyDocument(to, grantScope);
        return AerieDocumentId.forPath(grantScope, to);
    }

    @Override public boolean isChildDocument(String parentDocumentId, String documentId) {
        String grantScope = scope();
        try { return AerieDocumentId.isChild(
                decodeId(parentDocumentId, grantScope), decodeId(documentId, grantScope)); }
        catch (FileNotFoundException | IllegalArgumentException ignored) { return false; }
    }

    @Override public ParcelFileDescriptor openDocument(String documentId, String mode,
                                                       CancellationSignal signal) throws FileNotFoundException {
        String grantScope = scope();
        String path = decodeId(documentId, grantScope);
        if ("/".equals(path)) throw new FileNotFoundException("is_directory");
        if (mode == null || "r".equals(mode)) return openRead(path, signal, grantScope);
        // Sequential writes and truncate-write modes stream directly. True
        // random-access/append cannot be represented safely by HTTP PUT.
        if ("rw".equals(mode) || "wa".equals(mode)) throw new FileNotFoundException("random_access_not_supported");
        if (mode.indexOf('w') >= 0 || mode.indexOf('t') >= 0) return openWrite(path, signal, grantScope);
        throw new FileNotFoundException("unsupported_mode");
    }

    private ParcelFileDescriptor openRead(String path, CancellationSignal signal, String grantScope)
            throws FileNotFoundException {
        throwIfCancelled(signal);
        final ParcelFileDescriptor[] pipe;
        try { pipe = ParcelFileDescriptor.createReliablePipe(); }
        catch (IOException error) { throw missing("pipe_failed", error); }
        closeOnCancel(signal, pipe[1]);
        TRANSFERS.execute(() -> {
            HttpURLConnection connection = null;
            ParcelFileDescriptor.AutoCloseOutputStream output =
                    new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]);
            try {
                connection = openDownload(path, signal, grantScope);
                try (InputStream input = connection.getInputStream()) { copy(input, output, signal); }
                output.close();
            } catch (Exception error) {
                try { pipe[1].closeWithError(safeMessage(error)); } catch (IOException ignored) { }
            } finally {
                if (connection != null) connection.disconnect();
                if (signal != null) signal.setOnCancelListener(null);
            }
        });
        return pipe[0];
    }

    private ParcelFileDescriptor openWrite(String path, CancellationSignal signal, String grantScope)
            throws FileNotFoundException {
        throwIfCancelled(signal);
        final ParcelFileDescriptor[] pipe;
        try { pipe = ParcelFileDescriptor.createReliablePipe(); }
        catch (IOException error) { throw missing("pipe_failed", error); }
        closeOnCancel(signal, pipe[0]);
        TRANSFERS.execute(() -> {
            HttpURLConnection connection = null;
            ParcelFileDescriptor.AutoCloseInputStream input =
                    new ParcelFileDescriptor.AutoCloseInputStream(pipe[0]);
            try {
                Upload upload = openUpload(path, signal, grantScope);
                connection = upload.connection;
                try (OutputStream output = upload.output) { copy(input, output, signal); }
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) throw new IOException("aerie_http_" + status);
                prefs.edit().putString("active_base", upload.base).apply();
                notifyChanged(AerieDocumentId.parent(path), grantScope);
                notifyDocument(path, grantScope);
                input.close();
            } catch (Exception error) {
                try { pipe[0].closeWithError(safeMessage(error)); } catch (IOException ignored) { }
            } finally {
                if (connection != null) connection.disconnect();
                if (signal != null) signal.setOnCancelListener(null);
            }
        });
        return pipe[1];
    }

    private HttpURLConnection openDownload(String path, CancellationSignal signal, String grantScope)
            throws IOException {
        IOException last = null;
        for (String base : servers()) {
            throwIfCancelled(signal);
            HttpURLConnection connection = null;
            try {
                connection = connection(base, "GET", davUrl(base, path), grantScope);
                int status = connection.getResponseCode();
                if (status >= 200 && status < 300) {
                    prefs.edit().putString("active_base", base).apply();
                    return connection;
                }
                if (status == 404) throw new FileNotFoundException(path);
                last = new IOException("aerie_http_" + status);
            } catch (IOException error) { last = error; }
            if (connection != null) connection.disconnect();
        }
        throw last == null ? new IOException("aerie_not_configured") : last;
    }

    private Upload openUpload(String path, CancellationSignal signal, String grantScope) throws IOException {
        IOException last = null;
        for (String base : servers()) {
            throwIfCancelled(signal);
            HttpURLConnection connection = null;
            try {
                connection = connection(base, "PUT", davUrl(base, path), grantScope);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/octet-stream");
                connection.setChunkedStreamingMode(BUFFER_SIZE);
                return new Upload(base, connection, connection.getOutputStream());
            } catch (IOException error) {
                last = error;
                if (connection != null) connection.disconnect();
            }
        }
        throw last == null ? new IOException("aerie_not_configured") : last;
    }

    private void mutate(String method, String path, String destination, boolean emptyBody, String grantScope)
            throws FileNotFoundException {
        Exception last = null;
        for (String base : servers()) {
            HttpURLConnection connection = null;
            try {
                String wireMethod = "PUT".equals(method) ? "PUT" : "POST";
                connection = connection(base, wireMethod, davUrl(base, path), grantScope);
                if (!wireMethod.equals(method)) connection.setRequestProperty("X-HTTP-Method-Override", method);
                if (destination != null) connection.setRequestProperty("Destination", davUrl(base, destination));
                if ("MOVE".equals(method)) connection.setRequestProperty("Overwrite", "F");
                if (emptyBody) {
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/octet-stream");
                    connection.setRequestProperty("If-None-Match", "*");
                    connection.setFixedLengthStreamingMode(0);
                    connection.getOutputStream().close();
                }
                int status = connection.getResponseCode();
                if (status >= 200 && status < 300) {
                    prefs.edit().putString("active_base", base).apply();
                    return;
                }
                if (status == 404) throw new FileNotFoundException(path);
                last = new IOException("aerie_http_" + status);
            } catch (Exception error) { last = error; }
            finally { if (connection != null) connection.disconnect(); }
        }
        throw missing(last == null ? "aerie_not_configured" : safeMessage(last), last);
    }

    private List<FileMeta> list(String path, CancellationSignal cancellation, String grantScope)
            throws FileNotFoundException {
        Exception last = null;
        for (String base : servers()) {
            HttpURLConnection connection = null;
            try {
                String endpoint = base + "/api/files/list?path=" + Uri.encode(path);
                connection = connection(base, "GET", endpoint, grantScope);
                int status = connection.getResponseCode();
                if (status == 404) throw new FileNotFoundException(path);
                if (status < 200 || status >= 300) throw new IOException("aerie_http_" + status);
                List<FileMeta> result = parseListing(connection.getInputStream(), path, cancellation);
                prefs.edit().putString("active_base", base).apply();
                return result;
            } catch (OperationCanceledException error) { throw error; }
            catch (Exception error) { last = error; }
            finally { if (connection != null) connection.disconnect(); }
        }
        throw missing(last == null ? "aerie_not_configured" : safeMessage(last), last);
    }

    private List<FileMeta> parseListing(InputStream stream, String requestedParent, CancellationSignal cancellation)
            throws IOException {
        List<FileMeta> result = new ArrayList<>();
        try (JsonReader reader = new JsonReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            reader.beginObject();
            while (reader.hasNext()) {
                throwIfCancelled(cancellation);
                String property = reader.nextName();
                if (!"entries".equals(property)) { reader.skipValue(); continue; }
                reader.beginArray();
                while (reader.hasNext()) {
                    throwIfCancelled(cancellation);
                    FileMeta item = readEntry(reader);
                    if (item != null && requestedParent.equals(AerieDocumentId.parent(item.path))) result.add(item);
                }
                reader.endArray();
            }
            reader.endObject();
        }
        return result;
    }

    private FileMeta readEntry(JsonReader reader) throws IOException {
        String path = null, name = null, mime = null, modified = null;
        long size = 0;
        boolean directory = false;
        reader.beginObject();
        while (reader.hasNext()) {
            String key = reader.nextName();
            switch (key) {
                case "path": path = nextString(reader); break;
                case "name": name = nextString(reader); break;
                case "mime": mime = nextString(reader); break;
                case "modifiedAt": modified = nextString(reader); break;
                case "size": size = nextLong(reader); break;
                case "isFolder": directory = reader.nextBoolean(); break;
                default: reader.skipValue();
            }
        }
        reader.endObject();
        if (path == null || name == null) return null;
        try {
            path = AerieDocumentId.normalize(path);
            AerieDocumentId.validateName(name);
        } catch (IllegalArgumentException error) { return null; }
        if ("/".equals(path) || !name.equals(path.substring(path.lastIndexOf('/') + 1))) return null;
        if (directory) mime = DocumentsContract.Document.MIME_TYPE_DIR;
        else if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        return new FileMeta(path, name, mime, Math.max(0, size), parseDate(modified), directory);
    }

    private static String nextString(JsonReader reader) throws IOException {
        if (reader.peek() == android.util.JsonToken.NULL) { reader.nextNull(); return null; }
        return reader.nextString();
    }

    private static long nextLong(JsonReader reader) throws IOException {
        if (reader.peek() == android.util.JsonToken.NULL) { reader.nextNull(); return 0; }
        if (reader.peek() != android.util.JsonToken.NUMBER && reader.peek() != android.util.JsonToken.STRING) {
            reader.skipValue(); return 0;
        }
        try { return Long.parseLong(reader.nextString()); }
        catch (NumberFormatException error) { return 0; }
    }

    private HttpURLConnection connection(String base, String method, String endpoint, String grantScope)
            throws IOException {
        String token = DeviceAuthClient.validToken(context, base);
        if (token == null || token.isEmpty()) throw new IOException("aerie_sign_in_required");
        if (!grantScope.equals(scope())) throw new IOException("aerie_credential_changed");
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT);
        connection.setReadTimeout(READ_TIMEOUT);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json, */*");
        return connection;
    }

    private List<String> servers() {
        return ServerEndpointResolver.candidates(context, null);
    }

    private static String davUrl(String base, String path) {
        StringBuilder out = new StringBuilder(base).append("/dav");
        if ("/".equals(path)) return out.append('/').toString();
        for (String part : AerieDocumentId.normalize(path).substring(1).split("/")) out.append('/').append(Uri.encode(part));
        return out.toString();
    }

    private void addDocument(MatrixCursor cursor, FileMeta item, String grantScope) {
        String[] columns = cursor.getColumnNames();
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            switch (columns[i]) {
                case DocumentsContract.Document.COLUMN_DOCUMENT_ID:
                    row[i] = AerieDocumentId.forPath(grantScope, item.path); break;
                case DocumentsContract.Document.COLUMN_DISPLAY_NAME: row[i] = item.name; break;
                case DocumentsContract.Document.COLUMN_MIME_TYPE: row[i] = item.mime; break;
                case DocumentsContract.Document.COLUMN_FLAGS:
                    int flags = 0;
                    if (!"/".equals(item.path)) flags |= DocumentsContract.Document.FLAG_SUPPORTS_DELETE
                            | DocumentsContract.Document.FLAG_SUPPORTS_RENAME;
                    if (item.directory) flags |= DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE;
                    else flags |= DocumentsContract.Document.FLAG_SUPPORTS_WRITE;
                    row[i] = flags;
                    break;
                case DocumentsContract.Document.COLUMN_SIZE: row[i] = item.directory ? null : item.size; break;
                case DocumentsContract.Document.COLUMN_LAST_MODIFIED: row[i] = item.modified > 0 ? item.modified : null; break;
                default: row[i] = null;
            }
        }
        cursor.addRow(row);
    }

    private String decodeId(String documentId, String grantScope) throws FileNotFoundException {
        try { return AerieDocumentId.pathFor(grantScope, documentId); }
        catch (IllegalArgumentException error) { throw missing("invalid_document_id", error); }
    }

    private void notifyChanged(String parent, String grantScope) {
        try {
            context.getContentResolver().notifyChange(childrenUri(parent, grantScope), null, false);
        } catch (Exception ignored) { }
    }

    private void notifyDocument(String path, String grantScope) {
        try { context.getContentResolver().notifyChange(documentUri(path, grantScope), null, false); }
        catch (Exception ignored) { }
    }

    private static Uri childrenUri(String parent, String grantScope) {
        return DocumentsContract.buildChildDocumentsUri(
                BuildConfig.APPLICATION_ID + ".documents", AerieDocumentId.forPath(grantScope, parent));
    }

    private static Uri documentUri(String path, String grantScope) {
        return DocumentsContract.buildDocumentUri(
                BuildConfig.APPLICATION_ID + ".documents", AerieDocumentId.forPath(grantScope, path));
    }

    private String scope() { return DocumentGrantScope.current(context); }

    private static void copy(InputStream input, OutputStream output, CancellationSignal cancellation) throws IOException {
        byte[] buffer = new byte[BUFFER_SIZE];
        for (int count; (count = input.read(buffer)) >= 0; ) {
            throwIfCancelled(cancellation);
            if (count > 0) output.write(buffer, 0, count);
        }
        output.flush();
    }

    private static void throwIfCancelled(CancellationSignal signal) {
        if (signal != null && signal.isCanceled()) throw new OperationCanceledException();
    }

    private static void closeOnCancel(CancellationSignal signal, ParcelFileDescriptor transferEnd) {
        if (signal == null) return;
        signal.setOnCancelListener(() -> {
            try { transferEnd.closeWithError("Aerie Drive transfer cancelled"); }
            catch (IOException ignored) { }
        });
    }

    private static long parseDate(String value) {
        if (value == null || value.isEmpty()) return 0;
        String[] patterns = { "yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX" };
        for (String pattern : patterns) {
            try {
                SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
                format.setTimeZone(TimeZone.getTimeZone("UTC"));
                Date parsed = format.parse(value);
                if (parsed != null) return parsed.getTime();
            } catch (ParseException ignored) { }
        }
        return 0;
    }

    private static FileNotFoundException missing(String message, Throwable cause) {
        FileNotFoundException out = new FileNotFoundException(message == null ? "aerie_drive_error" : message);
        if (cause != null) out.initCause(cause);
        return out;
    }

    private static String safeMessage(Throwable error) {
        String value = error == null ? null : error.getMessage();
        if (value == null || value.isEmpty()) return "Aerie Drive transfer failed";
        return value.length() > 160 ? value.substring(0, 160) : value;
    }

    private static final class FileMeta {
        final String path, name, mime;
        final long size, modified;
        final boolean directory;
        FileMeta(String path, String name, String mime, long size, long modified, boolean directory) {
            this.path = path; this.name = name; this.mime = mime;
            this.size = size; this.modified = modified; this.directory = directory;
        }
    }

    private static final class Upload {
        final String base;
        final HttpURLConnection connection;
        final OutputStream output;
        Upload(String base, HttpURLConnection connection, OutputStream output) {
            this.base = base; this.connection = connection; this.output = output;
        }
    }
}
