// Aerie Desktop — a native shell around the Aerie web app.
// Loads the user's server URL in a real window with tray, deep-links open in
// the default browser, and the server URL is configurable on first run.
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { createSyncEngine } = require('./sync');
const { createNativeCredentialStore } = require('./secure-credentials');
const { normalizeOrigin, normalizeServerUrl } = require('./server-url');
const { readBoundedJson } = require('./bounded-json');
const { createDesktopUpdater } = require('./desktop-updater');
const { aerieBuild: DESKTOP_BUILD } = require('./package.json');

// Optional baked-in server default. Self-hosters can ship a build that points
// at their own server by writing {"url":"https://…"} to default-server.json
// before packaging (see apps/build-desktop.sh). Absent/invalid file => ''.
function loadDefaultUrl() {
  try {
    const u = JSON.parse(fs.readFileSync(path.join(__dirname, 'default-server.json'), 'utf8')).url;
    return typeof u === 'string' && u.trim() ? normalizeServerUrl(u) : '';
  } catch { return ''; }
}
const DEFAULT_URL = loadDefaultUrl();
const CONFIG_URL = `data:text/html;charset=utf-8;base64,${fs.readFileSync(path.join(__dirname, 'config.html')).toString('base64')}#${crypto.randomBytes(16).toString('hex')}`;
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');

function isConfigPage(url) {
  return typeof url === 'string' && url === CONFIG_URL;
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed.url ? { ...parsed, url: normalizeServerUrl(parsed.url) } : parsed;
  } catch { return {}; }
}
function saveConfig(c) {
  try { fs.writeFileSync(cfgPath(), JSON.stringify(c)); } catch { /* */ }
}

let win = null;
let tray = null;
let syncEngine = null;
let nativeCredentials = null;
let desktopUpdater = null;
let pendingDeepLink = process.argv.find(arg => typeof arg === 'string' && arg.startsWith('aerie://')) || null;

function pairingLink(argv) {
  return (argv || []).find(arg => typeof arg === 'string' && arg.startsWith('aerie://')) || null;
}

