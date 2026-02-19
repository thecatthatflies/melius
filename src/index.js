const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
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
});

const getExtensionRuntimeState = (webContentsId) => {
  if (!extensionRuntimesByWebContentsId.has(webContentsId)) {
    extensionRuntimesByWebContentsId.set(
      webContentsId,
      createExtensionRuntimeState()
    );
  }

  return extensionRuntimesByWebContentsId.get(webContentsId);
};

const normalizePath = (value) => String(value || "").replace(/\\/g, "/");

const normalizeExternalUrl = (rawUrl) => {
  if (typeof rawUrl !== "string") {
    return "";
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return "";
  }

  const withProtocol = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;

  try {
    const parsed = new URL(withProtocol);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      return "";
    }

    return parsed.toString();
  } catch {
    return "";
  }
};

const openExternalUrl = async (rawUrl) => {
  const normalized = normalizeExternalUrl(rawUrl);
  if (!normalized) {
    return false;
  }

  try {
    await shell.openExternal(normalized);
    return true;
  } catch {
    return false;
  }
};

const disposeEntry = async (entry) => {
  if (!entry) {
    return;
  }

  if (typeof entry === "function") {
    await Promise.resolve(entry());
    return;
  }

  if (typeof entry.dispose === "function") {
    await Promise.resolve(entry.dispose());
  }
};

const disposeExtensionRuntime = async (runtime) => {
  for (const disposable of runtime.disposables.splice(0)) {
    try {
      await disposeEntry(disposable);
    } catch (error) {
      console.error(`Failed disposing extension resource: ${error.message}`);
    }
  }

  runtime.commands.clear();
  runtime.extensions = [];
  runtime.workspacePath = "";
};

const serializeExtensionRuntime = (runtime) => ({
  workspacePath: runtime.workspacePath,
  extensions: runtime.extensions.map((extension) => ({
    ...extension,
    commands: Array.isArray(extension.commands) ? extension.commands : [],
  })),
  commands: [...runtime.commands.values()].map((command) => ({
    id: command.id,
    title: command.title,
    extensionId: command.extensionId,
  })),
});

const sanitizeExtensionId = (rawValue) => {
  const sanitized = String(rawValue || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized;
};

const formatExtensionName = (extensionId) =>
  extensionId
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ") || "Untitled Extension";

const coerceManifestCommands = (rawCommands, extensionId) => {
  if (!Array.isArray(rawCommands)) {
    return [];
  }

  return rawCommands
    .map((item, index) => {
      if (typeof item === "string") {
        const commandId = item.trim();
        if (!commandId) {
          return null;
        }

        return {
          id: commandId,
          title: commandId,
        };
      }

      if (!item || typeof item !== "object") {
        return null;
      }

      const suggestedId =
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `${extensionId}.command${index + 1}`;

      return {
        id: suggestedId,
        title:
          typeof item.title === "string" && item.title.trim()
            ? item.title.trim()
            : suggestedId,
      };
    })
    .filter(Boolean);
};

const listDirectory = async (directoryPath) => {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      path: path.join(directoryPath, entry.name),
      type: entry.isDirectory() ? "directory" : "file",
    }))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }

      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
};

const closeWorkspaceWatchState = (watchState) => {
  if (!watchState) {
    return;
  }

  if (watchState.rebuildTimer) {
    clearTimeout(watchState.rebuildTimer);
    watchState.rebuildTimer = null;
  }

  for (const watcher of watchState.watchers.values()) {
    try {
      watcher.close();
    } catch {
      // Ignore close errors.
    }
  }

  watchState.watchers.clear();
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
  if (!watchState || !watchState.rootPath || sender.isDestroyed()) {
    return;
  }

  if (watchState.rebuildTimer) {
    clearTimeout(watchState.rebuildTimer);
  }

  watchState.rebuildTimer = setTimeout(() => {
    watchState.rebuildTimer = null;

    if (sender.isDestroyed() || !watchState.rootPath) {
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

    void scanAndWatchDirectories(watchState, sender);
  }, 220);
};

const scanAndWatchDirectories = async (watchState, sender) => {
  if (!watchState || !watchState.rootPath || sender.isDestroyed()) {
    return;
  }

  const stack = [watchState.rootPath];

  while (stack.length > 0 && !sender.isDestroyed()) {
    const directoryPath = stack.pop();
    if (!directoryPath || watchState.watchers.has(directoryPath)) {
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

          sender.send("workspace:changed", { path: changedPath });
          scheduleWorkspaceWatcherRebuild(watchState, sender);
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
  await scanAndWatchDirectories(watchState, sender);

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
          click: (_menuItem, focusedWindow) => {
            const targetWindow =
              focusedWindow || BrowserWindow.getFocusedWindow();
            if (targetWindow && !targetWindow.isDestroyed()) {
              targetWindow.webContents.send("menu:save-file");
            }
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
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
  if (!force && Array.isArray(shellProfilesCache) && shellProfilesCache.length) {
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
        env: process.env,
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
  try {
    childProcess = spawn(selectedProfile.path, selectedProfile.args, {
      cwd,
      env: process.env,
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
    if (targetUrl !== currentUrl) {
      event.preventDefault();
      void openExternalUrl(targetUrl);
    }
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
