const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');

// Only these media subfolders are indexed (maps etc. are huge and not needed).
const INDEXED_DIRS = ['models_X', 'anims_X', 'textures', 'AnimSets'];

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#16181b',
    title: 'PZ Animator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Automated smoke test: PZA_TEST_FOLDER=<pz folder> PZA_TEST_SHOT=<out.png>
  if (process.env.PZA_TEST_FOLDER) {
    win.webContents.on('did-finish-load', async () => {
      await win.webContents.executeJavaScript(`window.__pz.openFolder(${JSON.stringify(process.env.PZA_TEST_FOLDER)})`);
      await new Promise(r => setTimeout(r, 4000));
      const status = await win.webContents.executeJavaScript(`document.getElementById('status').textContent + ' | ' + document.getElementById('animCount').textContent`);
      console.log('STATUS:', status);
      if (process.env.PZA_TEST_JS) {
        const js = await fs.readFile(process.env.PZA_TEST_JS, 'utf8');
        console.log('TEST:', await win.webContents.executeJavaScript(js));
      }
      const img = await win.webContents.capturePage();
      await fs.writeFile(process.env.PZA_TEST_SHOT || 'smoke.png', img.toPNG());
      app.quit();
    });
  }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// Accept the install folder, its media folder, or a folder that contains ProjectZomboid.
async function resolveMediaRoot(folder) {
  const candidates = [
    path.join(folder, 'media'),
    folder,
    path.join(folder, 'ProjectZomboid', 'media'),
  ];
  for (const c of candidates) {
    if (await exists(path.join(c, 'models_X')) || await exists(path.join(c, 'anims_X'))) return c;
  }
  throw new Error("This doesn't look like a Project Zomboid folder (no media/models_X or media/anims_X found).");
}

async function walk(dir, base, out) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
}

function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  const r = path.resolve(root);
  if (full !== r && !full.startsWith(r + path.sep)) throw new Error('Path outside game folder: ' + rel);
  return full;
}

ipcMain.handle('pick-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose your Project Zomboid install folder',
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('index-folder', async (_e, folder) => {
  const mediaRoot = await resolveMediaRoot(folder);
  const files = [];
  for (const d of INDEXED_DIRS) {
    // Folder names differ in case between builds; match case-insensitively.
    const entries = await fs.readdir(mediaRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name.toLowerCase() === d.toLowerCase()) await walk(path.join(mediaRoot, e.name), mediaRoot, files);
    }
  }
  return { root: folder, mediaRoot, files };
});

ipcMain.handle('read-text', async (_e, mediaRoot, rel) => fs.readFile(safeJoin(mediaRoot, rel), 'utf8'));
ipcMain.handle('read-binary', async (_e, mediaRoot, rel) => {
  const buf = await fs.readFile(safeJoin(mediaRoot, rel));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// ---------- mods ----------
function defaultModsDir() {
  return process.env.PZA_MODS_DIR || path.join(app.getPath('home'), 'Zomboid', 'mods');
}

function parseModInfo(text) {
  const info = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^=#]+?)\s*=\s*(.*)$/);
    if (m) info[m[1].toLowerCase()] = m[2].trim();
  }
  return info;
}

// Describe a mod folder: its name/id and where its media folder lives.
async function describeMod(modsDir, folder) {
  const dir = path.join(modsDir, folder);
  const b42 = path.join(dir, '42');
  const hasB42 = await exists(b42);
  let infoText = null;
  for (const p of [path.join(b42, 'mod.info'), path.join(dir, 'mod.info')]) {
    try { infoText = await fs.readFile(p, 'utf8'); break; } catch {}
  }
  if (infoText === null && !hasB42) return null; // not a mod folder
  const info = infoText ? parseModInfo(infoText) : {};
  return {
    folder,
    name: info.name || folder,
    id: info.id || '',
    layout: hasB42 ? 'b42' : 'flat',
    infoText: infoText || '',
    mediaRel: hasB42 ? '42/media' : 'media',
  };
}

ipcMain.handle('mods-default-dir', async () => defaultModsDir());

ipcMain.handle('pick-mods-dir', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, { title: 'Choose your Zomboid mods folder', defaultPath: defaultModsDir(), properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('list-mods', async (_e, modsDir) => {
  let entries = [];
  try { entries = await fs.readdir(modsDir, { withFileTypes: true }); } catch { return []; }
  const mods = [];
  for (const en of entries) {
    if (!en.isDirectory()) continue;
    const d = await describeMod(modsDir, en.name);
    if (d) mods.push(d);
  }
  return mods.sort((a, b) => a.name.localeCompare(b.name));
});

// files: [{ rel, content }] relative to the mod folder. dirs: extra empty folders to create.
ipcMain.handle('check-mod-files', async (_e, modsDir, folder, rels) => {
  const root = safeJoin(modsDir, folder);
  const existing = [];
  for (const rel of rels) if (await exists(safeJoin(root, rel))) existing.push(rel);
  return existing;
});

ipcMain.handle('write-mod-files', async (_e, modsDir, folder, files, dirs = []) => {
  if (!/^[^<>:"/\\|?*\x00-\x1f]+$/.test(folder) || folder === '.' || folder === '..') throw new Error('Invalid mod folder name: ' + folder);
  await fs.mkdir(modsDir, { recursive: true });
  const root = safeJoin(modsDir, folder);
  for (const d of dirs) await fs.mkdir(safeJoin(root, d), { recursive: true });
  const written = [];
  for (const f of files) {
    const full = safeJoin(root, f.rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, f.content, 'utf8');
    written.push(full);
  }
  return written;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
