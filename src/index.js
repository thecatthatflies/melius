const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
} = require("electron");
const fsNative = require("node:fs");
const { constants: fsConstants } = fsNative;
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

let pty = null;

try {
  pty = require("node-pty");
} catch (error) {
  console.warn(
    "node-pty could not be loaded. Falling back to non-PTY terminals."
  );
}

if (require("electron-squirrel-startup")) {
  app.quit();
}

const isMac = process.platform === "darwin";

const extensionRuntimesByWebContentsId = new Map();
const terminalSessions = new Map();
const workspaceWatchersByWebContentsId = new Map();
let shellProfilesCache = null;
let nextTerminalSessionId = 1;

const createExtensionRuntimeState = () => ({
  workspacePath: "",
  extensions: [],
  commands: new Map(),
  disposables: [],
});

const createWorkspaceWatcherState = () => ({
  rootPath: "",
  watchers: new Map(),
  rebuildTimer: null,
  recursiveWatcher: null,
  usingRecursiveWatcher: false,
  pendingProbePaths: new Set(),
  probeTimer: null,
});

const normalizeWatchPath = (value) => path.normalize(String(value || ""));

const isPathInWorkspace = (rootPath, candidatePath) => {
  const normalizedRoot = normalizeWatchPath(rootPath);
  const normalizedCandidate = normalizeWatchPath(candidatePath);

  if (!normalizedRoot || !normalizedCandidate) {
    return false;
  }

  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot + path.sep)
  );
};

const emitWorkspaceChanged = (sender, changedPath) => {
  if (sender.isDestroyed()) {
    return;
  }

  sender.send("workspace:changed", { path: changedPath });
};

const closeWorkspaceWatchState = (watchState) => {
  if (!watchState) {
    return;
  }

  if (watchState.rebuildTimer) {
    clearTimeout(watchState.rebuildTimer);
    watchState.rebuildTimer = null;
  }

  if (watchState.probeTimer) {
    clearTimeout(watchState.probeTimer);
    watchState.probeTimer = null;
  }

  watchState.pendingProbePaths.clear();

  if (watchState.recursiveWatcher) {
    try {
      watchState.recursiveWatcher.close();
    } catch {
      // Ignore close errors.
    }
    watchState.recursiveWatcher = null;
  }

  for (const watcher of watchState.watchers.values()) {
    try {
      watcher.close();
    } catch {
      // Ignore close errors.
    }
  }

  watchState.watchers.clear();
  watchState.usingRecursiveWatcher = false;
  watchState.rootPath = "";
};

const stopWatchingWorkspace = (webContentsId) => {
  const watchState = workspaceWatchersByWebContentsId.get(webContentsId);
  if (!watchState) {
    return;
  }

  closeWorkspaceWatchState(watchState);
  workspaceWatchersByWebContentsId.delete(webContentsId);
};

const scheduleWorkspaceWatcherRebuild = (watchState, sender) => {
  if (
    !watchState ||
    !watchState.rootPath ||
    sender.isDestroyed() ||
    watchState.usingRecursiveWatcher
  ) {
    return;
  }

  if (watchState.rebuildTimer) {
    clearTimeout(watchState.rebuildTimer);
  }

  watchState.rebuildTimer = setTimeout(() => {
    watchState.rebuildTimer = null;

    if (
      sender.isDestroyed() ||
      !watchState.rootPath ||
      watchState.usingRecursiveWatcher
    ) {
      return;
    }

    for (const watcher of watchState.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors.
      }
    }

    watchState.watchers.clear();
    void scanAndWatchDirectories(watchState, sender, watchState.rootPath);
  }, 500);
};

