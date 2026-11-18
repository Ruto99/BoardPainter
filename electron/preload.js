// Exposes a narrow native API to the page as window.bp
const { contextBridge, ipcRenderer } = require('electron');

function nativeCall(op, args) {
  const r = ipcRenderer.sendSync('bp:native', op, args);
  if (!r || r.error) throw new Error(r ? r.error : 'native call failed');
  return r.result;
}

contextBridge.exposeInMainWorld('bp', {
  isDesktop: true,
  platform: process.platform,
  // installed memory (GB), for how big a model the page lets you build
  memoryGB: (() => { try { return Math.round(process.getSystemMemoryInfo().total / 1048576); } catch { return 0; } })(),
  openModel: () => ipcRenderer.invoke('bp:open-model'),
  takePendingOpen: () => ipcRenderer.invoke('bp:take-pending-open'),
  saveFile: (name, data) => ipcRenderer.invoke('bp:save-file', { name, data }),
  saveMany: files => ipcRenderer.invoke('bp:save-many', files),
  saveProject: (filePath, name, data, saveAs) => ipcRenderer.invoke('bp:save-project', { filePath, name, data, saveAs }),
  confirmClose: name => ipcRenderer.invoke('bp:confirm-close', name),
  reveal: p => ipcRenderer.invoke('bp:reveal', p),
  // autosave on disk, streamed in chunks
  autoBegin: () => ipcRenderer.invoke('bp:auto-begin'),
  autoWrite: (id, chunk) => ipcRenderer.invoke('bp:auto-write', id, chunk),
  autoCommit: (id, header) => ipcRenderer.invoke('bp:auto-commit', id, header),
  autoInfo: () => ipcRenderer.invoke('bp:auto-info'),
  autoRead: (offset, length) => ipcRenderer.invoke('bp:auto-read', offset, length),
  // Native (C++) mesh kernels. Synchronous: the page waits for the result, like the JavaScript versions.
  accel: {
    info: () => ipcRenderer.sendSync('bp:native-info'),
    voxelize: (pos, idx, o, n, h) => nativeCall('voxelize', { pos, idx, o, n, h }),
    surfaceNets: (inside, o, n, h) => nativeCall('surfaceNets', { inside, o, n, h }),
    fitSurface: (pos, idx, srcPos, srcIdx, buried, maxSnap, smooth, project) => nativeCall('fitSurface', { pos, idx, srcPos, srcIdx, buried, maxSnap, smooth, project }),
    smoothOrient: (N, Q, start, list, fq, iters, shuffle, parallel) => nativeCall('smoothOrient', { N, Q, start, list, fq, iters, shuffle, parallel }),
    smoothPos: (V, N, Q, O, start, list, fo, fx, s, iters, shuffle, parallel) => nativeCall('smoothPos', { V, N, Q, O, start, list, fo, fx, s, iters, shuffle, parallel }),
    mirrorPairs: (pos, o, cell, tol2) => nativeCall('mirrorPairs', { pos, o, cell, tol2 }),
    bake: (lowPos, uvIdx, uv, highPos, highIdx, paint, size, maxDist, dilate) => nativeCall('bake', { lowPos, uvIdx, uv, highPos, highIdx, paint, size, maxDist, dilate }),
  },
  onOpenModel: cb => ipcRenderer.on('bp:open-model', (_e, m) => m && cb(m)),
  // cb resolves to false to keep the window open
  onBeforeClose: cb => ipcRenderer.on('bp:before-close', async () => {
    ipcRenderer.send('bp:close-ack');
    let ok = true;
    try { ok = (await cb()) !== false; } catch (err) { console.error(err); }
    ipcRenderer.send(ok ? 'bp:close-ready' : 'bp:close-cancel');
  }),
});
