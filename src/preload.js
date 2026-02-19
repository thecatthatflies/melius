const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel, callback) => {
  if (typeof callback !== "function") {
    return () => {};
  }

  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

contextBridge.exposeInMainWorld("workbench", {
  platform: process.platform,

  openFolder: () => ipcRenderer.invoke("dialog:openFolder"),
  listDirectory: (directoryPath) =>
    ipcRenderer.invoke("fs:listDirectory", directoryPath),
  readFile: (filePath) => ipcRenderer.invoke("fs:readFile", filePath),
  writeFile: (filePath, content) =>
    ipcRenderer.invoke("fs:writeFile", { path: filePath, content }),
  watchWorkspace: (workspacePath) =>
    ipcRenderer.invoke("workspace:watch", workspacePath),
  unwatchWorkspace: () => ipcRenderer.invoke("workspace:unwatch"),
  onWorkspaceChanged: (callback) => subscribe("workspace:changed", callback),

  getInitialCwd: () => ipcRenderer.invoke("app:getCwd"),
  openExternal: (targetUrl) => ipcRenderer.invoke("app:openExternal", targetUrl),

  listTerminalProfiles: () => ipcRenderer.invoke("terminal:listProfiles"),
  createTerminalSession: (options) =>
    ipcRenderer.invoke("terminal:create", options),
  writeTerminalData: (sessionId, data) =>
    ipcRenderer.send("terminal:write", { sessionId, data }),
  resizeTerminalSession: (sessionId, cols, rows) =>
    ipcRenderer.send("terminal:resize", { sessionId, cols, rows }),
  killTerminalSession: (sessionId) =>
    ipcRenderer.invoke("terminal:kill", sessionId),
  onTerminalData: (callback) => subscribe("terminal:data", callback),
  onTerminalExit: (callback) => subscribe("terminal:exit", callback),

  loadExtensions: (workspacePath) =>
    ipcRenderer.invoke("extensions:load", workspacePath),
  createExtensionBaseplate: (payload) =>
    ipcRenderer.invoke("extensions:createBaseplate", payload),
  executeExtensionCommand: (commandId, args = []) =>
    ipcRenderer.invoke("extensions:executeCommand", { commandId, args }),

  onFolderSelected: (callback) => subscribe("folder:selected", callback),
  onSaveRequested: (callback) => subscribe("menu:save-file", callback),
  onNewTerminalRequested: (callback) =>
    subscribe("menu:new-terminal", callback),
});
