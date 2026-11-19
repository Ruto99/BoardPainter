// BoardPainter — Electron main process.
// Serves the UI from a private app:// origin (no network needed), and gives the
// renderer native open/save dialogs through a small, explicit IPC surface.
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const HOST = 'bp';
const SRC = path.join(__dirname, '..', 'src');
// Library files (three.js etc.) are copied into src/vendor by scripts/vendor.js.

// Development / testing: run with separate settings and autosave (BP_USER_DATA=<folder>).
if (process.env.BP_USER_DATA) app.setPath('userData', path.resolve(process.env.BP_USER_DATA));

// Desktop only: let big meshes use far more memory than a browser tab would allow.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function resolveAppPath(urlPath) {
  const parts = decodeURIComponent(urlPath).split('/').filter(Boolean);
  if (parts.some(p => p === '..')) return null;
  return path.join(SRC, ...(parts.length ? parts : ['index.html']));
}

const MODEL_EXT = new Set(['.obj', '.stl', '.bpp', '.fbx', '.glb', '.gltf']);
let win = null;
let pendingOpen = null; // file passed on the command line / via "open with"
let allowClose = false;
let closeTimer = null;

function fileArg(argv) {
  return argv.slice(1).find(a => !a.startsWith('-') && MODEL_EXT.has(path.extname(a).toLowerCase())) || null;
}

// Big project files are not sent whole (a page buffer can't exceed 2 GB): the page reads them in pieces
// with bp:open-read, which only serves the file opened last.
let openReadPath = null;
const BIG_OPEN = (+process.env.BP_BIG_OPEN_MB || 256) * 1024 * 1024;   // testing can lower it
async function readModel(p) {
  const st = await fs.stat(p);
  if (path.extname(p).toLowerCase() === '.bpp' && st.size > BIG_OPEN) { openReadPath = p; return { name: path.basename(p), path: p, size: st.size, big: true }; }
  const data = await fs.readFile(p);
  return { name: path.basename(p), path: p, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#1b1c1f',
    title: 'BoardPainter',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.loadURL(`${SCHEME}://${HOST}/index.html`);

  // Never navigate away from the app; open external links in the browser.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${SCHEME}://`)) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });

  // F11 fullscreen, F12 devtools (no menu bar, so wire them here).
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });

  // Let the renderer flush its autosave (and ask about unsaved changes) before the window closes.
  // If the page doesn't acknowledge within 3 s (hung/crashed), close anyway.
  win.on('close', e => {
    if (allowClose) return;
    e.preventDefault();
    if (closeTimer) return; // already asking
    win.webContents.send('bp:before-close');
    closeTimer = setTimeout(() => { allowClose = true; win && win.close(); }, 3000);
  });
  win.on('closed', () => { win = null; });
}

// ---------------- IPC ----------------
const FILTERS = {
  obj: { name: 'Wavefront OBJ', extensions: ['obj'] },
  stl: { name: 'STL (3Dプリント)', extensions: ['stl'] },
  glb: { name: 'glTF Binary (GLB)', extensions: ['glb'] },
  fbx: { name: 'FBX', extensions: ['fbx'] },
  exr: { name: 'OpenEXR (32bit)', extensions: ['exr'] },
  bpbrush: { name: 'BoardPainter ブラシ', extensions: ['bpbrush'] },
};

