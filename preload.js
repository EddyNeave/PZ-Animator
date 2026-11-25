const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pzfs', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  indexFolder: (folder) => ipcRenderer.invoke('index-folder', folder),
  readText: (mediaRoot, rel) => ipcRenderer.invoke('read-text', mediaRoot, rel),
  readBinary: (mediaRoot, rel) => ipcRenderer.invoke('read-binary', mediaRoot, rel),
  modsDefaultDir: () => ipcRenderer.invoke('mods-default-dir'),
  pickModsDir: () => ipcRenderer.invoke('pick-mods-dir'),
  listMods: (modsDir) => ipcRenderer.invoke('list-mods', modsDir),
  checkModFiles: (modsDir, folder, rels) => ipcRenderer.invoke('check-mod-files', modsDir, folder, rels),
  writeModFiles: (modsDir, folder, files, dirs) => ipcRenderer.invoke('write-mod-files', modsDir, folder, files, dirs),
});
