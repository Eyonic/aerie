const { app, dialog } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createMeshNode } = require('./mesh');
const {
  changesPath, manifestPath, missingManifestStableIds, persistThenAck, validatedChangePage,
} = require('./sync-journal');

const TOLERANCE_MS = 2000;
const MAX_FILE = 20 * 1024 * 1024 * 1024;
const CHECK_CHUNK = 5000;
const SYNC_INTERVAL = 15 * 60 * 1000;
const OFFLINE_INTERVAL = 60 * 1000;
const MAX_JSON_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 1024 * 1024;
const JSON_DEADLINE_MS = 90 * 1000;
const JSON_IDLE_MS = 20 * 1000;
const TRANSFER_IDLE_MS = 2 * 60 * 1000;
const MIN_TRANSFER_DEADLINE_MS = 5 * 60 * 1000;
const MAX_TRANSFER_DEADLINE_MS = 48 * 60 * 60 * 1000;
const MIN_TRANSFER_BYTES_PER_SECOND = 128 * 1024;

function localPath(root, rel) {
  const value = String(rel || '').replace(/\\/g, '/');
  const parts = value.split('/');
  if (!value || value.startsWith('/') || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('invalid_sync_path');
  }
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, ...parts);
  if (target !== rootPath && !target.startsWith(rootPath + path.sep)) throw new Error('sync_path_escape');
  return target;
}

function sameFilesystemPath(a, b) {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function openVerifiedRegular(filename, flags) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const handle = await fsp.open(filename, flags | noFollow, 0o600);
  try {
    const [pathStat, handleStat] = await Promise.all([fsp.lstat(filename), handle.stat()]);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !handleStat.isFile()
        || pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino) {
      throw new Error('unsafe_sync_file');
    }
    return { handle, stat: handleStat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Resolve through a real, non-link root and reject every link/junction parent. */
async function safeLocalPath(root, rel, createParents = false) {
  const configuredRoot = path.resolve(root);
  const rootStat = await fsp.lstat(configuredRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe_sync_root');
  const realRoot = await fsp.realpath(configuredRoot);
  if (!sameFilesystemPath(realRoot, configuredRoot)) throw new Error('unsafe_sync_root');
  const target = localPath(realRoot, rel);
  const parentParts = path.relative(realRoot, path.dirname(target)).split(path.sep).filter(Boolean);
  let current = realRoot;
  for (const part of parentParts) {
    current = path.join(current, part);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!createParents) break;
      try { await fsp.mkdir(current); }
      catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
      stat = await fsp.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_sync_parent');
    const realParent = await fsp.realpath(current);
    if (!sameFilesystemPath(realParent, current)) throw new Error('unsafe_sync_parent');
  }
  return target;
}

function transferDeadlineMs(byteCount) {
  const bytes = Number.isFinite(byteCount) && byteCount > 0 ? byteCount : 0;
  const estimate = Math.ceil(bytes / MIN_TRANSFER_BYTES_PER_SECOND * 1000) + 2 * 60 * 1000;
  return Math.min(MAX_TRANSFER_DEADLINE_MS, Math.max(MIN_TRANSFER_DEADLINE_MS, estimate));
}

function deadlineSignal(signal, deadlineMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(deadlineMs)));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function signalError(signal, fallback) {
  if (!signal?.aborted) return fallback;
  const reason = signal.reason;
  if (reason?.name === 'TimeoutError') return new Error('request_deadline', { cause: fallback });
  return reason instanceof Error ? reason : new Error('request_aborted', { cause: fallback });
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signalError(signal, new Error('request_aborted')));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signalError(signal, new Error('request_aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function waitForRead(reader, idleMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, signalError(signal, new Error('request_aborted')));
    const timer = setTimeout(() => finish(reject, new Error('response_idle_timeout')), idleMs);
    timer.unref?.();
    if (signal?.aborted) return onAbort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(value => finish(resolve, value), error => finish(reject, error));
  });
}

async function readJsonResponse(response, options = {}) {
  const maxBytes = options.maxBytes || MAX_JSON_RESPONSE_BYTES;
  const idleMs = options.idleMs || JSON_IDLE_MS;
  const claimed = response.headers.get('content-length');
  if (/^\d+$/.test(claimed || '') && Number(claimed) > maxBytes) {
    response.body?.cancel().catch(() => {});
    throw new Error('response_too_large');
  }
  if (!response.body) throw new Error('invalid_json_response');
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await waitForRead(reader, idleMs, options.signal);
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error('response_too_large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* a pending cancellation still owns the reader */ }
  }
  if (!received) throw new Error('invalid_json_response');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, received));
    return JSON.parse(text);
  } catch (error) {
    throw new Error('invalid_json_response', { cause: error });
  }
}

function createIdleAbort(idleMs, code) {
  const controller = new AbortController();
  let timer;
  const touch = () => {
    clearTimeout(timer);
    if (controller.signal.aborted) return;
    timer = setTimeout(() => controller.abort(new Error(code)), idleMs);
    timer.unref?.();
  };
  const stop = () => clearTimeout(timer);
  touch();
  return { signal: controller.signal, touch, stop };
}

function createDownloadMonitor(maxBytes, idleMs = TRANSFER_IDLE_MS) {
  let received = 0;
  let timer;
  const monitor = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(new Error('download_too_large'));
      arm();
      callback(null, chunk);
    },
  });
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => monitor.destroy(new Error('download_idle_timeout')), idleMs);
    timer.unref?.();
  };
  monitor.once('close', () => clearTimeout(timer));
  arm();
  return monitor;
}

