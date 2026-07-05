const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cloudbox', {
  setUrl: (url) => ipcRenderer.invoke('cloudbox:setUrl', url),
  getUrl: () => ipcRenderer.invoke('cloudbox:getUrl'),
});
