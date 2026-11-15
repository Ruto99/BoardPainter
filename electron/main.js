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

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function resolveAppPath(urlPath) {
  const parts = decodeURIComponent(urlPath).split('/').filter(Boolean);
  if (parts.some(p => p === '..')) return null;
  return path.join(SRC, ...(parts.length ? parts : ['index.html']));
}

const MODEL_EXT = new Set(['.obj', '.stl']);
let win = null;
let pendingOpen = null; // file passed on the command line / via "open with"
let allowClose = false;

function fileArg(argv) {
  return argv.slice(1).find(a => !a.startsWith('-') && MODEL_EXT.has(path.extname(a).toLowerCase())) || null;
}

async function readModel(p) {
  const data = await fs.readFile(p);
  return { name: path.basename(p), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
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

  // Give the renderer a chance to flush its autosave before the window closes.
  win.on('close', e => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('bp:before-close');
    setTimeout(() => { allowClose = true; win && win.close(); }, 3000); // safety net
  });
  win.on('closed', () => { win = null; });
}

// ---------------- IPC ----------------
const FILTERS = {
  obj: { name: 'Wavefront OBJ', extensions: ['obj'] },
  stl: { name: 'STL (3Dプリント)', extensions: ['stl'] },
  glb: { name: 'glTF Binary (GLB)', extensions: ['glb'] },
};

ipcMain.handle('bp:open-model', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'モデルを読み込み',
    properties: ['openFile'],
    filters: [{ name: '3Dモデル (OBJ / STL)', extensions: ['obj', 'stl'] }, { name: 'すべてのファイル', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return readModel(r.filePaths[0]);
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
ipcMain.on('bp:close-ready', () => { allowClose = true; if (win) win.close(); });

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
      return net.fetch(pathToFileURL(p).toString());
    });
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