const queueWatchPathProbe = (watchState, sender, changedPath) => {
  if (
    !watchState ||
    watchState.usingRecursiveWatcher ||
    !changedPath ||
    sender.isDestroyed()
  ) {
    return;
  }

  watchState.pendingProbePaths.add(changedPath);

  if (watchState.probeTimer) {
    return;
  }

  watchState.probeTimer = setTimeout(() => {
    watchState.probeTimer = null;

    if (sender.isDestroyed() || !watchState.rootPath || watchState.usingRecursiveWatcher) {
      watchState.pendingProbePaths.clear();
      return;
    }

    const probePaths = [...watchState.pendingProbePaths];
    watchState.pendingProbePaths.clear();

    void (async () => {
      for (const probePath of probePaths) {
        if (!isPathInWorkspace(watchState.rootPath, probePath)) {
          continue;
        }

        try {
          const stat = await fs.stat(probePath);
          if (stat.isDirectory()) {
            await scanAndWatchDirectories(watchState, sender, probePath);
          }
        } catch {
          // Ignore transient filesystem race conditions.
        }
      }
    })();
  }, 140);
};

const startRecursiveWorkspaceWatcher = (watchState, sender) => {
  if (!watchState || !watchState.rootPath || sender.isDestroyed()) {
    return false;
  }

  if (!["darwin", "win32"].includes(process.platform)) {
    return false;
  }

  try {
    const watcher = fsNative.watch(
      watchState.rootPath,
      { persistent: false, recursive: true },
      (_eventType, fileName) => {
        const changedPath = fileName
          ? path.join(watchState.rootPath, String(fileName))
          : watchState.rootPath;

        emitWorkspaceChanged(sender, changedPath);
      }
    );

    watcher.on("error", () => {
      if (watchState.recursiveWatcher === watcher) {
        watchState.recursiveWatcher = null;
      }
      watchState.usingRecursiveWatcher = false;

      try {
        watcher.close();
      } catch {
        // Ignore close errors.
      }

      if (!sender.isDestroyed() && watchState.rootPath) {
        void scanAndWatchDirectories(watchState, sender, watchState.rootPath);
      }
    });

    watchState.recursiveWatcher = watcher;
    watchState.usingRecursiveWatcher = true;
    return true;
  } catch {
    return false;
  }
};

const scanAndWatchDirectories = async (
  watchState,
  sender,
  startPath = watchState?.rootPath
) => {
  if (
    !watchState ||
    !watchState.rootPath ||
    sender.isDestroyed() ||
    watchState.usingRecursiveWatcher
  ) {
    return;
  }

  const normalizedStartPath = startPath ? path.normalize(startPath) : null;
  if (!normalizedStartPath || !isPathInWorkspace(watchState.rootPath, normalizedStartPath)) {
    return;
  }

  const stack = [normalizedStartPath];

  while (stack.length > 0 && !sender.isDestroyed() && !watchState.usingRecursiveWatcher) {
    const directoryPath = stack.pop();
    if (!directoryPath || watchState.watchers.has(directoryPath)) {
      continue;
    }

    if (!isPathInWorkspace(watchState.rootPath, directoryPath)) {
      continue;
    }

    try {
      const watcher = fsNative.watch(
        directoryPath,
        { persistent: false },
        (_eventType, fileName) => {
          if (sender.isDestroyed()) {
            return;
          }

          const changedPath = fileName
            ? path.join(directoryPath, String(fileName))
            : directoryPath;

          emitWorkspaceChanged(sender, changedPath);
          queueWatchPathProbe(watchState, sender, changedPath);
        }
      );

      watcher.on("error", () => {
        if (!sender.isDestroyed()) {
          scheduleWorkspaceWatcherRebuild(watchState, sender);
        }
      });

      watchState.watchers.set(directoryPath, watcher);
    } catch {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.forEach((entry) => {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(path.join(directoryPath, entry.name));
      }
    });
  }
};

const watchWorkspaceForSender = async (sender, workspacePath) => {
  const senderId = sender.id;
  const normalizedWorkspacePath =
    typeof workspacePath === "string" ? workspacePath.trim() : "";

  stopWatchingWorkspace(senderId);

  if (!normalizedWorkspacePath) {
    return {
      watching: false,
    };
  }

  const watchState = createWorkspaceWatcherState();
  watchState.rootPath = normalizedWorkspacePath;

  workspaceWatchersByWebContentsId.set(senderId, watchState);

  if (!startRecursiveWorkspaceWatcher(watchState, sender)) {
    await scanAndWatchDirectories(watchState, sender, normalizedWorkspacePath);
  }

  return {
    watching: true,
    workspacePath: normalizedWorkspacePath,
  };
};

