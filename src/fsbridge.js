// File access layer. In the desktop app this talks to Electron (window.pzfs, see preload.js).
// Opened in a plain browser it falls back to a small bundled test set (dev mode).

const desktop = typeof window !== 'undefined' && window.pzfs;

export const isDesktop = !!desktop;

export async function pickFolder() {
  if (desktop) return desktop.pickFolder();
  return 'testdata';
}

// Returns { root, mediaRoot, files: [relative paths under media, using '/'] }
export async function indexFolder(folder) {
  if (desktop) return desktop.indexFolder(folder);
  const res = await fetch('testdata/index.json');
  const files = await res.json();
  return { root: folder, mediaRoot: 'testdata', files };
}

export async function readText(mediaRoot, rel) {
  if (desktop) return desktop.readText(mediaRoot, rel);
  return (await fetch(`${mediaRoot}/${rel}`)).text();
}

export async function readBinary(mediaRoot, rel) {
  if (desktop) return desktop.readBinary(mediaRoot, rel);
  return (await fetch(`${mediaRoot}/${rel}`)).arrayBuffer();
}

// ---------- mods (desktop writes real files; browser dev mode keeps them in memory) ----------
const devMods = { dir: 'dev-mods', files: new Map() };
if (typeof window !== 'undefined') window.__devMods = devMods;

export async function modsDefaultDir() { return desktop ? desktop.modsDefaultDir() : devMods.dir; }
export async function pickModsDir() { return desktop ? desktop.pickModsDir() : devMods.dir; }
export async function listMods(dir) {
  if (desktop) return desktop.listMods(dir);
  const folders = new Set([...devMods.files.keys()].map(k => k.split('/')[0]));
  return [...folders].map(f => ({ folder: f, name: f, id: f, layout: 'b42', mediaRel: '42/media' }));
}
export async function checkModFiles(dir, folder, rels) {
  if (desktop) return desktop.checkModFiles(dir, folder, rels);
  return rels.filter(r => devMods.files.has(`${folder}/${r}`));
}
export async function writeModFiles(dir, folder, files, dirs) {
  if (desktop) return desktop.writeModFiles(dir, folder, files, dirs);
  for (const f of files) devMods.files.set(`${folder}/${f.rel}`, f.content);
  return files.map(f => `${dir}/${folder}/${f.rel}`);
}

// Case-insensitive lookup helpers over the file index.
export class FileIndex {
  constructor(info) {
    this.mediaRoot = info.mediaRoot;
    this.root = info.root;
    this.files = info.files;
    this.byLower = new Map();
    this.byBase = new Map();
    for (const f of info.files) {
      const lower = f.toLowerCase();
      this.byLower.set(lower, f);
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      if (!this.byBase.has(base)) this.byBase.set(base, []);
      this.byBase.get(base).push(f);
    }
  }
  // Find a file by base name, preferring paths that contain `prefer` (e.g. 'models_x/').
  find(baseName, prefer = '') {
    const list = this.byBase.get(baseName.toLowerCase());
    if (!list) return null;
    if (prefer) {
      const hit = list.find(p => p.toLowerCase().includes(prefer.toLowerCase()));
      if (hit) return hit;
    }
    return list[0];
  }
  under(dirPrefix, ext) {
    const d = dirPrefix.toLowerCase();
    return this.files.filter(f => {
      const l = f.toLowerCase();
      return l.startsWith(d) && (!ext || l.endsWith(ext));
    });
  }
  text(rel) { return readText(this.mediaRoot, rel); }
  binary(rel) { return readBinary(this.mediaRoot, rel); }
}
