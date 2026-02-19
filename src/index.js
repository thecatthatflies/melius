const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const isMac = process.platform === 'darwin';

const normalizeCwd = (cwd) =>
  typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();

const parseCdTarget = (command) => {
  const match = command.trim().match(/^cd(?:\s+(.+))?$/);
  if (!match) {
    return null;
  }

  let target = match[1] ? match[1].trim() : '';
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1);
  }

  return target;
};

const listDirectory = async (directoryPath) => {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      path: path.join(directoryPath, entry.name),
      type: entry.isDirectory() ? 'directory' : 'file',
    }))
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }

      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
};

const runTerminalCommand = async (command, cwd) => {
  const trimmedCommand = command.trim();
  const currentCwd = normalizeCwd(cwd);

  if (!trimmedCommand) {
    return { output: '', error: '', exitCode: 0, cwd: currentCwd };
  }

  const cdTarget = parseCdTarget(trimmedCommand);
  if (cdTarget !== null) {
    const nextCwd = cdTarget ? path.resolve(currentCwd, cdTarget) : os.homedir();
    const stats = await fs.stat(nextCwd);

    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${nextCwd}`);
    }

    return { output: '', error: '', exitCode: 0, cwd: nextCwd };
  }

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: currentCwd,
      shell: true,
      windowsHide: true,
    });

    let output = '';
    let error = '';

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      error += chunk.toString();
    });

    child.on('error', (spawnError) => {
      resolve({
        output,
        error: `${error}${spawnError.message}\n`,
        exitCode: 1,
        cwd: currentCwd,
      });
    });

    child.on('close', (exitCode) => {
      resolve({
        output,
        error,
        exitCode: typeof exitCode === 'number' ? exitCode : 0,
        cwd: currentCwd,
      });
    });
  });
};

const openFolderForWindow = async (targetWindow) => {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return null;
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(targetWindow, {
    title: 'Open Folder',
    properties: ['openDirectory'],
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  const selectedPath = filePaths[0];
  targetWindow.webContents.send('folder:selected', selectedPath);
  return selectedPath;
};

const buildMenu = (mainWindow) => {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: (_menuItem, focusedWindow) => {
            const targetWindow =
              focusedWindow ||
              BrowserWindow.getFocusedWindow() ||
              BrowserWindow.getAllWindows()[0] ||
              mainWindow;

            if (targetWindow) {
              void openFolderForWindow(targetWindow);
            }
          },
        },
        {
          label: 'Save File',
          accelerator: 'CmdOrCtrl+S',
          click: (_menuItem, focusedWindow) => {
            const targetWindow = focusedWindow || BrowserWindow.getFocusedWindow();
            if (targetWindow && !targetWindow.isDestroyed()) {
              targetWindow.webContents.send('menu:save-file');
            }
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};

const registerIpcHandlers = () => {
  ipcMain.handle('dialog:openFolder', async (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    return openFolderForWindow(targetWindow);
  });

  ipcMain.handle('fs:listDirectory', async (_event, directoryPath) => {
    if (typeof directoryPath !== 'string' || directoryPath.length === 0) {
      throw new Error('Directory path is required.');
    }
    return listDirectory(directoryPath);
  });

  ipcMain.handle('fs:readFile', async (_event, filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('File path is required.');
    }
    return fs.readFile(filePath, 'utf8');
  });

  ipcMain.handle('fs:writeFile', async (_event, payload) => {
    if (!payload || typeof payload.path !== 'string') {
      throw new Error('A file path is required to save content.');
    }
    await fs.writeFile(payload.path, payload.content ?? '', 'utf8');
    return true;
  });

  ipcMain.handle('app:getCwd', () => process.cwd());

  ipcMain.handle('terminal:run', async (_event, payload) => {
    const command =
      payload && typeof payload.command === 'string' ? payload.command : '';
    const cwd = payload && typeof payload.cwd === 'string' ? payload.cwd : '';

    try {
      return await runTerminalCommand(command, cwd);
    } catch (error) {
      return {
        output: '',
        error: `${error.message}\n`,
        exitCode: 1,
        cwd: normalizeCwd(cwd),
      };
    }
  });
};

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  return mainWindow;
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  registerIpcHandlers();
  const mainWindow = createWindow();
  buildMenu(mainWindow);

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