const normalizeCwd = (cwd) =>
  typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();

const resolveWorkingDirectory = async (cwd) => {
  const requestedPath = normalizeCwd(cwd);

  try {
    const stat = await fs.stat(requestedPath);
    if (stat.isDirectory()) {
      return requestedPath;
    }
  } catch {
    // Fall back to process cwd.
  }

  return process.cwd();
};

const openFolderForWindow = async (targetWindow) => {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return null;
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(targetWindow, {
    title: "Open Folder",
    properties: ["openDirectory"],
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  const selectedPath = filePaths[0];
  targetWindow.webContents.send("folder:selected", selectedPath);
  return selectedPath;
};

const sendToWindow = (mainWindow, channel) => {
  const targetWindow =
    BrowserWindow.getFocusedWindow() ||
    BrowserWindow.getAllWindows()[0] ||
    mainWindow;

  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send(channel);
  }
};

const buildMenu = (mainWindow) => {
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder...",
          accelerator: "CmdOrCtrl+O",
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
          label: "Save File",
          accelerator: "CmdOrCtrl+S",
          click: () => {
            sendToWindow(mainWindow, "menu:save-file");
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Terminal",
      submenu: [
        {
          label: "New Terminal",
          accelerator: "CmdOrCtrl+Shift+`",
          click: () => {
            sendToWindow(mainWindow, "menu:new-terminal");
          },
        },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};

const executableExists = async (candidate) => {
  if (!candidate || typeof candidate !== "string") {
    return false;
  }

  if (candidate.includes(path.sep)) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    }
  }

  const probeCommand = process.platform === "win32" ? "where" : "which";

  return new Promise((resolve) => {
    const probe = spawn(probeCommand, [candidate], {
      windowsHide: true,
    });

    probe.on("error", () => resolve(false));
    probe.on("close", (exitCode) => resolve(exitCode === 0));
  });
};

const normalizeShellProfile = ({ id, label, shellPath, args = [] }) => ({
  id,
  label,
  path: shellPath,
  args,
});

const quoteForShell = (value) => {
  const input = String(value ?? "");
  if (!input) {
    return "''";
  }

  return `'${input.replace(/'/g, "'\\''")}'`;
};

const resolveScriptFallback = (profile) => {
  if (!profile || typeof profile.path !== "string" || !profile.path) {
    return null;
  }

  const profileArgs = Array.isArray(profile.args) ? profile.args : [];

  if (process.platform === "darwin") {
    return {
      command: "script",
      args: ["-q", "/dev/null", profile.path, ...profileArgs],
    };
  }

  if (process.platform === "linux") {
    const commandLine = [profile.path, ...profileArgs]
      .map((part) => quoteForShell(part))
      .join(" ");

    return {
      command: "script",
      args: ["-q", "-f", "-c", commandLine, "/dev/null"],
    };
  }

  return null;
};

const dedupeShellProfiles = (profiles) => {
  const seen = new Set();
  const output = [];

  profiles.forEach((profile) => {
    const key = `${profile.id}|${profile.path}|${profile.args.join(" ")}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    output.push(profile);
  });

  return output;
};

const probeCandidateProfiles = async (candidates) => {
  const resolved = await Promise.all(
    candidates.map(async (candidate) => {
      if (await executableExists(candidate.shellPath)) {
        return normalizeShellProfile(candidate);
      }

      return null;
    })
  );

  return resolved.filter(Boolean);
};

const detectShellProfiles = async ({ force = false } = {}) => {
  if (
    !force &&
    Array.isArray(shellProfilesCache) &&
    shellProfilesCache.length
  ) {
    return shellProfilesCache;
  }

  const profiles = [];

  if (process.platform === "win32") {
    const candidates = [
      {
        id: "pwsh",
        label: "PowerShell 7",
        shellPath: "pwsh.exe",
        args: ["-NoLogo"],
      },
      {
        id: "powershell",
        label: "Windows PowerShell",
        shellPath: "powershell.exe",
        args: ["-NoLogo"],
      },
      {
        id: "cmd",
        label: "Command Prompt",
        shellPath: process.env.ComSpec || "cmd.exe",
        args: [],
      },
      {
        id: "bash",
        label: "Bash",
        shellPath: "bash.exe",
        args: ["-l"],
      },
    ];

    profiles.push(...(await probeCandidateProfiles(candidates)));
  } else {
    const envShell = process.env.SHELL;
    const candidates = [
      envShell
        ? {
            id: "default",
            label: `Default (${path.basename(envShell)})`,
            shellPath: envShell,
            args: ["-l"],
          }
        : null,
      {
        id: "zsh",
        label: "zsh",
        shellPath: "/bin/zsh",
        args: ["-l"],
      },
      {
        id: "bash",
        label: "bash",
        shellPath: "/bin/bash",
        args: ["-l"],
      },
      {
        id: "sh",
        label: "sh",
        shellPath: "/bin/sh",
        args: [],
      },
      {
        id: "fish",
        label: "fish",
        shellPath: "/opt/homebrew/bin/fish",
        args: ["-l"],
      },
      {
        id: "fish-usr",
        label: "fish",
        shellPath: "/usr/local/bin/fish",
        args: ["-l"],
      },
      {
        id: "pwsh",
        label: "PowerShell",
        shellPath: "pwsh",
        args: ["-NoLogo"],
      },
    ].filter(Boolean);

    profiles.push(...(await probeCandidateProfiles(candidates)));
  }

  if (profiles.length === 0) {
    if (process.platform === "win32") {
      profiles.push(
        normalizeShellProfile({
          id: "cmd",
          label: "Command Prompt",
          shellPath: process.env.ComSpec || "cmd.exe",
          args: [],
        })
      );
    } else {
      profiles.push(
        normalizeShellProfile({
          id: "sh",
          label: "System Shell",
          shellPath: process.env.SHELL || "/bin/sh",
          args: [],
        })
      );
    }
  }

  shellProfilesCache = dedupeShellProfiles(profiles);
  return shellProfilesCache;
};

const resolveRequestedProfile = (profiles, payload) => {
  const requestedId =
    payload && typeof payload.profileId === "string" ? payload.profileId : "";

  if (requestedId) {
    const matchedById = profiles.find((profile) => profile.id === requestedId);
    if (matchedById) {
      return matchedById;
    }
  }

  const requestedPath =
    payload && typeof payload.shellPath === "string" ? payload.shellPath : "";

  if (requestedPath) {
    const matchedByPath = profiles.find(
      (profile) => profile.path === requestedPath
    );
    if (matchedByPath) {
      return matchedByPath;
    }
  }

  return profiles[0];
};

const cleanupTerminalSession = (session) => {
  if (!session) {
    return;
  }

  try {
    if (session.mode === "pty") {
      session.process.kill();
    } else {
      session.process.stdin?.end();
      session.process.kill();
    }
  } catch {
    // Ignore termination errors.
  }

  terminalSessions.delete(session.id);
};

const cleanupTerminalSessionsForSender = (senderId) => {
  for (const session of [...terminalSessions.values()]) {
    if (session.senderId === senderId) {
      cleanupTerminalSession(session);
    }
  }
};

const createTerminalSession = async (event, payload) => {
  const sender = event.sender;
  const senderId = sender.id;
  const cwd = await resolveWorkingDirectory(payload?.cwd);
  const terminalEnv = {
    ...process.env,
    TERM: process.env.TERM || "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor",
  };
  const requestedCols = Number.parseInt(payload?.cols, 10);
  const requestedRows = Number.parseInt(payload?.rows, 10);
  const cols = Number.isFinite(requestedCols)
    ? Math.max(20, Math.min(500, requestedCols))
    : 120;
  const rows = Number.isFinite(requestedRows)
    ? Math.max(5, Math.min(200, requestedRows))
    : 35;

  const profiles = await detectShellProfiles();
  const selectedProfile = resolveRequestedProfile(profiles, payload);

  const sessionId = nextTerminalSessionId;
  nextTerminalSessionId += 1;

  if (pty) {
    try {
      const ptyProcess = pty.spawn(selectedProfile.path, selectedProfile.args, {
        name: "xterm-color",
        cwd,
        env: terminalEnv,
        cols,
        rows,
      });

      const session = {
        id: sessionId,
        senderId,
        profile: selectedProfile,
        mode: "pty",
        process: ptyProcess,
      };

      terminalSessions.set(sessionId, session);

      ptyProcess.onData((data) => {
        if (!sender.isDestroyed()) {
          sender.send("terminal:data", { sessionId, data });
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        terminalSessions.delete(sessionId);

        if (!sender.isDestroyed()) {
          sender.send("terminal:exit", {
            sessionId,
            exitCode,
            signal,
          });
        }
      });

      return {
        sessionId,
        profile: selectedProfile,
        ptySupported: true,
      };
    } catch (error) {
      if (!sender.isDestroyed()) {
        sender.send("terminal:data", {
          sessionId,
          data: `\r\nPTY unavailable: ${error.message}\r\n`,
        });
      }
    }
  }

  let childProcess;
  let usedInteractiveFallback = false;
  try {
    const scriptFallback =
      process.platform !== "win32" && (await executableExists("script"))
        ? resolveScriptFallback(selectedProfile)
        : null;

    const spawnCommand = scriptFallback?.command || selectedProfile.path;
    const spawnArgs = scriptFallback?.args || selectedProfile.args;
    usedInteractiveFallback = Boolean(scriptFallback);

    childProcess = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: terminalEnv,
      windowsHide: true,
    });
  } catch (error) {
    if (!sender.isDestroyed()) {
      sender.send("terminal:data", {
        sessionId,
        data: `\r\n${error.message}\r\n`,
      });
      sender.send("terminal:exit", {
        sessionId,
        exitCode: 1,
        signal: "spawn_error",
      });
    }

    return {
      sessionId,
      profile: selectedProfile,
      ptySupported: false,
      interactiveFallback: usedInteractiveFallback,
    };
  }

  const session = {
    id: sessionId,
    senderId,
    profile: selectedProfile,
    mode: "child",
    process: childProcess,
  };

  terminalSessions.set(sessionId, session);

  childProcess.stdout.on("data", (chunk) => {
    if (!sender.isDestroyed()) {
      sender.send("terminal:data", {
        sessionId,
        data: chunk.toString(),
      });
    }
  });

  childProcess.stderr.on("data", (chunk) => {
    if (!sender.isDestroyed()) {
      sender.send("terminal:data", {
        sessionId,
        data: chunk.toString(),
      });
    }
  });

  childProcess.on("close", (exitCode, signal) => {
    terminalSessions.delete(sessionId);

    if (!sender.isDestroyed()) {
      sender.send("terminal:exit", {
        sessionId,
        exitCode: typeof exitCode === "number" ? exitCode : 0,
        signal,
      });
    }
  });

  childProcess.on("error", (error) => {
    if (!sender.isDestroyed()) {
      sender.send("terminal:data", {
        sessionId,
        data: `\r\n${error.message}\r\n`,
      });
      sender.send("terminal:exit", {
        sessionId,
        exitCode: 1,
        signal: "spawn_error",
      });
    }

    terminalSessions.delete(sessionId);
  });

  return {
    sessionId,
    profile: selectedProfile,
    ptySupported: false,
    interactiveFallback: usedInteractiveFallback,
  };
};

const normalizeCommandPayload = (payload, extensionId) => {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) {
      return null;
    }

    return {
      id: trimmed,
      title: trimmed,
      extensionId,
    };
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const commandId =
    typeof payload.id === "string" && payload.id.trim()
      ? payload.id.trim()
      : null;

  if (!commandId) {
    return null;
  }

  return {
    id: commandId,
    title:
      typeof payload.title === "string" && payload.title.trim()
        ? payload.title.trim()
        : commandId,
    extensionId,
  };
};

const loadExtensionsForWorkspace = async (webContentsId, workspacePath) => {
  const runtime = getExtensionRuntimeState(webContentsId);
  await disposeExtensionRuntime(runtime);

  runtime.workspacePath = workspacePath;

  const extensionsRoot = path.join(workspacePath, ".melius", "extensions");

  let extensionDirectories = [];

  try {
    extensionDirectories = (
      await fs.readdir(extensionsRoot, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") {
      runtime.extensions = [];
      return serializeExtensionRuntime(runtime);
    }

    throw error;
  }

  for (const directoryName of extensionDirectories) {
    const extensionPath = path.join(extensionsRoot, directoryName);
    const manifestPath = path.join(extensionPath, "extension.json");

    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      runtime.extensions.push({
        id: directoryName,
        name: directoryName,
        version: "0.0.0",
        description: "",
        main: "main.js",
        path: extensionPath,
        status: "error",
        error: `Invalid manifest: ${error.message}`,
        commands: [],
      });
      continue;
    }

    const extensionId =
      sanitizeExtensionId(manifest.id || directoryName) || directoryName;

    const extensionRecord = {
      id: extensionId,
      name:
        typeof manifest.name === "string" && manifest.name.trim()
          ? manifest.name.trim()
          : formatExtensionName(extensionId),
      version:
        typeof manifest.version === "string" && manifest.version.trim()
          ? manifest.version.trim()
          : "0.0.1",
      description:
        typeof manifest.description === "string" ? manifest.description : "",
      main:
        typeof manifest.main === "string" && manifest.main.trim()
          ? manifest.main.trim()
          : "main.js",
      path: extensionPath,
      status: "loaded",
      error: "",
      commands: [],
    };

    const declaredCommands = coerceManifestCommands(
      manifest.commands,
      extensionId
    );

    const declaredCommandsById = new Map(
      declaredCommands.map((command) => [command.id, command.title])
    );

    const localDisposables = [];

    const registerCommand = (commandId, handler, title) => {
      const normalizedCommand = normalizeCommandPayload(
        {
          id: commandId,
          title,
        },
        extensionId
      );

      if (!normalizedCommand) {
        throw new Error("Command id is required.");
      }

      const runtimeCommand = {
        ...normalizedCommand,
        title:
          normalizedCommand.title ||
          declaredCommandsById.get(normalizedCommand.id) ||
          normalizedCommand.id,
        handler: typeof handler === "function" ? handler : () => undefined,
      };

      runtime.commands.set(runtimeCommand.id, runtimeCommand);

      const disposable = {
        dispose: () => {
          runtime.commands.delete(runtimeCommand.id);
        },
      };

      localDisposables.push(disposable);
      return disposable;
    };

    const extensionContext = {
      workspacePath,
      extensionPath,
      subscriptions: localDisposables,
      registerCommand,
      log: (...args) => {
        console.log(`[extension:${extensionId}]`, ...args);
      },
    };

    const mainFilePath = path.resolve(extensionPath, extensionRecord.main);

    try {
      await fs.access(mainFilePath, fsConstants.R_OK);
      delete require.cache[require.resolve(mainFilePath)];

      const extensionModule = require(mainFilePath);

      if (extensionModule && typeof extensionModule.activate === "function") {
        const activationResult = await Promise.resolve(
          extensionModule.activate(extensionContext)
        );

        if (
          activationResult &&
          typeof activationResult.dispose === "function"
        ) {
          runtime.disposables.push(activationResult);
        }
      }

      if (extensionModule && typeof extensionModule.deactivate === "function") {
        runtime.disposables.push(() => extensionModule.deactivate());
      }

      extensionContext.subscriptions.forEach((entry) => {
        runtime.disposables.push(entry);
      });
    } catch (error) {
      extensionRecord.status = "error";
      extensionRecord.error = `Activation failed: ${error.message}`;
    }

    const runtimeCommands = [...runtime.commands.values()]
      .filter((command) => command.extensionId === extensionId)
      .map((command) => ({
        id: command.id,
        title: command.title,
      }));

    extensionRecord.commands =
      runtimeCommands.length > 0 ? runtimeCommands : declaredCommands;

    runtime.extensions.push(extensionRecord);
  }

  return serializeExtensionRuntime(runtime);
};

const createExtensionBaseplate = async (
  workspacePath,
  requestedExtensionId
) => {
  const sanitizedExtensionId =
    sanitizeExtensionId(requestedExtensionId) ||
    `extension-${Date.now().toString(36)}`;

  const extensionsRoot = path.join(workspacePath, ".melius", "extensions");
  const extensionPath = path.join(extensionsRoot, sanitizedExtensionId);

  await fs.mkdir(extensionsRoot, { recursive: true });

  try {
    await fs.access(extensionPath);
    throw new Error(`Extension "${sanitizedExtensionId}" already exists.`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(extensionPath, { recursive: true });

  const extensionName = formatExtensionName(sanitizedExtensionId);

  const manifest = {
    id: sanitizedExtensionId,
    name: extensionName,
    version: "0.0.1",
    description: `${extensionName} extension for Melius.`,
    main: "main.js",
    commands: [],
  };

  const mainSource = `module.exports.activate = (api) => {
  api.log("Activated");

  // Register commands with api.registerCommand("your.command", handler)
  // and declare them in extension.json.
};

module.exports.deactivate = () => {
  // Clean up resources here if needed.
};
`;

  const readmeSource = `# ${extensionName}

Generated by Melius extension baseplate.

## Files
- \`extension.json\`: extension manifest
- \`main.js\`: extension activation script

## Next Steps
1. Add command metadata in \`extension.json\`
2. Register command handlers in \`main.js\`
`;

  await Promise.all([
    fs.writeFile(
      path.join(extensionPath, "extension.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    ),
    fs.writeFile(path.join(extensionPath, "main.js"), mainSource, "utf8"),
    fs.writeFile(path.join(extensionPath, "README.md"), readmeSource, "utf8"),
  ]);

  return {
    extensionId: sanitizedExtensionId,
    extensionPath,
    manifest,
  };
};

const registerIpcHandlers = () => {
  ipcMain.handle("dialog:openFolder", async (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    return openFolderForWindow(targetWindow);
  });

  ipcMain.handle("fs:listDirectory", async (_event, directoryPath) => {
    if (typeof directoryPath !== "string" || directoryPath.length === 0) {
      throw new Error("Directory path is required.");
    }

    return listDirectory(directoryPath);
  });

  ipcMain.handle("fs:readFile", async (_event, filePath) => {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("File path is required.");
    }

    return fs.readFile(filePath, "utf8");
  });

  ipcMain.handle("fs:writeFile", async (_event, payload) => {
    if (!payload || typeof payload.path !== "string") {
      throw new Error("A file path is required to save content.");
    }

    await fs.writeFile(payload.path, payload.content ?? "", "utf8");
    return true;
  });

  ipcMain.handle("workspace:watch", async (event, workspacePath) =>
    watchWorkspaceForSender(event.sender, workspacePath)
  );

  ipcMain.handle("workspace:unwatch", async (event) => {
    stopWatchingWorkspace(event.sender.id);
    return true;
  });

  ipcMain.handle("app:getCwd", () => process.cwd());

  ipcMain.handle("app:openExternal", async (_event, targetUrl) =>
    openExternalUrl(targetUrl)
  );

  ipcMain.handle("terminal:listProfiles", async () => ({
    profiles: await detectShellProfiles(),
    ptySupported: Boolean(pty),
  }));

  ipcMain.handle("terminal:create", async (event, payload) =>
    createTerminalSession(event, payload)
  );

  ipcMain.on("terminal:write", (event, payload) => {
    const sessionId =
      payload && Number.isInteger(payload.sessionId) ? payload.sessionId : null;

    if (sessionId === null) {
      return;
    }

    const session = terminalSessions.get(sessionId);
    if (!session || session.senderId !== event.sender.id) {
      return;
    }

    const data =
      payload && typeof payload.data === "string" ? payload.data : "";

    if (!data) {
      return;
    }

    if (session.mode === "pty") {
      session.process.write(data);
      return;
    }

    session.process.stdin?.write(data);
  });

  ipcMain.on("terminal:resize", (event, payload) => {
    const sessionId =
      payload && Number.isInteger(payload.sessionId) ? payload.sessionId : null;

    if (sessionId === null) {
      return;
    }

    const session = terminalSessions.get(sessionId);
    if (
      !session ||
      session.senderId !== event.sender.id ||
      session.mode !== "pty"
    ) {
      return;
    }

    const cols = Number.isFinite(payload?.cols)
      ? Math.max(20, Math.min(500, Math.floor(payload.cols)))
      : 120;
    const rows = Number.isFinite(payload?.rows)
      ? Math.max(5, Math.min(200, Math.floor(payload.rows)))
      : 35;

    try {
      session.process.resize(cols, rows);
    } catch {
      // Ignore resize errors.
    }
  });

  ipcMain.handle("terminal:kill", async (event, sessionId) => {
    if (!Number.isInteger(sessionId)) {
      return false;
    }

    const session = terminalSessions.get(sessionId);
    if (!session || session.senderId !== event.sender.id) {
      return false;
    }

    cleanupTerminalSession(session);
    return true;
  });

  ipcMain.handle("extensions:load", async (event, workspacePath) => {
    if (typeof workspacePath !== "string" || workspacePath.length === 0) {
      const runtime = getExtensionRuntimeState(event.sender.id);
      await disposeExtensionRuntime(runtime);
      return serializeExtensionRuntime(runtime);
    }

    return loadExtensionsForWorkspace(event.sender.id, workspacePath);
  });

  ipcMain.handle("extensions:createBaseplate", async (event, payload) => {
    const workspacePath =
      payload && typeof payload.workspacePath === "string"
        ? payload.workspacePath
        : "";

    if (!workspacePath) {
      throw new Error("A workspace path is required.");
    }

    const extensionId =
      payload && typeof payload.extensionId === "string"
        ? payload.extensionId
        : "";

    const created = await createExtensionBaseplate(workspacePath, extensionId);
    const runtime = await loadExtensionsForWorkspace(
      event.sender.id,
      workspacePath
    );

    return {
      created,
      runtime,
    };
  });

  ipcMain.handle("extensions:executeCommand", async (event, payload) => {
    const commandId =
      payload && typeof payload.commandId === "string" ? payload.commandId : "";

    if (!commandId) {
      throw new Error("A command id is required.");
    }

    const runtime = getExtensionRuntimeState(event.sender.id);
    const command = runtime.commands.get(commandId);

    if (!command) {
      throw new Error(`Command not found: ${commandId}`);
    }

    const args = payload && Array.isArray(payload.args) ? payload.args : [];
    const result = await Promise.resolve(command.handler(...args));

    return {
      ok: true,
      result: result ?? null,
    };
  });
};

const createWindow = () => {
  const windowOptions = {
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: "#10131a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  };

  if (isMac) {
    windowOptions.titleBarStyle = "hiddenInset";
  } else if (process.platform === "win32") {
    windowOptions.titleBarStyle = "hidden";
    windowOptions.titleBarOverlay = {
      color: "#111625",
      symbolColor: "#d7deed",
      height: 44,
    };
  }

  const mainWindow = new BrowserWindow(windowOptions);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (targetUrl === currentUrl) {
      return;
    }

    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol === "file:" || parsed.protocol === "devtools:") {
        return;
      }
    } catch {
      return;
    }

    event.preventDefault();
    void openExternalUrl(targetUrl);
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    const isReloadShortcut =
      key === "f5" || ((input.control || input.meta) && key === "r");

    if (isReloadShortcut) {
      event.preventDefault();
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  return mainWindow;
};

app.whenReady().then(() => {
  registerIpcHandlers();
  const mainWindow = createWindow();
  buildMenu(mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const activatedWindow = createWindow();
      buildMenu(activatedWindow);
    }
  });
});

app.on("web-contents-created", (_event, contents) => {
  contents.once("destroyed", () => {
    cleanupTerminalSessionsForSender(contents.id);
    stopWatchingWorkspace(contents.id);

    const runtime = extensionRuntimesByWebContentsId.get(contents.id);
    if (runtime) {
      void disposeExtensionRuntime(runtime);
      extensionRuntimesByWebContentsId.delete(contents.id);
    }
  });
});

app.on("before-quit", () => {
  for (const session of [...terminalSessions.values()]) {
    cleanupTerminalSession(session);
  }

  for (const webContentsId of [...workspaceWatchersByWebContentsId.keys()]) {
    stopWatchingWorkspace(webContentsId);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