async function openPairingLink(raw) {
  try {
    const link = new URL(raw);
    if (link.protocol !== 'aerie:' || link.hostname !== 'pair') return false;
    const code = String(link.searchParams.get('code') || '').toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/.test(code)) return false;
    const server = normalizeOrigin(link.searchParams.get('server') || '');
    if (!server) return false;
    const configured = loadConfig().url || DEFAULT_URL || '';
    if (configured && normalizeOrigin(configured) !== server) {
      if (win) await dialog.showMessageBox(win, {
        type: 'warning', title: 'Different Aerie server',
        message: 'For your safety, change servers before pairing with a different Aerie installation.',
      });
      return false;
    }
    if (!configured) {
      // Registering a custom protocol lets any website launch Aerie. Never let
      // that first deep link silently choose the origin that receives native
      // sync and device-key privileges, even if it mimics the health response.
      if (!win) createWindow();
      const confirmation = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Connect to this Aerie server?',
        message: server,
        detail: 'Continue only if this is your Aerie server and you intended to pair this computer.',
        buttons: ['Connect and pair', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0) return false;
    }
    const response = await fetch(`${server}/api/health`, {
      redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    const health = response.ok ? await readBoundedJson(response, { maxBytes: 4096, idleMs: 3000 }) : null;
    if (!health || (health.name !== 'Aerie' && health.name !== 'CloudBox' && health.compat !== 'CloudBox')) {
      throw new Error('not_aerie_server');
    }
    if (!configured) saveConfig({ url: server });
    if (!win) createWindow();
    await win.loadURL(`${server}/pair?code=${encodeURIComponent(code)}`);
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    return true;
  } catch {
    if (win) dialog.showMessageBox(win, { type: 'error', title: 'Pairing link unavailable',
      message: 'This link did not point to a reachable Aerie server.' });
    return false;
  }
}

function trustedNativeIpc(event) {
  try {
    const configured = loadConfig().url || DEFAULT_URL || '';
    const sender = event.senderFrame?.url || event.sender?.getURL() || '';
    return !!configured && normalizeOrigin(sender) === normalizeOrigin(configured);
  } catch { return false; }
}

function nativeOrigin(event) {
  if (!trustedNativeIpc(event)) throw new Error('untrusted_native_ipc_origin');
  return normalizeOrigin(event.senderFrame?.url || event.sender?.getURL());
}

function isLocalConfigIpc(event) {
  return isConfigPage(event.senderFrame?.url || event.sender?.getURL() || '');
}

function safeExternal(url) {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol); }
  catch { return false; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 600,
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'Aerie',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  const cfg = loadConfig();
  if (cfg.url) win.loadURL(cfg.url);
  else win.loadURL(CONFIG_URL);

  // Grant media (microphone) permission requests so in-app voice/dictation works.
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    let trusted = false;
    try {
      const configured = loadConfig().url || DEFAULT_URL || '';
      trusted = !!configured && normalizeOrigin(wc.getURL()) === normalizeOrigin(configured);
    } catch { /* deny below */ }
    cb(trusted && ['media', 'audioCapture', 'mediaKeySystem', 'fullscreen'].includes(permission));
  });
  try {
    win.webContents.session.setPermissionCheckHandler((wc, permission) => {
      try {
        const configured = loadConfig().url || DEFAULT_URL || '';
        return !!configured && normalizeOrigin(wc.getURL()) === normalizeOrigin(configured)
          && ['media', 'audioCapture'].includes(permission);
      } catch { return false; }
    });
  } catch { /* older electron */ }

  // External links (target=_blank / different origin) open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (safeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      const configured = loadConfig().url || DEFAULT_URL || '';
      allowed = (!!configured && normalizeOrigin(url) === normalizeOrigin(configured))
        || isConfigPage(url);
    } catch { /* block below */ }
    if (!allowed) {
      event.preventDefault();
      if (safeExternal(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => { win = null; });
}

function showConfig() {
  if (win) win.loadURL(CONFIG_URL);
}

function connectTo(url) {
  let u = (url || '').trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = normalizeServerUrl(u);
  const previous = loadConfig().url || DEFAULT_URL || '';
  saveConfig({ url: u });
  let sameOrigin = false;
  try { sameOrigin = !!previous && normalizeOrigin(previous) === normalizeOrigin(u); } catch { /* clear below */ }
  if (previous && !sameOrigin) syncEngine?.setAuth?.('', u);
  if (win) win.loadURL(u);
}

ipcMain.handle('cloudbox:setUrl', (e, url) => {
  if (!isLocalConfigIpc(e)) throw new Error('untrusted_config_ipc_origin');
  connectTo(url); return true;
});
ipcMain.handle('cloudbox:getUrl', e => {
  if (!isLocalConfigIpc(e)) throw new Error('untrusted_config_ipc_origin');
  return loadConfig().url || DEFAULT_URL || '';
});
ipcMain.handle('sync:list', e => { nativeOrigin(e); return syncEngine.list(); });
ipcMain.handle('sync:add', e => { nativeOrigin(e); return syncEngine.add(); });
ipcMain.handle('sync:addFromServer', (e, base) => { nativeOrigin(e); return syncEngine.addFromServer(base); });
ipcMain.handle('sync:remove', (e, id) => { nativeOrigin(e); return syncEngine.remove(id); });
ipcMain.handle('sync:toggle', (e, id, enabled) => { nativeOrigin(e); return syncEngine.toggle(id, enabled); });
ipcMain.handle('sync:now', e => { nativeOrigin(e); syncEngine.syncNow(); return true; });
ipcMain.handle('sync:status', e => { nativeOrigin(e); return syncEngine.status(); });
ipcMain.handle('sync:setAuth', (e, token, intent) => {
  const origin = nativeOrigin(e);
  const serverUrl = loadConfig().url || DEFAULT_URL || '';
  if (!token && intent === 'restore') {
    // The renderer has not restored its short-lived native session yet. Keep a
    // still-valid OS-encrypted credential alive; importantly, do not mark the
    // device identity as suspended when the stored session merely expired.
    const stored = nativeCredentials.loadAccessToken(origin);
    if (stored?.token) syncEngine.setAuth(stored.token, serverUrl, stored.expiresAt);
    return !!stored?.token;
  }
  return syncEngine.setAuth(token, serverUrl);
});
ipcMain.handle('nativeDevice:security', (e) => {
  nativeOrigin(e); return nativeCredentials.securityInfo();
});
ipcMain.handle('nativeDevice:identity', (e) => nativeCredentials.getOrCreateIdentity(nativeOrigin(e)));
ipcMain.handle('nativeDevice:sign', (e, payload) => nativeCredentials.sign(nativeOrigin(e), payload));
ipcMain.handle('nativeDevice:register', (e, deviceId) => nativeCredentials.registerDevice(nativeOrigin(e), deviceId));
ipcMain.handle('nativeDevice:storeToken', (e, token, expiresAt) =>
  nativeCredentials.storeAccessToken(nativeOrigin(e), token, expiresAt));
ipcMain.handle('nativeDevice:loadToken', (e) => nativeCredentials.loadAccessToken(nativeOrigin(e)));
ipcMain.handle('nativeDevice:clearToken', (e) => nativeCredentials.clearAccessToken(nativeOrigin(e)));
ipcMain.handle('nativeDevice:pair', async (e, code, name) => {
  const origin = nativeOrigin(e);
  const result = await nativeCredentials.pairWithCode(origin, code, { name });
  syncEngine.setAuth(result.token, origin, result.expiresAt);
  return result;
});
ipcMain.handle('nativeDevice:authenticate', async (e) => {
  const origin = nativeOrigin(e);
  const result = await nativeCredentials.authenticate(origin);
  syncEngine.setAuth(result.token, origin, result.expiresAt);
  return result;
});
ipcMain.handle('desktopUpdater:status', (e) => {
  nativeOrigin(e); return desktopUpdater?.status?.() || null;
});
ipcMain.handle('desktopUpdater:check', (e) => {
  nativeOrigin(e); return desktopUpdater?.checkAndPrompt?.(true) || { status: 'unavailable' };
});
ipcMain.handle('desktopUpdater:rollback', (e) => {
  nativeOrigin(e); return desktopUpdater?.rollbackAndPrompt?.() || { status: 'unavailable' };
});

function updateProgress(progress) {
  if (!win || win.isDestroyed()) return;
  const received = Number(progress?.receivedBytes) || 0;
  const total = Number(progress?.totalBytes) || 0;
  win.setProgressBar(total > 0 ? Math.max(0, Math.min(1, received / total)) : -1);
  try {
    const configured = loadConfig().url || DEFAULT_URL || '';
    if (configured && normalizeOrigin(win.webContents.getURL()) === normalizeOrigin(configured)) {
      win.webContents.send('desktopUpdater:progress', {
        receivedBytes: received,
        totalBytes: total,
        complete: Boolean(progress?.complete),
      });
    }
  } catch { /* progress is only sent into the configured server origin */ }
}

function buildMenu() {
  const template = [
    { label: 'Aerie', submenu: [
      { label: 'Home', click: () => { const c = loadConfig(); if (win && c.url) win.loadURL(c.url); } },
      { label: 'Change Server…', click: showConfig },
      { type: 'separator' },
      { label: 'Reload', role: 'reload' },
      { label: 'Toggle Full Screen', role: 'togglefullscreen' },
      { type: 'separator' },
      { label: 'Check for Updates…', click: () => desktopUpdater?.checkAndPrompt?.(true) },
      ...(process.platform === 'linux' ? [
        { label: 'Roll Back Previous Version…', click: () => desktopUpdater?.rollbackAndPrompt?.() },
      ] : []),
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]},
    { label: 'Edit', role: 'editMenu' },
    { label: 'View', submenu: [ { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'toggleDevTools' } ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTray() {
  try {
    tray = new Tray(path.join(__dirname, 'build', 'icon.png'));
    tray.setToolTip('Aerie');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Aerie', click: () => { if (!win) createWindow(); else win.show(); } },
      { label: 'Check for Updates…', click: () => desktopUpdater?.checkAndPrompt?.(true) },
      { label: 'Change Server…', click: () => { if (!win) createWindow(); showConfig(); } },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]));
    tray.on('click', () => { if (!win) createWindow(); else win.show(); });
  } catch { /* tray optional */ }
}

const single = app.requestSingleInstanceLock();
if (!single) { app.quit(); }
else {
  try { app.setAsDefaultProtocolClient('aerie'); } catch { /* OS registration is best effort in dev builds */ }
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (app.isReady()) openPairingLink(url); else pendingDeepLink = url;
  });
  app.on('second-instance', (_event, argv) => {
    const link = pairingLink(argv);
    if (link) openPairingLink(link);
    else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(async () => {
    nativeCredentials = createNativeCredentialStore();
    const serverUrl = loadConfig().url || DEFAULT_URL || '';
    if (serverUrl) {
      nativeCredentials.migrateLegacyToken(serverUrl, path.join(app.getPath('userData'), 'sync.json'));
    }
    syncEngine = createSyncEngine({ credentialStore: nativeCredentials });
    try {
      desktopUpdater = createDesktopUpdater({
        app, dialog, shell,
        getWindow: () => win,
        getServerUrl: () => loadConfig().url || DEFAULT_URL || '',
        currentBuild: DESKTOP_BUILD,
        pinnedKeyPath: path.join(__dirname, 'release-key.json'),
        onProgress: updateProgress,
        beforeInstall: async () => { await syncEngine?.shutdown?.(); },
      });
      await desktopUpdater.initialize();
    } catch (error) {
      console.error('Desktop updater unavailable:', error?.message || error);
      desktopUpdater = null;
    }
    createWindow(); buildMenu(); buildTray();
    desktopUpdater?.schedule?.();
    if (pendingDeepLink) { const link = pendingDeepLink; pendingDeepLink = null; openPairingLink(link); }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('before-quit', () => {
    desktopUpdater?.shutdown?.();
    syncEngine?.shutdown?.().catch(() => {});
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
