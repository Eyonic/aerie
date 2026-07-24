const { contextBridge, ipcRenderer } = require('electron');

// Every top-level navigation creates a new isolated preload context. The web
// app calls setAuth('') once during boot, before it has had a chance to renew a
// paired-device session. Treat only that first empty value as a restore probe;
// a later empty value in the same page is an explicit logout/revocation.
let syncAuthInitialized = false;

contextBridge.exposeInMainWorld('cloudbox', {
  setUrl: (url) => ipcRenderer.invoke('cloudbox:setUrl', url),
  getUrl: () => ipcRenderer.invoke('cloudbox:getUrl'),
});

contextBridge.exposeInMainWorld('aerieSync', {
  list: () => ipcRenderer.invoke('sync:list'),
  add: () => ipcRenderer.invoke('sync:add'),
  addFromServer: (base) => ipcRenderer.invoke('sync:addFromServer', base),
  remove: (id) => ipcRenderer.invoke('sync:remove', id),
  toggle: (id, enabled) => ipcRenderer.invoke('sync:toggle', id, enabled),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  status: () => ipcRenderer.invoke('sync:status'),
  setAuth: (token) => {
    const restore = !syncAuthInitialized && !token;
    syncAuthInitialized = true;
    return ipcRenderer.invoke('sync:setAuth', token, restore ? 'restore' : 'set');
  },
});

// Hardware/OS-backed identity used by the device pairing protocol. The main
// process derives the server origin from the IPC sender; renderer code cannot
// ask the key to sign for another server.
contextBridge.exposeInMainWorld('aerieNativeDevice', {
  security: () => ipcRenderer.invoke('nativeDevice:security'),
  identity: () => ipcRenderer.invoke('nativeDevice:identity'),
  sign: (payload) => ipcRenderer.invoke('nativeDevice:sign', payload),
  register: (deviceId) => ipcRenderer.invoke('nativeDevice:register', deviceId),
  storeToken: (token, expiresAt) => ipcRenderer.invoke('nativeDevice:storeToken', token, expiresAt),
  loadToken: () => ipcRenderer.invoke('nativeDevice:loadToken'),
  clearToken: () => ipcRenderer.invoke('nativeDevice:clearToken'),
  pair: (code, name) => ipcRenderer.invoke('nativeDevice:pair', code, name),
  authenticate: () => ipcRenderer.invoke('nativeDevice:authenticate'),
});

// The renderer can ask the trusted main process to check or roll back, but it
// cannot supply an origin, URL, file path, checksum, or installer command. Both
// mutating actions always pass through a native confirmation dialog.
contextBridge.exposeInMainWorld('aerieDesktopUpdater', {
  status: () => ipcRenderer.invoke('desktopUpdater:status'),
  check: () => ipcRenderer.invoke('desktopUpdater:check'),
  rollback: () => ipcRenderer.invoke('desktopUpdater:rollback'),
  onProgress: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, progress) => listener(progress);
    ipcRenderer.on('desktopUpdater:progress', wrapped);
    return () => ipcRenderer.removeListener('desktopUpdater:progress', wrapped);
  },
});
