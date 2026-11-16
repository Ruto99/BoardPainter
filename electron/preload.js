// Exposes a narrow native API to the page as window.bp
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bp', {
  isDesktop: true,
  platform: process.platform,
  openModel: () => ipcRenderer.invoke('bp:open-model'),
  takePendingOpen: () => ipcRenderer.invoke('bp:take-pending-open'),
  saveFile: (name, data) => ipcRenderer.invoke('bp:save-file', { name, data }),
  saveMany: files => ipcRenderer.invoke('bp:save-many', files),
  saveProject: (filePath, name, data, saveAs) => ipcRenderer.invoke('bp:save-project', { filePath, name, data, saveAs }),
  confirmClose: name => ipcRenderer.invoke('bp:confirm-close', name),
  reveal: p => ipcRenderer.invoke('bp:reveal', p),
  onOpenModel: cb => ipcRenderer.on('bp:open-model', (_e, m) => m && cb(m)),
  // cb resolves to false to keep the window open
  onBeforeClose: cb => ipcRenderer.on('bp:before-close', async () => {
    ipcRenderer.send('bp:close-ack');
    let ok = true;
    try { ok = (await cb()) !== false; } catch (err) { console.error(err); }
    ipcRenderer.send(ok ? 'bp:close-ready' : 'bp:close-cancel');
  }),
});
