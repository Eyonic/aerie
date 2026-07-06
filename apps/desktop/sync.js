const { app, dialog } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const TOLERANCE_MS = 2000;
const MAX_FILE = 2 * 1024 * 1024 * 1024;
const CHECK_CHUNK = 5000;
const SYNC_INTERVAL = 15 * 60 * 1000;
const OFFLINE_INTERVAL = 60 * 1000;

function createSyncEngine() {
  const statePath = path.join(app.getPath('userData'), 'sync.json');
  let state = load();
  let timers = [];
  const watchers = new Map();
  const status = new Map();
  const running = new Set();

  function load() {
    try {
      const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return { folders: Array.isArray(s.folders) ? s.folders : [], token: s.token || '', serverUrl: s.serverUrl || '' };
    } catch {
      return { folders: [], token: '', serverUrl: '' };
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch { /* best effort */ }
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

  async function fetchJson(pathname, opts = {}) {
    const res = await fetch(api(pathname), opts);
    if (!res.ok) throw new Error(res.status === 401 ? 'unauthorized' : `http_${res.status}`);
    return res.json();
  }

  async function walk(root) {
    const out = [];
    async function step(dir, prefix) {
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        const rel = prefix ? path.posix.join(prefix, ent.name) : ent.name;
        let st;
        try { st = await fsp.lstat(full); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) await step(full, rel);
        else if (st.isFile() && st.size <= MAX_FILE) out.push({ rel, size: st.size, mtimeMs: st.mtimeMs, full });
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

  async function uploadOne(base, item) {
    // openAsBlob streams from disk; a 2GB video must not become a 2GB Buffer.
    const blob = fs.openAsBlob ? await fs.openAsBlob(item.full) : new Blob([await fsp.readFile(item.full)]);
    const form = new FormData();
    form.append('base', base);
    form.append('rel', item.rel);
    form.append('mtimeMs', String(item.mtimeMs));
    form.append('file', blob, path.basename(item.rel));
    const res = await fetch(api('/api/sync/upload'), { method: 'POST', headers: authHeaders(false), body: form });
    if (!res.ok) throw new Error(`upload_${res.status}`);
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

  async function downloadOne(base, localPath, item) {
    const res = await fetch(api(`/api/sync/file?base=${encodeURIComponent(base)}&rel=${encodeURIComponent(item.rel)}`), { headers: authHeaders(false) });
    if (!res.ok) throw new Error(`download_${res.status}`);
    const dest = path.join(localPath, ...item.rel.split('/'));
    const tmp = dest + `.aerie-${Date.now()}.tmp`;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const ab = await res.arrayBuffer();
    await fsp.writeFile(tmp, Buffer.from(ab));
    await fsp.rename(tmp, dest);
    const mt = Number(res.headers.get('x-mtime-ms')) || item.mtimeMs;
    if (Number.isFinite(mt)) {
      const d = new Date(mt);
      await fsp.utimes(dest, d, d).catch(() => {});
    }
  }

  function setStatus(id, patch) {
    const cur = status.get(id) || { state: 'idle', pending: 0, uploaded: 0, downloaded: 0, conflicts: 0, lastSync: null, lastError: '' };
    status.set(id, { ...cur, ...patch });
  }

  async function syncFolder(f) {
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

  function restart() {
    stop();
    state.folders.forEach(scheduleFolder);
    timers.push(setInterval(() => syncAll(), SYNC_INTERVAL));
    timers.push(setInterval(() => probe(), OFFLINE_INTERVAL));
    setTimeout(() => syncAll(), 1000);
  }

  function stop() {
    timers.forEach(t => clearInterval(t));
    timers = [];
    watchers.forEach((_v, id) => clearFolderWatch(id));
  }

  async function probe() {
    if (!state.token || !state.serverUrl) return;
    try { await fetchJson('/api/sync/bases', { headers: authHeaders(false) }); }
    catch { /* next probe */ }
  }

  function syncAll() { state.folders.filter(f => f.enabled).forEach(f => syncFolder(f)); }
  function list() { return state.folders.map(f => ({ ...f })); }
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

  function setAuth(token, serverUrl) {
    state.token = token || '';
    if (serverUrl) state.serverUrl = cleanUrl(serverUrl);
    save();
    if (state.token) restart();
    else stop();
    return true;
  }

  if (state.token) restart();
  return { list, add, addFromServer, remove, toggle, syncNow: syncAll, status: allStatus, setAuth };
}

module.exports = { createSyncEngine };