function createMultipartUpload(item, fields, onActivity) {
  const boundary = `----AerieSync${crypto.randomBytes(24).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`));
  }
  const filename = path.basename(item.rel).replace(/["\r\n]/g, '_') || 'file';
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  const prefix = Buffer.concat(parts);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: prefix.length + item.size + suffix.length,
    bodyFactory() {
      const body = async function* () {
        let sent = 0;
        let source;
        let opened;
        try {
          if (typeof item.root !== 'string') throw new Error('unsafe_sync_root');
          const safeSource = await safeLocalPath(item.root, item.rel, false);
          if (!sameFilesystemPath(safeSource, item.full)) throw new Error('unsafe_sync_source');
          opened = await openVerifiedRegular(safeSource, fs.constants.O_RDONLY);
          const realSource = await fsp.realpath(safeSource);
          const realRoot = await fsp.realpath(item.root);
          if (realSource !== realRoot && !realSource.startsWith(realRoot + path.sep)) throw new Error('unsafe_sync_source');
          const before = opened.stat;
          if (before.size !== item.size || Math.abs(before.mtimeMs - item.mtimeMs) >= 1) {
            throw new Error('file_changed_during_sync');
          }
          source = opened.handle.createReadStream({ autoClose: false });
          onActivity();
          yield prefix;
          for await (const chunk of source) {
            sent += chunk.length;
            if (sent > item.size) throw new Error('file_changed_during_sync');
            onActivity();
            yield chunk;
          }
          const checkedAgain = await safeLocalPath(item.root, item.rel, false);
          if (!sameFilesystemPath(checkedAgain, item.full)) throw new Error('unsafe_sync_source');
          const [after, pathAfter] = await Promise.all([opened.handle.stat(), fsp.lstat(item.full)]);
          if (pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
              || sent !== item.size || after.size !== before.size || Math.abs(after.mtimeMs - before.mtimeMs) >= 1) {
            throw new Error('file_changed_during_sync');
          }
          onActivity();
          yield suffix;
        } finally {
          source?.destroy();
          await opened?.handle.close().catch(() => {});
        }
      };
      return Readable.toWeb(Readable.from(body()));
    },
  };
}

