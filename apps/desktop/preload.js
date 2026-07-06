const { contextBridge, ipcRenderer } = require('electron');

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
  setAuth: (token) => ipcRenderer.invoke('sync:setAuth', token),
});
