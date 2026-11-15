// Exposes a narrow native API to the page as window.bp
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bp', {
  isDesktop: true,
  platform: process.platform,
  openModel: () => ipcRenderer.invoke('bp:open-model'),
  takePendingOpen: () => ipcRenderer.invoke('bp:take-pending-open'),
  saveFile: (name, data) => ipcRenderer.invoke('bp:save-file', { name, data }),
  saveMany: files => ipcRenderer.invoke('bp:save-many', files),
  reveal: p => ipcRenderer.invoke('bp:reveal', p),
  onOpenModel: cb => ipcRenderer.on('bp:open-model', (_e, m) => m && cb(m)),
  onBeforeClose: cb => ipcRenderer.on('bp:before-close', async () => {
    try { await cb(); } finally { ipcRenderer.send('bp:close-ready'); }
  }),
});