ipcMain.handle('bp:open-model', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '開く',
    defaultPath: lastDir(),
    properties: ['openFile'],
    filters: [
      { name: 'BoardPainter プロジェクト / 3Dモデル', extensions: ['bpp', 'obj', 'stl', 'fbx', 'glb', 'gltf'] },
      { name: 'BoardPainter プロジェクト (.bpp)', extensions: ['bpp'] },
      { name: '3Dモデル (OBJ / STL / FBX / GLB)', extensions: ['obj', 'stl', 'fbx', 'glb', 'gltf'] },
      { name: 'すべてのファイル', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  rememberDir(path.dirname(r.filePaths[0]));
  return readModel(r.filePaths[0]);
});

// Save a project. Writes straight to `filePath` unless it's missing or saveAs is set.
ipcMain.handle('bp:save-project', async (_e, { filePath, name, data, saveAs }) => {
  let target = !saveAs && typeof filePath === 'string' && filePath ? filePath : null;
  if (!target) {
    const r = await dialog.showSaveDialog(win, {
      title: saveAs ? '名前を付けて保存' : 'プロジェクトを保存',
      defaultPath: filePath || path.join(lastDir(), `${name || 'sculpt'}.bpp`),
      filters: [{ name: 'BoardPainter プロジェクト (.bpp)', extensions: ['bpp'] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  const tmp = target + '.tmp';
  await fs.writeFile(tmp, Buffer.from(data));   // write-then-rename so a crash never leaves a half-written project
  await fs.rename(tmp, target);
  rememberDir(path.dirname(target));
  return target;
});

ipcMain.handle('bp:confirm-close', async (_e, name) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['保存して閉じる', '保存せずに閉じる', 'キャンセル'],
    defaultId: 0, cancelId: 2, noLink: true,
    title: 'BoardPainter',
    message: `「${name}」への変更を保存しますか？`,
    detail: '保存しない場合も、作業内容は次回起動時に復元されます。',
  });
  return r.response; // 0 save, 1 discard, 2 cancel
});

ipcMain.handle('bp:take-pending-open', async () => {
  const p = pendingOpen; pendingOpen = null;
  return p ? readModel(p).catch(() => null) : null;
});

ipcMain.handle('bp:save-file', async (_e, { name, data }) => {
  const ext = path.extname(name).slice(1).toLowerCase();
  const r = await dialog.showSaveDialog(win, {
    title: '書き出し',
    defaultPath: path.join(lastDir(), name),
    filters: FILTERS[ext] ? [FILTERS[ext]] : [],
  });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, Buffer.from(data));
  rememberDir(path.dirname(r.filePath));
  return r.filePath;
});

ipcMain.handle('bp:save-many', async (_e, files) => {
  const r = await dialog.showOpenDialog(win, {
    title: '書き出し先のフォルダを選択',
    defaultPath: lastDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  for (const f of files) await fs.writeFile(path.join(dir, path.basename(f.name)), Buffer.from(f.data));
  rememberDir(dir);
  return dir;
});

ipcMain.handle('bp:reveal', (_e, p) => { if (typeof p === 'string') shell.showItemInFolder(p); });
ipcMain.on('bp:close-ack', () => { clearTimeout(closeTimer); closeTimer = 'asking'; });
ipcMain.on('bp:close-ready', () => { clearTimeout(closeTimer); allowClose = true; if (win) win.close(); });
ipcMain.on('bp:close-cancel', () => { clearTimeout(closeTimer); closeTimer = null; });

// ---------------- native processing (C++ module in a worker thread) ----------------
// The renderer calls these synchronously (ipcRenderer.sendSync) because the mesh code that uses them is
// synchronous; the reply is set when the worker finishes, so only the page waits, not this process.
const NATIVE_PATH = path.join(__dirname, '..', 'native', 'build', 'Release', 'bp_native.node').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
let nativeWorker = null, nativeState = { ok: false, error: 'not started', info: null };
const nativeJobs = new Map();
let nativeSeq = 0;
function startNative() {
  return new Promise(resolve => {
    try {
      const { Worker } = require('node:worker_threads');
      const w = new Worker(path.join(__dirname, 'native-worker.js'), { workerData: { modulePath: NATIVE_PATH } });
      w.on('message', m => {
        if (m.ready) { nativeState = { ok: m.ok, error: m.error, info: m.info }; if (!m.ok) console.warn('native module unavailable:', m.error); resolve(); return; }
        const job = nativeJobs.get(m.id); if (!job) return;
        nativeJobs.delete(m.id); job(m);
      });
      w.on('error', err => { nativeState = { ok: false, error: String(err.message || err), info: null }; console.error('native worker:', err); resolve(); });
      w.on('exit', () => { nativeWorker = null; nativeState.ok = false; for (const job of nativeJobs.values()) job({ error: 'native worker stopped' }); nativeJobs.clear(); });
      nativeWorker = w;
    } catch (err) { nativeState = { ok: false, error: String(err.message || err), info: null }; resolve(); }
  });
}
const nativeReady = startNative();
ipcMain.on('bp:native-info', async e => { await nativeReady; e.returnValue = { ...nativeState, path: NATIVE_PATH }; });
ipcMain.on('bp:native', async (e, op, args) => {
  await nativeReady;
  if (!nativeWorker || !nativeState.ok) { e.returnValue = { error: nativeState.error || 'native module unavailable' }; return; }
  const id = ++nativeSeq;
  nativeJobs.set(id, m => { e.returnValue = m.error ? { error: m.error } : { result: m.result }; });
  const transfer = [];
  for (const v of Object.values(args || {})) if (ArrayBuffer.isView(v) && !transfer.includes(v.buffer)) transfer.push(v.buffer);
  nativeWorker.postMessage({ id, op, args }, transfer);
});

ipcMain.handle('bp:open-read', async (_e, offset, length) => {
  if (!openReadPath || !(offset >= 0) || !(length > 0 && length <= 64 * 1024 * 1024)) return null;
  const fh = await fs.open(openReadPath, 'r');
  try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return b.subarray(0, bytesRead); }
  finally { await fh.close(); }
});

// Project save in pieces (for models whose file doesn't fit in one buffer): written to <file>.tmp, renamed at the end
let projJob = null;
ipcMain.handle('bp:proj-begin', async (_e, { filePath, name, saveAs }) => {
  let target = !saveAs && typeof filePath === 'string' && filePath ? filePath : null;
  if (!target) {
    const r = await dialog.showSaveDialog(win, {
      title: saveAs ? '名前を付けて保存' : 'プロジェクトを保存',
      defaultPath: filePath || path.join(lastDir(), `${name || 'sculpt'}.bpp`),
      filters: [{ name: 'BoardPainter プロジェクト (.bpp)', extensions: ['bpp'] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  if (projJob) { await projJob.fh.close().catch(() => {}); await fs.rm(projJob.tmp, { force: true }).catch(() => {}); }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tmp = target + '.tmp';
  projJob = { id, target, tmp, fh: await fs.open(tmp, 'w') };
  return id;
});
ipcMain.handle('bp:proj-write', async (_e, id, chunk) => {
  if (!projJob || projJob.id !== id || !ArrayBuffer.isView(chunk)) return false;
  await projJob.fh.write(chunk); return true;
});
ipcMain.handle('bp:proj-end', async (_e, id, ok) => {
  if (!projJob || projJob.id !== id) return null;
  const j = projJob; projJob = null;
  await j.fh.close();
  if (!ok) { await fs.rm(j.tmp, { force: true }).catch(() => {}); return null; }
  await fs.rename(j.tmp, j.target);
  rememberDir(path.dirname(j.target));
  return j.target;
});

// ---------------- autosave (crash recovery) ----------------
// The page streams the project in chunks (so a 20-million-polygon model never freezes it) into
// autosave-<stamp>.bin; autosave.json, which names that file, is replaced last (write-then-rename),
// so a crash mid-save leaves the previous autosave intact.
const autoDir = () => app.getPath('userData');
const AUTO_JSON = () => path.join(autoDir(), 'autosave.json');
let autoJob = null;   // { id, fh, file, bytes }
async function autoAbort() {
  if (!autoJob) return;
  const j = autoJob; autoJob = null;
  await j.fh.close().catch(() => {});
  await fs.rm(path.join(autoDir(), j.file), { force: true }).catch(() => {});
}
ipcMain.handle('bp:auto-begin', async () => {
  await autoAbort();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file = `autosave-${id}.bin`;
  autoJob = { id, file, fh: await fs.open(path.join(autoDir(), file), 'w'), bytes: 0 };
  return id;
});
ipcMain.handle('bp:auto-write', async (_e, id, chunk) => {
  if (!autoJob || autoJob.id !== id || !ArrayBuffer.isView(chunk)) return false;
  await autoJob.fh.write(chunk);
  autoJob.bytes += chunk.byteLength;
  return true;
});
ipcMain.handle('bp:auto-commit', async (_e, id, header) => {
  if (!autoJob || autoJob.id !== id || typeof header !== 'string') return false;
  const j = autoJob; autoJob = null;
  await j.fh.close();
  const tmp = AUTO_JSON() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ file: j.file, bytes: j.bytes, header }));
  await fs.rename(tmp, AUTO_JSON());
  // remove older data files
  for (const f of await fs.readdir(autoDir())) if (/^autosave-.*\.bin$/.test(f) && f !== j.file) await fs.rm(path.join(autoDir(), f), { force: true }).catch(() => {});
  return true;
});
// { header, bytes } of the last complete autosave, or null; the data is then read in pieces with bp:auto-read
let autoRead = null;
ipcMain.handle('bp:auto-info', async () => {
  try {
    const a = JSON.parse(await fs.readFile(AUTO_JSON(), 'utf8'));
    const file = path.join(autoDir(), path.basename(String(a.file)));
    if ((await fs.stat(file)).size !== a.bytes) return null;
    autoRead = file;
    return { header: a.header, bytes: a.bytes };
  } catch { return null; }
});
ipcMain.handle('bp:auto-read', async (_e, offset, length) => {
  if (!autoRead || !(offset >= 0) || !(length > 0 && length <= 64 * 1024 * 1024)) return null;
  const fh = await fs.open(autoRead, 'r');
  try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return b.subarray(0, bytesRead); }
  finally { await fh.close(); }
});

let exportDir = null;
function lastDir() { return exportDir || app.getPath('documents'); }
function rememberDir(d) { exportDir = d; }

// ---------------- lifecycle ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', async (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const f = fileArg(argv);
    if (f) win.webContents.send('bp:open-model', await readModel(f).catch(() => null));
  });

  app.on('open-file', (e, p) => { // macOS "open with"
    e.preventDefault();
    if (win) readModel(p).then(m => win.webContents.send('bp:open-model', m)).catch(() => {});
    else pendingOpen = p;
  });

  pendingOpen = fileArg(process.argv);

  app.whenReady().then(() => {
    protocol.handle(SCHEME, req => {
      const u = new URL(req.url);
      const p = u.host === HOST ? resolveAppPath(u.pathname) : null;
      if (!p) return new Response('Not found', { status: 404 });
      // no caching: after an update the page must never mix old and new module files
      return net.fetch(pathToFileURL(p).toString()).then(r => {
        const headers = new Headers(r.headers); headers.set('Cache-Control', 'no-store');
        return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
      });
    });
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