function createSyncEngine(options = {}) {
  const statePath = path.join(app.getPath('userData'), 'sync.json');
  const credentialStore = options.credentialStore || null;
  let state = load();
  if (credentialStore && state.serverUrl) {
    try { state.token = credentialStore.loadAccessToken(state.serverUrl)?.token || state.token || ''; } catch { /* invalid/changed origin */ }
  }
  let timers = [];
  const watchers = new Map();
  const status = new Map();
  const running = new Set();
  const responseSignals = new WeakMap();
  const meshNode = createMeshNode({
    serverFetch: (pathname, opts) => authorizedFetch(api(pathname), opts),
    resolveResource: resolveMeshResource,
  });

  function load() {
    try {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const folders = Array.isArray(s.folders) ? s.folders.map(folder => ({
        ...folder,
        cursor: Number.isSafeInteger(folder.cursor) && folder.cursor >= 0 ? folder.cursor : 0,
        snapshot: folder.snapshot && typeof folder.snapshot === 'object' ? folder.snapshot : {},
        fabric: folder.fabric === 2 ? 2 : 0,
        fabricBase: typeof folder.fabricBase === 'string' ? folder.fabricBase : '',
      })) : [];
      return {
        folders,
        token: s.token || '',
        serverUrl: s.serverUrl || '',
        deviceId: /^[a-zA-Z0-9_-]{1,64}$/.test(s.deviceId || '') ? s.deviceId : `desktop-${crypto.randomUUID()}`,
      };
    } catch {
      return { folders: [], token: '', serverUrl: '', deviceId: `desktop-${crypto.randomUUID()}` };
    }
  }

  function saveOrThrow() {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = statePath + '.tmp';
    // Access tokens belong in Electron safeStorage, never in sync.json. A
    // legacy token is kept in memory for this run and disappears on save.
    const { token: _token, ...persisted } = state;
    let fd;
    try {
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeFileSync(fd, JSON.stringify(persisted, null, 2));
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, statePath);
      // Persist the directory entry where the platform supports directory
      // fsync. Windows may reject opening a directory, but the atomic rename
      // above still prevents a partially written cursor file.
      let directoryFd;
      try {
        directoryFd = fs.openSync(path.dirname(statePath), 'r');
        fs.fsyncSync(directoryFd);
      } catch { /* unsupported by this filesystem */ }
      finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
  }

  function save() {
    try { saveOrThrow(); return true; }
    catch { return false; }
  }

  function cleanUrl(u) { return String(u || '').replace(/\/+$/, ''); }
  function baseFor(f) { return `Sync/${safeLabel(f.label)}`; }
  function safeLabel(s) { return String(s || 'Folder').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, 'Folder').slice(0, 80) || 'Folder'; }
  function authHeaders(json) {
    const h = {};
    if (state.token) h.Authorization = `Bearer ${state.token}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  function api(pathname) {
    const base = cleanUrl(state.serverUrl);
    if (!base) throw new Error('server_url_missing');
    return base + pathname;
  }

  let authRefresh = null;
  async function refreshAccessToken() {
    if (!credentialStore || typeof credentialStore.authenticate !== 'function' || !state.serverUrl) return false;
    if (!authRefresh) {
      authRefresh = credentialStore.authenticate(state.serverUrl)
        .then(session => {
          if (!session?.token) return false;
          state.token = session.token;
          return true;
        })
        .finally(() => { authRefresh = null; });
    }
    return authRefresh;
  }

  async function authorizedFetch(url, opts = {}, retry = true) {
    const {
      deadlineMs = JSON_DEADLINE_MS,
      bodyFactory,
      signal: callerSignal,
      ...requestOptions
    } = opts;
    const requestSignal = deadlineSignal(callerSignal, deadlineMs);
    const send = async headers => {
      try {
        const body = bodyFactory ? bodyFactory() : requestOptions.body;
        const response = await fetch(url, {
          ...requestOptions,
          body,
          headers,
          redirect: 'error',
          signal: requestSignal,
          ...(bodyFactory ? { duplex: 'half' } : {}),
        });
        responseSignals.set(response, requestSignal);
        return response;
      } catch (error) {
        throw signalError(requestSignal, error);
      }
    };
    const headers = new Headers(requestOptions.headers || {});
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    let response = await send(headers);
    if (response.status === 401 && retry && await awaitWithSignal(refreshAccessToken(), requestSignal)) {
      await response.body?.cancel().catch(() => {});
      const freshHeaders = new Headers(opts.headers || {});
      freshHeaders.set('Authorization', `Bearer ${state.token}`);
      response = await send(freshHeaders);
    }
    return response;
  }

  async function fetchJson(pathname, opts = {}) {
    const res = await authorizedFetch(api(pathname), { ...opts, deadlineMs: opts.deadlineMs || JSON_DEADLINE_MS });
    const signal = responseSignals.get(res);
    if (!res.ok) {
      const error = new Error(res.status === 401 ? 'unauthorized' : `http_${res.status}`);
      error.status = res.status;
      try { error.body = await readJsonResponse(res, { maxBytes: MAX_ERROR_RESPONSE_BYTES, signal }); } catch { /* response was not JSON */ }
      throw error;
    }
    return readJsonResponse(res, { signal });
  }

  async function contentHash(filename) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
  }

  async function walk(root) {
    const out = [];
    out.scanComplete = true;
    async function step(dir, prefix) {
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
      catch (error) {
        if (error?.code !== 'ENOENT' || !prefix) out.scanComplete = false;
        return;
      }
      for (const ent of ents) {
        if (ent.name.startsWith('.') || ent.name.endsWith('.aerie-part') || ent.name.endsWith('.aerie-replaced')) continue;
        if (ent.name.includes('\\')) { out.scanComplete = false; continue; }
        const full = path.join(dir, ent.name);
        const rel = prefix ? path.posix.join(prefix, ent.name) : ent.name;
        let st;
        try { st = await fsp.lstat(full); }
        catch (error) { if (error?.code !== 'ENOENT') out.scanComplete = false; continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) await step(full, rel);
        else if (st.isFile()) out.push({
          rel, size: st.size, mtimeMs: st.mtimeMs, full, root, fileId: `${st.dev}:${st.ino}`,
          tooLarge: st.size > MAX_FILE,
        });
      }
    }
    await step(root, '');
    return out;
  }

  async function check(base, files) {
    const needed = new Set();
    const conflicts = new Set();
    for (let i = 0; i < files.length; i += CHECK_CHUNK) {
      const chunk = files.slice(i, i + CHECK_CHUNK).map(({ rel, size, mtimeMs }) => ({ rel, size, mtimeMs }));
      const r = await fetchJson('/api/sync/check', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ base, files: chunk }),
      });
      (r.needed || []).forEach(x => needed.add(x));
      (r.conflicts || []).forEach(x => conflicts.add(x));
    }
    return { needed, conflicts };
  }

  async function uploadOne(base, item, fabric = null) {
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE) throw new Error('invalid_upload_size');
    const idle = createIdleAbort(TRANSFER_IDLE_MS, 'upload_idle_timeout');
    const multipart = createMultipartUpload(item, {
      base,
      rel: item.rel,
      mtimeMs: String(item.mtimeMs),
      deviceId: fabric ? state.deviceId : undefined,
      contentHash: fabric ? item.contentHash : undefined,
      expectedHash: fabric ? (fabric.expectedHash || 'missing') : undefined,
      stableId: fabric?.stableId,
    }, idle.touch);
    try {
      const headers = authHeaders(false);
      headers['Content-Type'] = multipart.contentType;
      headers['Content-Length'] = String(multipart.contentLength);
      headers['X-Aerie-Upload-Length'] = String(item.size);
      const res = await authorizedFetch(api('/api/sync/upload'), {
        method: 'POST', headers, bodyFactory: multipart.bodyFactory,
        signal: idle.signal, deadlineMs: transferDeadlineMs(item.size),
      });
      idle.touch();
      const signal = responseSignals.get(res);
      if (!res.ok) {
        const error = new Error(`upload_${res.status}`);
        error.status = res.status;
        try { error.body = await readJsonResponse(res, { maxBytes: MAX_ERROR_RESPONSE_BYTES, signal }); } catch { /* response was not JSON */ }
        throw error;
      }
      return await readJsonResponse(res, { signal });
    } finally {
      idle.stop();
    }
  }

  async function eachLimit(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  function sidecarPath(destination, suffix) {
    const id = crypto.createHash('sha256').update(destination).digest('hex').slice(0, 20);
    return path.join(path.dirname(destination), `.${id}${suffix}`);
  }

  async function replaceFile(tmp, dest) {
    const backup = sidecarPath(dest, '.aerie-replaced');
    const legacyBackup = dest + '.aerie-replaced';
    for (const candidate of [backup, legacyBackup]) {
      let candidateExists = false;
      let destinationExists = false;
      try {
        const stat = await fsp.lstat(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe_sync_sidecar');
        candidateExists = true;
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      try { await fsp.lstat(dest); destinationExists = true; } catch { /* absent */ }
      if (candidateExists && !destinationExists) await fsp.rename(candidate, dest);
      else if (candidateExists) await fsp.rm(candidate, { force: true });
    }
    let hadOld = false;
    try { await fsp.rename(dest, backup); hadOld = true; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    try {
      await fsp.rename(tmp, dest);
      if (hadOld) await fsp.rm(backup, { force: true });
    } catch (error) {
      if (hadOld) await fsp.rename(backup, dest).catch(() => {});
      throw error;
    }
  }

  async function downloadOne(base, rootPath, item, retry = true, allowMesh = true) {
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE) throw new Error('invalid_download_size');
    const dest = await safeLocalPath(rootPath, item.rel, true);
    const tmp = sidecarPath(dest, '.aerie-part');
    const legacyTmp = dest + '.aerie-part';
    let hasNewPartial = false;
    try {
      const partial = await fsp.lstat(tmp);
      if (!partial.isFile() || partial.isSymbolicLink()) throw new Error('unsafe_sync_partial');
      hasNewPartial = true;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (!hasNewPartial) {
      try {
        const legacy = await fsp.lstat(legacyTmp);
        if (!legacy.isFile() || legacy.isSymbolicLink()) throw new Error('unsafe_sync_partial');
        await fsp.rename(legacyTmp, tmp);
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    let offset = 0;
    let responseMtime = Number(item.mtimeMs);
    try {
      const partial = await fsp.lstat(tmp);
      if (!partial.isFile() || partial.isSymbolicLink()) throw new Error('unsafe_sync_partial');
      offset = partial.size;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (Number.isFinite(item.size) && offset > item.size) { await fsp.rm(tmp, { force: true }); offset = 0; }
    // A partial without a known content identity cannot be resumed safely: an
    // older server may now serve different bytes at the same relative path.
    if (offset > 0 && !item.contentHash) { await fsp.rm(tmp, { force: true }); offset = 0; }

    if (!(Number.isFinite(item.size) && offset === item.size && offset > 0)) {
      if (allowMesh && /^[a-f0-9]{64}$/.test(String(item.contentHash || '')) && Number.isSafeInteger(item.size)) {
        const mesh = await meshNode.download({
          kind: 'sync-file', base, rel: item.rel, contentHash: item.contentHash, size: item.size,
        }, tmp, offset).catch(() => null);
        if (mesh?.mtimeMs) responseMtime = Number(mesh.mtimeMs) || responseMtime;
        try {
          const partial = await fsp.lstat(tmp);
          if (!partial.isFile() || partial.isSymbolicLink()) throw new Error('unsafe_sync_partial');
          offset = partial.size;
        } catch (error) { if (error?.code === 'ENOENT') offset = 0; else throw error; }
      }
    }

    if (!(Number.isFinite(item.size) && offset === item.size && offset > 0)) {
      const headers = authHeaders(false);
      if (offset > 0) {
        headers.Range = `bytes=${offset}-`;
        if (item.contentHash) headers['If-Range'] = `\"sha256-${item.contentHash}\"`;
      }
      const expectedBytes = offset > 0 ? item.size - offset : item.size;
      const res = await authorizedFetch(api(`/api/sync/file?base=${encodeURIComponent(base)}&rel=${encodeURIComponent(item.rel)}`), {
        headers, deadlineMs: transferDeadlineMs(expectedBytes),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`download_${res.status}`);
      }
      responseMtime = Number(res.headers.get('x-mtime-ms')) || responseMtime;
      const append = offset > 0 && res.status === 206;
      if (!res.body) throw new Error('download_empty_body');
      const maxBytes = append ? item.size - offset : item.size;
      const declaredLength = res.headers.get('content-length');
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== maxBytes)) {
        await res.body.cancel().catch(() => {});
        throw new Error('download_size_mismatch');
      }
      if (res.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
        const expectedStart = append ? offset : 0;
        if (!match || Number(match[1]) !== expectedStart || Number(match[2]) !== item.size - 1
            || Number(match[3]) !== item.size || Number(match[2]) - Number(match[1]) + 1 !== maxBytes) {
          await res.body.cancel().catch(() => {});
          throw new Error('download_range_mismatch');
        }
      }
      const signal = responseSignals.get(res);
      const opened = await openVerifiedRegular(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | (append ? fs.constants.O_APPEND : 0));
      try {
        if (append && opened.stat.size !== offset) throw new Error('download_partial_changed');
        if (!append) await opened.handle.truncate(0);
        await pipeline(
          Readable.fromWeb(res.body),
          createDownloadMonitor(maxBytes),
          opened.handle.createWriteStream({ autoClose: false, ...(append ? {} : { start: 0 }) }),
          signal ? { signal } : {},
        );
      } catch (error) {
        throw signalError(signal, error);
      } finally {
        await opened.handle.close().catch(() => {});
      }
    }

    const finalStat = await fsp.lstat(tmp);
    if (!finalStat.isFile() || finalStat.isSymbolicLink()) throw new Error('unsafe_sync_partial');
    if (Number.isFinite(item.size) && finalStat.size !== item.size) throw new Error('download_size_mismatch');
    if (item.contentHash) {
      const actual = await contentHash(tmp);
      if (actual !== item.contentHash) {
        await fsp.rm(tmp, { force: true });
        // Never ask the same peer for a second copy after an integrity
        // failure. The retry is forced through the authoritative cloud path.
        if (retry) return downloadOne(base, rootPath, item, false, false);
        throw new Error('download_hash_mismatch');
      }
    }
    const checkedDestination = await safeLocalPath(rootPath, item.rel, true);
    if (!sameFilesystemPath(checkedDestination, dest)) throw new Error('unsafe_sync_destination');
    await replaceFile(tmp, dest);
    const mt = responseMtime;
    if (Number.isFinite(mt)) {
      const d = new Date(mt);
      const installed = await fsp.lstat(dest);
      if (!installed.isFile() || installed.isSymbolicLink()) throw new Error('unsafe_sync_destination');
      await fsp.utimes(dest, d, d).catch(() => {});
    }
    return dest;
  }

  function setStatus(id, patch) {
    const cur = status.get(id) || { state: 'idle', pending: 0, uploaded: 0, downloaded: 0, conflicts: 0, lastSync: null, lastError: '' };
    status.set(id, { ...cur, ...patch });
  }

  function snapshotFor(f) {
    if (!f.snapshot || typeof f.snapshot !== 'object') f.snapshot = {};
    return f.snapshot;
  }

  async function resolveMeshResource(resource) {
    if (!resource || resource.kind !== 'sync-file'
        || typeof resource.base !== 'string' || typeof resource.rel !== 'string'
        || !/^[a-f0-9]{64}$/.test(String(resource.contentHash || ''))
        || !Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > MAX_FILE) return null;
    const folder = state.folders.find(item => item.enabled && baseFor(item) === resource.base);
    if (!folder) return null;
    let filename;
    try { filename = await safeLocalPath(folder.localPath, resource.rel, false); } catch { return null; }
    try {
      // localPath blocks lexical traversal. realpath additionally blocks a
      // directory swapped for a symlink after the last sync scan.
      const realRoot = await fsp.realpath(folder.localPath);
      const realFile = await fsp.realpath(filename);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return null;
      const stat = await fsp.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== resource.size) return null;
      const cached = Object.values(snapshotFor(folder)).find(entry => entry.rel === resource.rel
        && entry.contentHash === resource.contentHash && entry.size === resource.size);
      if (!cached || Math.abs(Number(cached.mtimeMs) - stat.mtimeMs) >= 1) {
        if (await contentHash(filename) !== resource.contentHash) return null;
      }
      return {
        path: filename, size: stat.size, mtimeMs: stat.mtimeMs, contentHash: resource.contentHash,
        dev: stat.dev, ino: stat.ino,
      };
    } catch { return null; }
  }

  function conflictRel(rel, hash) {
    function utf8Prefix(value, maxBytes) {
      const chars = Array.from(value);
      while (chars.length && Buffer.byteLength(chars.join(''), 'utf8') > maxBytes) chars.pop();
      return chars.join('');
    }
    const rawExt = path.posix.extname(rel);
    const ext = utf8Prefix(rawExt, 24);
    const stem = utf8Prefix(path.posix.basename(rel, rawExt), 180);
    const dir = path.posix.dirname(rel);
    const device = state.deviceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'device';
    const leaf = `${stem} (Aerie conflict ${device}-${hash.slice(0, 8)})${ext}`;
    return dir === '.' ? leaf : path.posix.join(dir, leaf);
  }

  async function localInfo(filename) {
    try {
      const stat = await fsp.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        fileId: `${stat.dev}:${stat.ino}`,
        contentHash: await contentHash(filename),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function removeLocalParents(filename, root) {
    let dir = path.dirname(filename);
    while (dir !== root && dir.startsWith(root + path.sep)) {
      try { await fsp.rmdir(dir); } catch { break; }
      dir = path.dirname(dir);
    }
  }

  async function preserveLocalConflict(root, rel, hash) {
    const source = await safeLocalPath(root, rel, false);
    const targetRel = conflictRel(rel, hash);
    const target = await safeLocalPath(root, targetRel, true);
    if (source === target) return targetRel;
    const existing = await localInfo(target);
    if (existing) {
      if (existing.contentHash !== hash) throw new Error('local_conflict_name_collision');
      await fsp.unlink(source).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      return targetRel;
    }
    await safeLocalPath(root, targetRel, true);
    await fsp.rename(source, target);
    await removeLocalParents(source, root);
    return targetRel;
  }

  async function snapshotFromPath(f, serverEntry, rel = serverEntry.rel) {
    const filename = await safeLocalPath(f.localPath, rel, false);
    const stat = await fsp.lstat(filename);
    snapshotFor(f)[serverEntry.stableId] = {
      stableId: serverEntry.stableId,
      rel,
      contentHash: serverEntry.contentHash,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      fileId: `${stat.dev}:${stat.ino}`,
    };
  }

  async function applyServerEntry(f, change) {
    const snapshot = snapshotFor(f);
    const prior = snapshot[change.stableId];
    const sourceRel = prior?.rel || change.previousRel || change.rel;
    const source = await safeLocalPath(f.localPath, sourceRel, false);
    let sourceInfo = await localInfo(source);
    let conflicts = 0;

    if (sourceInfo) {
      if (sourceInfo.contentHash === change.contentHash) {
        if (sourceRel !== change.rel) {
          const destination = await safeLocalPath(f.localPath, change.rel, true);
          const destinationInfo = await localInfo(destination);
          if (destinationInfo && destinationInfo.contentHash !== change.contentHash) {
            await preserveLocalConflict(f.localPath, change.rel, destinationInfo.contentHash);
            conflicts++;
          } else if (destinationInfo) {
            await fsp.unlink(source);
            await removeLocalParents(source, f.localPath);
            await snapshotFromPath(f, change);
            return { downloaded: 0, conflicts };
          }
          await safeLocalPath(f.localPath, change.rel, true);
          await fsp.rename(source, destination);
          await removeLocalParents(source, f.localPath);
        }
        await snapshotFromPath(f, change);
        return { downloaded: 0, conflicts };
      }

      if (prior && sourceInfo.contentHash === prior.contentHash) {
        // The local copy is unchanged from the last common state; the server
        // change can replace it without manufacturing a false conflict.
        await fsp.unlink(source);
        await removeLocalParents(source, f.localPath);
      } else {
        await preserveLocalConflict(f.localPath, sourceRel, sourceInfo.contentHash);
        conflicts++;
      }
    }

    const destination = await safeLocalPath(f.localPath, change.rel, true);
    const destinationInfo = await localInfo(destination);
    if (destinationInfo?.contentHash === change.contentHash) {
      await snapshotFromPath(f, change);
      return { downloaded: 0, conflicts };
    }
    if (destinationInfo) {
      await preserveLocalConflict(f.localPath, change.rel, destinationInfo.contentHash);
      conflicts++;
    }
    await downloadOne(baseFor(f), f.localPath, change);
    await snapshotFromPath(f, change);
    return { downloaded: 1, conflicts };
  }

  async function applyServerDelete(f, change) {
    const snapshot = snapshotFor(f);
    const prior = snapshot[change.stableId];
    if (!prior) return { conflicts: 0 };
    const filename = await safeLocalPath(f.localPath, prior.rel, false);
    const info = await localInfo(filename);
    let conflicts = 0;
    if (info) {
      if (info.contentHash === prior.contentHash) {
        await fsp.unlink(filename);
        await removeLocalParents(filename, f.localPath);
      } else {
        await preserveLocalConflict(f.localPath, prior.rel, info.contentHash);
        conflicts++;
      }
    }
    delete snapshot[change.stableId];
    return { conflicts };
  }

  async function acknowledgeFabricCursor(f, cursor) {
    if (!capability.journalAck) return { ok: true, cursor };
    return fetchJson('/api/sync/ack', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ base: baseFor(f), deviceId: state.deviceId, cursor }),
    });
  }

  async function commitFabricCursor(f, cursor, markInitialized = false) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('invalid_sync_cursor');
    return persistThenAck(
      cursor,
      value => {
        f.cursor = value;
        if (markInitialized) f.fabric = 2;
      },
      saveOrThrow,
      value => acknowledgeFabricCursor(f, value),
    );
  }

  async function initializeFabric(f) {
    const data = await fetchJson(manifestPath(baseFor(f), state.deviceId), { headers: authHeaders(false) });
    let downloaded = 0;
    let conflicts = 0;
    const entries = data.entries || [];
    const staleStableIds = missingManifestStableIds(snapshotFor(f), entries);
    const pending = staleStableIds.length + entries.length;
    setStatus(f.id, { state: pending ? 'downloading' : 'scanning', pending });
    let completed = 0;

    // A manifest is authoritative. Apply absent stable IDs as tombstones before
    // downloading replacements, which avoids treating a server replacement at
    // the same path as an unrelated local edit.
    for (const stableId of staleStableIds) {
      const prior = snapshotFor(f)[stableId];
      const result = await applyServerDelete(f, { stableId, rel: prior.rel, kind: 'delete' });
      conflicts += result.conflicts;
      completed++;
      saveOrThrow();
      setStatus(f.id, { downloaded, conflicts, pending: pending - completed });
    }
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const result = await applyServerEntry(f, { ...entry, kind: 'upsert', previousRel: null });
      downloaded += result.downloaded;
      conflicts += result.conflicts;
      completed++;
      saveOrThrow();
      setStatus(f.id, { downloaded, conflicts, pending: pending - completed });
    }
    await commitFabricCursor(f, Number(data.cursor || 0), true);
    return { downloaded, conflicts };
  }

  async function pullFabricChanges(f) {
    if (f.fabric !== 2) return initializeFabric(f);
    let downloaded = 0;
    let conflicts = 0;
    let more = true;
    while (more) {
      const data = await fetchJson(changesPath(baseFor(f), Number(f.cursor || 0), state.deviceId), { headers: authHeaders(false) });
      if (data.fullManifestRequired) return initializeFabric(f);
      const page = validatedChangePage(data, Number(f.cursor || 0));
      const items = page.items;
      setStatus(f.id, { state: items.length ? 'downloading' : 'scanning', pending: items.length });
      for (let index = 0; index < items.length; index++) {
        const change = items[index];
        if (change.kind === 'delete') {
          const result = await applyServerDelete(f, change);
          conflicts += result.conflicts;
        } else {
          const result = await applyServerEntry(f, change);
          downloaded += result.downloaded;
          conflicts += result.conflicts;
        }
        f.cursor = Number(change.cursor);
        saveOrThrow();
        setStatus(f.id, { downloaded, conflicts, pending: items.length - index - 1 });
      }
      more = page.hasMore;
      await commitFabricCursor(f, page.nextCursor);
    }
    return { downloaded, conflicts };
  }

  async function enrichLocal(files, snapshot) {
    const cachedByRel = new Map(Object.values(snapshot).map(entry => [entry.rel, entry]));
    await eachLimit(files, 2, async item => {
      const cached = cachedByRel.get(item.rel);
      item.contentHash = cached && cached.size === item.size && Math.abs(cached.mtimeMs - item.mtimeMs) < 1
        ? cached.contentHash
        : item.tooLarge ? null : await contentHash(item.full);
    });
    return files;
  }

  async function renameRemote(base, prior, item) {
    return fetchJson('/api/sync/rename', {
      method: 'POST', headers: authHeaders(true), body: JSON.stringify({
        base, from: prior.rel, to: item.rel, stableId: prior.stableId,
        expectedHash: prior.contentHash, deviceId: state.deviceId,
      }),
    });
  }

  async function deleteRemote(base, prior) {
    return fetchJson('/api/sync/delete', {
      method: 'POST', headers: authHeaders(true), body: JSON.stringify({
        base, rel: prior.rel, stableId: prior.stableId,
        expectedHash: prior.contentHash, deviceId: state.deviceId,
      }),
    });
  }

  async function applyUploadResult(f, item, result, prior) {
    const snapshot = snapshotFor(f);
    if (!result.conflict) {
      if (prior && prior.stableId !== result.entry.stableId) delete snapshot[prior.stableId];
      await snapshotFromPath(f, result.entry);
      return 0;
    }

    const movedRel = result.conflictRel;
    const movedFull = await safeLocalPath(f.localPath, movedRel, true);
    if (item.rel !== movedRel) {
      const existing = await localInfo(movedFull);
      if (!existing) {
        await safeLocalPath(f.localPath, movedRel, true);
        await fsp.rename(item.full, movedFull);
        await removeLocalParents(item.full, f.localPath);
      } else if (existing.contentHash === item.contentHash) {
        await fsp.unlink(item.full).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      } else {
        throw new Error('local_conflict_name_collision');
      }
    }
    await snapshotFromPath(f, result.entry, movedRel);

    if (prior) delete snapshot[prior.stableId];
    if (result.current) {
      await downloadOne(baseFor(f), f.localPath, result.current);
      await snapshotFromPath(f, result.current);
    }
    return 1;
  }

  async function pushFabricChanges(f) {
    const base = baseFor(f);
    const snapshot = snapshotFor(f);
    const scanned = await enrichLocal(await walk(f.localPath), snapshot);
    const localByRel = new Map(scanned.map(item => [item.rel, item]));
    const previous = Object.values(snapshot);
    const previousByRel = new Map(previous.map(entry => [entry.rel, entry]));
    const removed = previous.filter(entry => !localByRel.has(entry.rel));
    const untracked = scanned.filter(item => !previousByRel.has(item.rel));
    const usedRemoved = new Set();
    const renames = [];

    for (const item of untracked.sort((a, b) => a.rel.localeCompare(b.rel))) {
      let prior = removed.find(entry => !usedRemoved.has(entry.stableId) && entry.fileId && entry.fileId === item.fileId);
      if (!prior && item.contentHash) prior = removed.find(entry => !usedRemoved.has(entry.stableId) && entry.contentHash === item.contentHash && entry.size === item.size);
      if (prior) {
        usedRemoved.add(prior.stableId);
        renames.push({ prior, item });
      }
    }

    let uploaded = 0;
    let conflicts = 0;
    const pendingOperations = renames.length
      + scanned.filter(item => item.contentHash && previousByRel.get(item.rel) && item.contentHash !== previousByRel.get(item.rel).contentHash).length
      + (scanned.scanComplete === false ? 0 : removed.length - renames.length)
      + untracked.filter(item => item.contentHash && !renames.some(pair => pair.item.rel === item.rel)).length;
    setStatus(f.id, { state: pendingOperations ? 'uploading' : 'scanning', pending: pendingOperations });
    let completedOperations = 0;
    for (const { prior, item } of renames) {
      const renamed = await renameRemote(base, prior, item);
      snapshot[prior.stableId] = {
        ...prior, rel: item.rel, size: item.size, mtimeMs: item.mtimeMs,
        fileId: item.fileId, contentHash: prior.contentHash,
      };
      if (item.contentHash && item.contentHash !== prior.contentHash) {
        const result = await uploadOne(base, item, { stableId: prior.stableId, expectedHash: prior.contentHash });
        conflicts += await applyUploadResult(f, item, result, snapshot[prior.stableId]);
        uploaded++;
      } else if (renamed.entry) {
        await snapshotFromPath(f, renamed.entry);
      }
      saveOrThrow();
      completedOperations++;
      setStatus(f.id, { uploaded, conflicts, pending: Math.max(0, pendingOperations - completedOperations) });
    }

    for (const item of scanned) {
      const prior = previousByRel.get(item.rel);
      if (!prior || !item.contentHash || usedRemoved.has(prior.stableId) || item.contentHash === prior.contentHash) continue;
      const result = await uploadOne(base, item, { stableId: prior.stableId, expectedHash: prior.contentHash });
      conflicts += await applyUploadResult(f, item, result, prior);
      uploaded++;
      saveOrThrow();
      completedOperations++;
      setStatus(f.id, { uploaded, conflicts, pending: Math.max(0, pendingOperations - completedOperations) });
    }

    if (scanned.scanComplete !== false) {
      for (const prior of removed) {
        if (usedRemoved.has(prior.stableId)) continue;
        await deleteRemote(base, prior);
        delete snapshot[prior.stableId];
        saveOrThrow();
        completedOperations++;
        setStatus(f.id, { uploaded, conflicts, pending: Math.max(0, pendingOperations - completedOperations) });
      }
    }

    const renamedRels = new Set(renames.map(pair => pair.item.rel));
    for (const item of untracked) {
      if (renamedRels.has(item.rel) || !item.contentHash) continue;
      const result = await uploadOne(base, item, { expectedHash: 'missing' });
      conflicts += await applyUploadResult(f, item, result, null);
      uploaded++;
      saveOrThrow();
      completedOperations++;
      setStatus(f.id, { uploaded, conflicts, pending: Math.max(0, pendingOperations - completedOperations) });
    }

    // Refresh cached metadata for unchanged local files without changing the
    // stable ID or common content hash.
    for (const item of scanned) {
      const prior = previousByRel.get(item.rel);
      if (prior && item.contentHash === prior.contentHash && snapshot[prior.stableId]) {
        Object.assign(snapshot[prior.stableId], {
          size: item.size, mtimeMs: item.mtimeMs, fileId: item.fileId,
        });
      }
    }
    saveOrThrow();
    return { uploaded, conflicts };
  }

  async function syncFolderFabric(f) {
    if (!f || !f.enabled || !state.token || running.has(f.id)) return;
    running.add(f.id);
    try {
      const currentBase = baseFor(f);
      if (f.fabricBase !== currentBase) {
        // Per-base cursors are never transferable, even when a folder label is
        // edited locally while remaining on the same server.
        f.cursor = 0;
        f.snapshot = {};
        f.fabric = 0;
        f.fabricBase = currentBase;
        saveOrThrow();
      }
      setStatus(f.id, { state: 'scanning', pending: 0, uploaded: 0, downloaded: 0, conflicts: 0, lastError: '' });
      const pulled = await pullFabricChanges(f);
      setStatus(f.id, { state: 'uploading', downloaded: pulled.downloaded, conflicts: pulled.conflicts });
      const pushed = await pushFabricChanges(f);
      const now = new Date().toISOString();
      f.lastSync = now;
      f.lastError = '';
      save();
      setStatus(f.id, {
        state: 'idle', pending: 0, uploaded: pushed.uploaded, downloaded: pulled.downloaded,
        conflicts: pulled.conflicts + pushed.conflicts, lastSync: now, lastError: '',
      });
    } catch (error) {
      const message = error?.message || 'sync_failed';
      f.lastError = message;
      save();
      setStatus(f.id, { state: 'error', pending: 0, lastError: message });
    } finally {
      running.delete(f.id);
    }
  }

  let capability = { url: '', checkedAt: 0, fabric: false, journalAck: false };
  async function supportsFabric() {
    const url = cleanUrl(state.serverUrl);
    if (capability.url === url && Date.now() - capability.checkedAt < 60_000) return capability.fabric;
    try {
      const data = await fetchJson('/api/sync/capabilities', { headers: authHeaders(false) });
      const features = new Set(Array.isArray(data.features) ? data.features : []);
      capability = {
        url,
        checkedAt: Date.now(),
        fabric: Number(data.protocol) >= 2,
        journalAck: features.has('journal_ack'),
      };
    } catch {
      capability = { url, checkedAt: Date.now(), fabric: false, journalAck: false };
    }
    return capability.fabric;
  }

  async function syncFolder(f) {
    if (f?.mode === 'two' && await supportsFabric()) return syncFolderFabric(f);
    return syncFolderLegacy(f);
  }

  async function syncFolderLegacy(f) {
    if (!f || !f.enabled || !state.token || running.has(f.id)) return;
    running.add(f.id);
    const base = baseFor(f);
    try {
      setStatus(f.id, { state: 'scanning', pending: 0, uploaded: 0, downloaded: 0, conflicts: 0, lastError: '' });
      const local = await walk(f.localPath);
      const byRel = new Map(local.map(x => [x.rel, x]));
      const { needed, conflicts } = await check(base, local);
      const uploads = [...needed].map(rel => byRel.get(rel)).filter(Boolean);
      setStatus(f.id, { state: uploads.length ? 'uploading' : 'idle', pending: uploads.length, conflicts: conflicts.size });
      let uploaded = 0;
      await eachLimit(uploads, 2, async it => {
        await uploadOne(base, it);
        uploaded++;
        setStatus(f.id, { uploaded, pending: uploads.length - uploaded });
      });

      let downloaded = 0;
      if (f.mode === 'two') {
        const listed = await fetchJson(`/api/sync/list?base=${encodeURIComponent(base)}`, { headers: authHeaders(false) });
        const downloads = [];
        for (const sf of listed.files || []) {
          const lf = byRel.get(sf.rel);
          if (!lf || sf.mtimeMs > lf.mtimeMs + TOLERANCE_MS) downloads.push(sf);
        }
        for (const rel of conflicts) {
          const sf = (listed.files || []).find(x => x.rel === rel);
          if (sf && !downloads.some(x => x.rel === rel)) downloads.push(sf);
        }
        setStatus(f.id, { state: downloads.length ? 'downloading' : 'idle', pending: downloads.length });
        for (const item of downloads) {
          await downloadOne(base, f.localPath, item);
          downloaded++;
          setStatus(f.id, { downloaded, pending: downloads.length - downloaded });
        }
      }
      const now = new Date().toISOString();
      f.lastSync = now;
      f.lastError = '';
      save();
      setStatus(f.id, { state: 'idle', pending: 0, uploaded, downloaded, conflicts: conflicts.size, lastSync: now, lastError: '' });
    } catch (e) {
      const msg = e && e.message ? e.message : 'sync_failed';
      f.lastError = msg;
      save();
      setStatus(f.id, { state: 'error', pending: 0, lastError: msg });
    } finally {
      running.delete(f.id);
    }
  }

  function scheduleFolder(f) {
    clearFolderWatch(f.id);
    if (!f.enabled) return;
    let deb;
    try {
      const w = fs.watch(f.localPath, { recursive: true }, () => {
        clearTimeout(deb);
        deb = setTimeout(() => syncFolder(f), 3000);
      });
      watchers.set(f.id, { w, deb });
    } catch { /* polling still covers this folder */ }
  }

  function clearFolderWatch(id) {
    const old = watchers.get(id);
    if (!old) return;
    try { old.w.close(); } catch { /* */ }
    clearTimeout(old.deb);
    watchers.delete(id);
  }

  function clearSchedules() {
    timers.forEach(t => clearInterval(t));
    timers = [];
    watchers.forEach((_v, id) => clearFolderWatch(id));
  }

  async function advertiseMesh() {
    if (!state.token || !state.serverUrl) return;
    try {
      const endpoints = await meshNode.start();
      await fetchJson('/api/device-fabric/presence', {
        method: 'POST', headers: authHeaders(true), body: JSON.stringify({
          name: 'Aerie Desktop',
          capabilities: ['sync', 'mesh.files.v2', 'continuity'],
          meshEndpoints: endpoints,
        }),
      });
    } catch { /* pairing/offline state is retried by the presence timer */ }
  }

  function restart() {
    clearSchedules();
    state.folders.forEach(scheduleFolder);
    timers.push(setInterval(() => syncAll(), SYNC_INTERVAL));
    timers.push(setInterval(() => probe(), OFFLINE_INTERVAL));
    timers.push(setInterval(() => advertiseMesh(), 60_000));
    setTimeout(() => syncAll(), 1000);
    advertiseMesh();
  }

  function stop() {
    clearSchedules();
    meshNode.stop().catch(() => {});
  }

  async function probe() {
    if (!state.token || !state.serverUrl) return;
    try {
      await fetchJson('/api/sync/bases', { headers: authHeaders(false) });
      await advertiseMesh();
    }
    catch { /* next probe */ }
  }

  function syncAll() { state.folders.filter(f => f.enabled).forEach(f => syncFolder(f)); }
  function list() {
    return state.folders.map(folder => {
      const { snapshot: _snapshot, ...visible } = folder;
      return { ...visible };
    });
  }
  function allStatus() {
    return state.folders.map(f => ({ id: f.id, ...(status.get(f.id) || {}), lastSync: f.lastSync || null, lastError: f.lastError || '' }));
  }

  function dedupeLabel(label) {
    let out = safeLabel(label);
    const used = new Set(state.folders.map(f => f.label));
    let n = 2;
    while (used.has(out)) out = `${safeLabel(label)} (${n++})`;
    return out;
  }

  async function add() {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled) return list();
    for (const p of r.filePaths) {
      state.folders.push({ id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, label: dedupeLabel(path.basename(p)), localPath: p, mode: 'up', enabled: true, lastSync: null, lastError: '' });
    }
    save(); restart();
    return list();
  }

  async function addFromServer(base) {
    const label = safeLabel(String(base || '').replace(/^Sync\//, '') || 'Server folder');
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return list();
    state.folders.push({ id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, label, localPath: r.filePaths[0], mode: 'two', enabled: true, lastSync: null, lastError: '' });
    save(); restart();
    return list();
  }

  function remove(id) {
    state.folders = state.folders.filter(f => f.id !== id);
    clearFolderWatch(id);
    status.delete(id);
    save();
    return list();
  }

  function toggle(id, enabled) {
    const f = state.folders.find(x => x.id === id);
    if (f) { f.enabled = !!enabled; save(); restart(); }
    return list();
  }

  function tokenExpiry(token) {
    try {
      const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
      if (Number.isFinite(payload.exp)) return new Date(payload.exp * 1000).toISOString();
    } catch { /* opaque token */ }
    return new Date(Date.now() + 15 * 60_000).toISOString();
  }

  function setAuth(token, serverUrl, expiresAt) {
    state.token = token || '';
    if (serverUrl) {
      const nextUrl = cleanUrl(serverUrl);
      if (state.serverUrl && state.serverUrl !== nextUrl) {
        // Cursors and stable IDs are scoped to one server. Carrying them to a
        // different origin could turn an unrelated file into a deletion.
        for (const folder of state.folders) {
          folder.cursor = 0;
          folder.snapshot = {};
          folder.fabric = 0;
          folder.fabricBase = '';
        }
        capability = { url: '', checkedAt: 0, fabric: false, journalAck: false };
      }
      state.serverUrl = nextUrl;
    }
    if (credentialStore && state.serverUrl) {
      try {
        if (state.token) credentialStore.storeAccessToken(state.serverUrl, state.token, expiresAt || tokenExpiry(state.token));
        else credentialStore.clearAccessToken(state.serverUrl);
      } catch { /* memory-only auth remains available when safeStorage is unavailable */ }
    }
    save();
    if (state.token) restart();
    else stop();
    return true;
  }

  if (state.token) restart();
  return {
    list, add, addFromServer, remove, toggle, syncNow: syncAll, status: allStatus, setAuth,
    shutdown: async () => { clearSchedules(); await meshNode.stop(); },
  };
}

module.exports = {
  createSyncEngine,
  _networkForTests: {
    readJsonResponse, transferDeadlineMs, createDownloadMonitor, createMultipartUpload,
  },
};
