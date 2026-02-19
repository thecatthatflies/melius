const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') {
    return () => {};
  }

  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

contextBridge.exposeInMainWorld('workbench', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  listDirectory: (directoryPath) =>
    ipcRenderer.invoke('fs:listDirectory', directoryPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) =>
    ipcRenderer.invoke('fs:writeFile', { path: filePath, content }),
  getInitialCwd: () => ipcRenderer.invoke('app:getCwd'),
  runTerminalCommand: (command, cwd) =>
    ipcRenderer.invoke('terminal:run', { command, cwd }),
  onFolderSelected: (callback) => subscribe('folder:selected', callback),
  onSaveRequested: (callback) => subscribe('menu:save-file', callback),
});
