// Aerie Desktop — a native shell around the Aerie web app.
// Loads the user's server URL in a real window with tray, deep-links open in
// the default browser, and the server URL is configurable on first run.
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Optional baked-in server default. Self-hosters can ship a build that points
// at their own server by writing {"url":"https://…"} to default-server.json
// before packaging (see apps/build-desktop.sh). Absent/invalid file => ''.
function loadDefaultUrl() {
  try {
    const u = JSON.parse(fs.readFileSync(path.join(__dirname, 'default-server.json'), 'utf8')).url;
    return typeof u === 'string' ? u : '';
  } catch { return ''; }
}
const DEFAULT_URL = loadDefaultUrl();
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return {}; }
}
function saveConfig(c) {
  try { fs.writeFileSync(cfgPath(), JSON.stringify(c)); } catch { /* */ }
}

let win = null;
let tray = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 600,
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'Aerie',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });

  const cfg = loadConfig();
  if (cfg.url) win.loadURL(cfg.url);
  else win.loadFile(path.join(__dirname, 'config.html'));

  // Grant media (microphone) permission requests so in-app voice/dictation works.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'audioCapture' || permission === 'mediaKeySystem' || permission === 'clipboard-read' || permission === 'fullscreen');
  });
  try { win.webContents.session.setPermissionCheckHandler((_wc, permission) => ['media', 'audioCapture'].includes(permission)); } catch { /* older electron */ }

  // External links (target=_blank / different origin) open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

function showConfig() {
  if (win) win.loadFile(path.join(__dirname, 'config.html'));
}

function connectTo(url) {
  let u = (url || '').trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  saveConfig({ url: u });
  if (win) win.loadURL(u);
}

ipcMain.handle('cloudbox:setUrl', (_e, url) => { connectTo(url); return true; });
ipcMain.handle('cloudbox:getUrl', () => loadConfig().url || DEFAULT_URL || '');

function buildMenu() {
  const template = [
    { label: 'Aerie', submenu: [
      { label: 'Home', click: () => { const c = loadConfig(); if (win && c.url) win.loadURL(c.url); } },
      { label: 'Change Server…', click: showConfig },
      { type: 'separator' },
      { label: 'Reload', role: 'reload' },
      { label: 'Toggle Full Screen', role: 'togglefullscreen' },
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
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { createWindow(); buildMenu(); buildTray(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
