const languageByExtension = new Map([
  ["c", "c"],
  ["cc", "cpp"],
  ["cpp", "cpp"],
  ["css", "css"],
  ["go", "go"],
  ["h", "c"],
  ["hpp", "cpp"],
  ["html", "html"],
  ["java", "java"],
  ["js", "javascript"],
  ["json", "json"],
  ["jsx", "javascript"],
  ["md", "markdown"],
  ["mjs", "javascript"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["sh", "shell"],
  ["sql", "sql"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["txt", "plaintext"],
  ["xml", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
]);

const ignoredSearchDirectories = new Set([".git", "node_modules"]);
const externalUrlPattern = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

const state = {
  platform: "linux",
  activePanel: "explorer-pane",
  rootPath: "",
  initialCwd: "",
  expandedDirectories: new Set(),
  directoryCache: new Map(),
  activeFilePath: "",
  openTabs: [],
  searchIndexRoot: "",
  searchIndex: [],
  searchResults: [],
  selectedSearchResult: 0,
  extensions: [],
  terminalProfiles: [],
  ptySupported: false,
  activeTerminalSessionId: null,
  terminalVisible: true,
};

const editorModels = new Map();
const savedVersionIds = new Map();

let monacoInstance;
let editor;
let welcomeModel;
let terminal;
let fitAddon;
let searchSequence = 0;
let treeRefreshTimer = null;
let folderSelectionUnsubscribe = () => {};
let saveRequestUnsubscribe = () => {};
let terminalDataUnsubscribe = () => {};
let terminalExitUnsubscribe = () => {};
let workspaceChangedUnsubscribe = () => {};

const elements = {
  activityButtons: Array.from(document.querySelectorAll(".activity-button")),
  createExtensionButton: document.getElementById("create-extension-button"),
  editorContainer: document.getElementById("editor-container"),
  editorStack: document.getElementById("editor-stack"),
  editorTabs: document.getElementById("editor-tabs"),
  extensionIdInput: document.getElementById("extension-id-input"),
  extensionsList: document.getElementById("extensions-list"),
  extensionsPane: document.getElementById("extensions-pane"),
  explorerPane: document.getElementById("explorer-pane"),
  fileTree: document.getElementById("file-tree"),
  mainArea: document.getElementById("main-area"),
  reloadExtensionsButton: document.getElementById("reload-extensions-button"),
  rootLabel: document.getElementById("root-label"),
  searchClearButton: document.getElementById("search-clear-button"),
  searchInput: document.getElementById("global-search-input"),
  searchResults: document.getElementById("search-results"),
  searchShell: document.getElementById("search-shell"),
  statusBar: document.getElementById("status-bar"),
  terminalCloseButton: document.getElementById("terminal-close-button"),
  terminalContainer: document.getElementById("terminal-container"),
  terminalRestartButton: document.getElementById("terminal-restart-button"),
  terminalShellSelect: document.getElementById("terminal-shell-select"),
  terminalSplitter: document.getElementById("terminal-splitter"),
  terminalToggleButton: document.getElementById("terminal-toggle-button"),
  verticalSplitter: document.getElementById("vertical-splitter"),
};

const basename = (fullPath) => {
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : fullPath;
};

const normalizePath = (value) => String(value || "").replace(/\\/g, "/");

const relativePath = (fullPath) => {
  if (!state.rootPath) {
    return fullPath;
  }

  const normalizedRoot = normalizePath(state.rootPath);
  const normalizedPath = normalizePath(fullPath);

  if (normalizedPath === normalizedRoot) {
    return basename(fullPath);
  }

  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return fullPath;
};

const detectLanguage = (filePath) => {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith("dockerfile")) {
    return "dockerfile";
  }

  const extensionMatch = lowerPath.match(/\.([^.\\/]+)$/);
  if (!extensionMatch) {
    return "plaintext";
  }

  return languageByExtension.get(extensionMatch[1]) || "plaintext";
};

const getFileIconClass = (filePath) => {
  const extensionMatch = filePath.toLowerCase().match(/\.([^.\\/]+)$/);
  const extension = extensionMatch ? extensionMatch[1] : "";

  if (
    extension &&
    ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(extension)
  ) {
    return "fa-regular fa-file-image";
  }

  if (extension && ["mp4", "mov", "avi", "mkv"].includes(extension)) {
    return "fa-regular fa-file-video";
  }

  if (extension && ["zip", "gz", "tar", "7z", "rar"].includes(extension)) {
    return "fa-regular fa-file-zipper";
  }

  if (extension && ["md", "txt", "rst"].includes(extension)) {
    return "fa-regular fa-file-lines";
  }

  if (
    extension &&
    [
      "js",
      "ts",
      "jsx",
      "tsx",
      "json",
      "go",
      "rs",
      "py",
      "java",
      "cpp",
      "cc",
      "c",
      "h",
      "hpp",
      "css",
      "html",
      "xml",
      "sh",
      "sql",
      "yaml",
      "yml",
    ].includes(extension)
  ) {
    return "fa-regular fa-file-code";
  }

  return "fa-regular fa-file";
};

const getTreeIconClass = (entryPath, entryType, expanded = false) => {
  if (entryType === "directory") {
    return expanded ? "fa-regular fa-folder-open" : "fa-regular fa-folder";
  }

  return getFileIconClass(entryPath);
};

const isExternalUrl = (value) =>
  typeof value === "string" && /^(https?:\/\/|mailto:)/i.test(value.trim());

const createIconElement = (classes, extraClass = "") => {
  const icon = document.createElement("i");
  icon.className = `${classes}${extraClass ? ` ${extraClass}` : ""}`;
  icon.setAttribute("aria-hidden", "true");
  return icon;
};

const setStatus = (message, isError = false) => {
  elements.statusBar.textContent = message;
  elements.statusBar.style.background = isError
    ? "linear-gradient(90deg, #6d2432, #591a28)"
    : "linear-gradient(90deg, #20487a, #1b3f6b 35%, #1f3f68)";
  elements.statusBar.style.borderTopColor = isError ? "#a23d51" : "#2e507f";
};

const openExternalLink = async (url) => {
  const ok = await window.workbench.openExternal(url);
  if (!ok) {
    setStatus(`Unable to open URL: ${url}`, true);
  }
};

const appendLinkifiedText = (target, text) => {
  target.textContent = "";

  const source = String(text || "");
  externalUrlPattern.lastIndex = 0;

  let lastIndex = 0;
  let match;

  while ((match = externalUrlPattern.exec(source)) !== null) {
    const [url] = match;
    if (match.index > lastIndex) {
      target.appendChild(
        document.createTextNode(source.slice(lastIndex, match.index))
      );
    }

    const anchor = document.createElement("a");
    anchor.className = "inline-link";
    anchor.href = url;
    anchor.textContent = url;
    anchor.rel = "noreferrer noopener";
    anchor.target = "_blank";
    target.appendChild(anchor);

    lastIndex = match.index + url.length;
  }

  if (lastIndex < source.length) {
    target.appendChild(document.createTextNode(source.slice(lastIndex)));
  }
};

const setTerminalVisible = (visible) => {
  state.terminalVisible = Boolean(visible);
  document.body.classList.toggle("terminal-hidden", !state.terminalVisible);
  elements.terminalToggleButton.classList.toggle(
    "active",
    state.terminalVisible
  );

  if (state.terminalVisible) {
    void startTerminalSession({ clear: false, preserveIfRunning: true });
  }

  requestAnimationFrame(layoutWorkbench);
};

const isFileDirty = (filePath) => {
  if (!filePath || !editorModels.has(filePath)) {
    return false;
  }

  const model = editorModels.get(filePath);
  return savedVersionIds.get(filePath) !== model.getAlternativeVersionId();
};

const sendTerminalResize = () => {
  if (
    !state.terminalVisible ||
    !terminal ||
    !state.activeTerminalSessionId ||
    terminal.cols <= 0 ||
    terminal.rows <= 0
  ) {
    return;
  }

  window.workbench.resizeTerminalSession(
    state.activeTerminalSessionId,
    terminal.cols,
    terminal.rows
  );
};

const layoutWorkbench = () => {
  if (editor) {
    editor.layout();
  }

  if (fitAddon && terminal && state.terminalVisible) {
    fitAddon.fit();
    sendTerminalResize();
  }
};

const setupSplitter = (splitterElement, orientation) => {
  splitterElement.addEventListener("pointerdown", (event) => {
    if (orientation === "horizontal" && !state.terminalVisible) {
      return;
    }

    event.preventDefault();
    splitterElement.classList.add("dragging");

    const onMove = (moveEvent) => {
      if (orientation === "vertical") {
        const mainRect = elements.mainArea.getBoundingClientRect();
        const activityRect = document
          .getElementById("activity-bar")
          .getBoundingClientRect();
        const minWidth = 200;
        const maxWidth = Math.max(
          minWidth,
          mainRect.width - activityRect.width - 260
        );

        const rawWidth = moveEvent.clientX - mainRect.left - activityRect.width;
        const nextWidth = Math.min(Math.max(rawWidth, minWidth), maxWidth);

        document.documentElement.style.setProperty(
          "--sidebar-width",
          `${Math.round(nextWidth)}px`
        );
      } else {
        const stackRect = elements.editorStack.getBoundingClientRect();
        const minHeight = 120;
        const maxHeight = Math.max(minHeight, stackRect.height - 180);

        const rawHeight = stackRect.bottom - moveEvent.clientY;
        const nextHeight = Math.min(Math.max(rawHeight, minHeight), maxHeight);

        document.documentElement.style.setProperty(
          "--terminal-height",
          `${Math.round(nextHeight)}px`
        );
      }

      layoutWorkbench();
    };

    const onUp = () => {
      splitterElement.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      layoutWorkbench();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
};

const setActivePanel = (panelId) => {
  state.activePanel = panelId;

  elements.activityButtons.forEach((button) => {
    const isActive = button.dataset.panel === panelId;
    button.classList.toggle("active", isActive);
  });

  elements.explorerPane.classList.toggle("active", panelId === "explorer-pane");
  elements.extensionsPane.classList.toggle(
    "active",
    panelId === "extensions-pane"
  );
};

const renderFileEntries = (entries, depth, targetNode) => {
  entries.forEach((entry) => {
    const isDirectory = entry.type === "directory";
    const isExpanded = isDirectory && state.expandedDirectories.has(entry.path);

    const row = document.createElement("div");
    row.className = `tree-item${
      entry.type === "file" && entry.path === state.activeFilePath
        ? " selected"
        : ""
    }`;
    row.style.paddingLeft = `${10 + depth * 15}px`;

    const arrow = document.createElement("span");
    arrow.className = "tree-arrow";
    if (isDirectory) {
      arrow.appendChild(
        createIconElement(
          isExpanded ? "fa-solid fa-chevron-down" : "fa-solid fa-chevron-right"
        )
      );
    }

    const icon = createIconElement(
      getTreeIconClass(entry.path, entry.type, isExpanded),
      "tree-icon"
    );

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;

    row.append(arrow, icon, name);
    row.addEventListener("click", () => {
      if (isDirectory) {
        void toggleDirectory(entry.path);
      } else {
        void openFile(entry.path);
      }
    });

    targetNode.appendChild(row);

    if (isExpanded) {
      const childEntries = state.directoryCache.get(entry.path) || [];
      renderFileEntries(childEntries, depth + 1, targetNode);
    }
  });
};

const renderFileTree = () => {
  elements.fileTree.innerHTML = "";

  if (!state.rootPath) {
    const empty = document.createElement("div");
    empty.className = "empty-explorer";
    empty.textContent = "Open a folder from File > Open Folder.";
    elements.fileTree.appendChild(empty);
    return;
  }

  const rootEntries = state.directoryCache.get(state.rootPath) || [];
  if (rootEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-explorer";
    empty.textContent = "This folder is empty.";
    elements.fileTree.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  renderFileEntries(rootEntries, 0, fragment);
  elements.fileTree.appendChild(fragment);
};

const renderTabs = () => {
  elements.editorTabs.innerHTML = "";

  state.openTabs.forEach((filePath) => {
    const tabButton = document.createElement("button");
    tabButton.type = "button";
    tabButton.className = `editor-tab${
      filePath === state.activeFilePath ? " active" : ""
    }`;

    const icon = createIconElement(
      getFileIconClass(filePath),
      "editor-tab-icon"
    );

    const name = document.createElement("span");
    name.className = "editor-tab-name";
    name.textContent = basename(filePath);

    tabButton.append(icon, name);

    if (isFileDirty(filePath)) {
      const dirty = document.createElement("span");
      dirty.className = "editor-tab-dirty";
      tabButton.appendChild(dirty);
    }

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "editor-tab-close";
    closeButton.setAttribute("aria-label", `Close ${basename(filePath)}`);
    closeButton.appendChild(createIconElement("fa-solid fa-xmark"));

    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeTab(filePath);
    });

    tabButton.addEventListener("click", () => {
      void activateTab(filePath);
    });

    tabButton.appendChild(closeButton);
    elements.editorTabs.appendChild(tabButton);
  });
};

const renderExtensions = () => {
  elements.extensionsList.innerHTML = "";

  if (!state.rootPath) {
    const empty = document.createElement("div");
    empty.className = "extension-empty";
    empty.textContent = "Open a folder to load workspace extensions.";
    elements.extensionsList.appendChild(empty);
    return;
  }

  if (state.extensions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "extension-empty";
    empty.textContent = "No extensions found in .melius/extensions.";
    elements.extensionsList.appendChild(empty);
    return;
  }

  state.extensions.forEach((extension) => {
    const card = document.createElement("div");
    card.className = "extension-card";

    const header = document.createElement("div");
    header.className = "extension-card-header";

    const nameGroup = document.createElement("div");

    const name = document.createElement("div");
    name.className = "extension-name";
    name.textContent = extension.name;

    const meta = document.createElement("div");
    meta.className = "extension-meta";
    meta.textContent = `${extension.id} • v${extension.version}`;

    nameGroup.append(name, meta);

    const status = document.createElement("span");
    status.className = `extension-status${
      extension.status === "error" ? " error" : ""
    }`;
    status.textContent = extension.status === "error" ? "Error" : "Loaded";

    header.append(nameGroup, status);
    card.appendChild(header);

    if (extension.description) {
      const description = document.createElement("div");
      description.className = "extension-description";
      appendLinkifiedText(description, extension.description);
      card.appendChild(description);
    }

    if (extension.error) {
      const error = document.createElement("div");
      error.className = "extension-description";
      error.style.color = "#ffb8c2";
      error.textContent = extension.error;
      card.appendChild(error);
    }

    if (Array.isArray(extension.commands) && extension.commands.length > 0) {
      const commands = document.createElement("div");
      commands.className = "extension-command-list";

      extension.commands.forEach((command) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "extension-command-button";
        button.textContent = command.title || command.id;
        button.addEventListener("click", () => {
          void executeExtensionCommand(command.id);
        });
        commands.appendChild(button);
      });

      card.appendChild(commands);
    }

    elements.extensionsList.appendChild(card);
  });
};

const ensureDirectoryLoaded = async (directoryPath) => {
  if (state.directoryCache.has(directoryPath)) {
    return state.directoryCache.get(directoryPath);
  }

  const entries = await window.workbench.listDirectory(directoryPath);
  state.directoryCache.set(directoryPath, entries);
  return entries;
};

const toggleDirectory = async (directoryPath) => {
  try {
    if (state.expandedDirectories.has(directoryPath)) {
      state.expandedDirectories.delete(directoryPath);
      renderFileTree();
      return;
    }

    state.expandedDirectories.add(directoryPath);
    await ensureDirectoryLoaded(directoryPath);
    renderFileTree();
  } catch (error) {
    setStatus(`Failed to read folder: ${error.message}`, true);
  }
};

const clearEditorModels = () => {
  for (const model of editorModels.values()) {
    model.dispose();
  }

  editorModels.clear();
  savedVersionIds.clear();
};

const getOrCreateModel = async (filePath) => {
  if (editorModels.has(filePath)) {
    return editorModels.get(filePath);
  }

  const content = await window.workbench.readFile(filePath);
  const uri = monacoInstance.Uri.file(filePath);
  const model = monacoInstance.editor.createModel(
    content,
    detectLanguage(filePath),
    uri
  );

  editorModels.set(filePath, model);
  savedVersionIds.set(filePath, model.getAlternativeVersionId());
  return model;
};

const showWelcomeModel = () => {
  state.activeFilePath = "";

  if (editor && welcomeModel) {
    editor.setModel(welcomeModel);
  }

  renderTabs();
  renderFileTree();
  layoutWorkbench();
};

const activateTab = async (filePath) => {
  if (!filePath) {
    return;
  }

  try {
    const model = await getOrCreateModel(filePath);

    if (!state.openTabs.includes(filePath)) {
      state.openTabs.push(filePath);
    }

    editor.setModel(model);
    state.activeFilePath = filePath;

    renderTabs();
    renderFileTree();
    layoutWorkbench();
    setStatus(`Opened ${relativePath(filePath)}`);
  } catch (error) {
    setStatus(`Unable to open file: ${error.message}`, true);
  }
};

const openFile = async (filePath) => activateTab(filePath);

const closeTab = async (filePath) => {
  const tabIndex = state.openTabs.indexOf(filePath);
  if (tabIndex === -1) {
    return;
  }

  const wasActive = state.activeFilePath === filePath;
  state.openTabs.splice(tabIndex, 1);

  if (state.openTabs.length === 0) {
    showWelcomeModel();
    setStatus(`Closed ${relativePath(filePath)}`);
    return;
  }

  if (wasActive) {
    const nextIndex = Math.min(tabIndex, state.openTabs.length - 1);
    await activateTab(state.openTabs[nextIndex]);
    return;
  }

  renderTabs();
  renderFileTree();
  setStatus(`Closed ${relativePath(filePath)}`);
};

const saveActiveFile = async () => {
  if (!state.activeFilePath || !editor || !editor.getModel()) {
    setStatus("No active file to save.", true);
    return;
  }

  try {
    const model = editor.getModel();
    await window.workbench.writeFile(state.activeFilePath, model.getValue());
    savedVersionIds.set(state.activeFilePath, model.getAlternativeVersionId());
    renderTabs();
    setStatus(`Saved ${relativePath(state.activeFilePath)}`);
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, true);
  }
};

const invalidateCachesForChange = (changedPath) => {
  if (!changedPath) {
    state.directoryCache.clear();
    state.searchIndexRoot = "";
    state.searchIndex = [];
    return;
  }

  const normalizedChanged = normalizePath(changedPath);

  for (const cachePath of [...state.directoryCache.keys()]) {
    const normalizedCachePath = normalizePath(cachePath);

    if (
      normalizedCachePath === normalizedChanged ||
      normalizedCachePath.startsWith(`${normalizedChanged}/`) ||
      normalizedChanged.startsWith(`${normalizedCachePath}/`)
    ) {
      state.directoryCache.delete(cachePath);
    }
  }

  state.searchIndexRoot = "";
  state.searchIndex = [];
};

const refreshVisibleTree = async () => {
  if (!state.rootPath) {
    return;
  }

  const expanded = [...state.expandedDirectories].sort((a, b) =>
    a.localeCompare(b)
  );

  for (const directoryPath of expanded) {
    try {
      await ensureDirectoryLoaded(directoryPath);
    } catch {
      state.expandedDirectories.delete(directoryPath);
      state.directoryCache.delete(directoryPath);
    }
  }

  renderFileTree();
};

const scheduleTreeRefresh = () => {
  if (treeRefreshTimer) {
    return;
  }

  treeRefreshTimer = setTimeout(() => {
    treeRefreshTimer = null;
    void refreshVisibleTree();
  }, 120);
};

const buildSearchIndex = async () => {
  if (!state.rootPath) {
    return [];
  }

  if (state.searchIndexRoot === state.rootPath) {
    return state.searchIndex;
  }

  const files = [];
  const stack = [state.rootPath];

  while (stack.length > 0) {
    const currentDirectory = stack.pop();
    const entries = await ensureDirectoryLoaded(currentDirectory);

    entries.forEach((entry) => {
      if (entry.type === "directory") {
        if (!ignoredSearchDirectories.has(entry.name)) {
          stack.push(entry.path);
        }
      } else {
        files.push(entry.path);
      }
    });
  }

  state.searchIndexRoot = state.rootPath;
  state.searchIndex = files;
  return files;
};

const getSearchScore = (filePath, query) => {
  const name = basename(filePath).toLowerCase();
  const rel = relativePath(filePath).toLowerCase();

  if (name === query) {
    return 0;
  }

  if (name.startsWith(query)) {
    return 1;
  }

  if (name.includes(query)) {
    return 2;
  }

  if (rel.includes(query)) {
    return 3;
  }

  return Number.POSITIVE_INFINITY;
};

const findSearchMatches = async (query) => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const files = await buildSearchIndex();

  return files
    .map((filePath) => ({
      filePath,
      score: getSearchScore(filePath, normalizedQuery),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      return relativePath(left.filePath).localeCompare(
        relativePath(right.filePath),
        undefined,
        {
          numeric: true,
          sensitivity: "base",
        }
      );
    })
    .slice(0, 30)
    .map((entry) => entry.filePath);
};

const hideSearchResults = () => {
  elements.searchResults.classList.remove("visible");
  elements.searchResults.innerHTML = "";
  state.searchResults = [];
  state.selectedSearchResult = 0;
};

const renderSearchEmptyState = (message) => {
  elements.searchResults.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "search-results-empty";
  empty.textContent = message;
  elements.searchResults.appendChild(empty);
  elements.searchResults.classList.add("visible");
};

const renderSearchResults = () => {
  elements.searchResults.innerHTML = "";

  if (state.searchResults.length === 0) {
    renderSearchEmptyState("No matching files.");
    return;
  }

  state.searchResults.forEach((filePath, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `search-result-item${
      index === state.selectedSearchResult ? " active" : ""
    }`;

    const icon = createIconElement(
      getFileIconClass(filePath),
      "search-result-icon"
    );

    const text = document.createElement("span");

    const name = document.createElement("span");
    name.className = "search-result-name";
    name.textContent = basename(filePath);

    const relPath = document.createElement("span");
    relPath.className = "search-result-path";
    relPath.textContent = relativePath(filePath);

    text.append(name, relPath);
    item.append(icon, text);

    item.addEventListener("mouseenter", () => {
      state.selectedSearchResult = index;
      renderSearchResults();
    });

    item.addEventListener("click", () => {
      void openSearchResult(index);
    });

    elements.searchResults.appendChild(item);
  });

  elements.searchResults.classList.add("visible");
};

const openSearchResult = async (index) => {
  const selectedPath = state.searchResults[index];
  if (!selectedPath) {
    return;
  }

  await openFile(selectedPath);
  elements.searchInput.value = "";
  hideSearchResults();
  elements.searchInput.blur();
};

const moveSearchSelection = (direction) => {
  if (state.searchResults.length === 0) {
    return;
  }

  const next =
    (state.selectedSearchResult + direction + state.searchResults.length) %
    state.searchResults.length;

  state.selectedSearchResult = next;
  renderSearchResults();
};

const runSearch = async (query) => {
  const normalized = query.trim();
  const currentSequence = ++searchSequence;

  if (!normalized) {
    hideSearchResults();
    return;
  }

  if (!state.rootPath) {
    renderSearchEmptyState("Open a folder first to search files.");
    return;
  }

  renderSearchEmptyState("Searching...");

  const matches = await findSearchMatches(normalized);
  if (currentSequence !== searchSequence) {
    return;
  }

  state.searchResults = matches;
  state.selectedSearchResult = 0;
  renderSearchResults();
};

const terminalInfo = (message) => {
  if (!terminal) {
    return;
  }

  terminal.writeln(`\x1b[90m${message}\x1b[0m`);
};

const renderShellProfiles = () => {
  elements.terminalShellSelect.innerHTML = "";

  state.terminalProfiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.label;
    elements.terminalShellSelect.appendChild(option);
  });

  elements.terminalShellSelect.disabled = state.terminalProfiles.length === 0;
};

const loadTerminalProfiles = async () => {
  const profileResponse = await window.workbench.listTerminalProfiles();
  state.terminalProfiles = Array.isArray(profileResponse.profiles)
    ? profileResponse.profiles
    : [];
  state.ptySupported = Boolean(profileResponse.ptySupported);

  renderShellProfiles();
};

const registerTerminalLinks = () => {
  if (!terminal || typeof terminal.registerLinkProvider !== "function") {
    return;
  }

  terminal.registerLinkProvider({
    provideLinks: (lineNumber, callback) => {
      const line = terminal.buffer.active.getLine(lineNumber - 1);
      if (!line) {
        callback([]);
        return;
      }

      const text = line.translateToString(true);
      externalUrlPattern.lastIndex = 0;

      const links = [];
      let match;

      while ((match = externalUrlPattern.exec(text)) !== null) {
        const url = match[0];
        const startX = match.index + 1;
        const endX = startX + url.length;

        links.push({
          range: {
            start: { x: startX, y: lineNumber },
            end: { x: endX, y: lineNumber },
          },
          text: url,
          activate: (event, textValue) => {
            if (!event || (!event.ctrlKey && !event.metaKey)) {
              terminalInfo("Use Ctrl/Cmd+Click to open links.");
              return;
            }

            void openExternalLink(textValue);
          },
        });
      }

      callback(links);
    },
  });
};

const startTerminalSession = async ({
  clear = true,
  preserveIfRunning = false,
} = {}) => {
  if (
    !terminal ||
    state.terminalProfiles.length === 0 ||
    !state.terminalVisible
  ) {
    return;
  }

  if (preserveIfRunning && state.activeTerminalSessionId) {
    layoutWorkbench();
    terminal.focus();
    return;
  }

  if (state.activeTerminalSessionId) {
    await window.workbench.killTerminalSession(state.activeTerminalSessionId);
    state.activeTerminalSessionId = null;
  }

  const selectedProfileId =
    elements.terminalShellSelect.value || state.terminalProfiles[0].id;

  const cwd = state.rootPath || state.initialCwd || ".";

  try {
    const session = await window.workbench.createTerminalSession({
      profileId: selectedProfileId,
      cwd,
      cols: terminal.cols || 120,
      rows: terminal.rows || 35,
    });

    state.activeTerminalSessionId = session.sessionId;

    if (clear) {
      terminal.clear();
    }

    terminal.focus();
    terminalInfo(
      `Started ${session.profile.label}${
        session.ptySupported ? "" : " (fallback mode)"
      }`
    );
    layoutWorkbench();
  } catch (error) {
    terminalInfo(`Unable to start terminal: ${error.message}`);
    setStatus(`Terminal failed: ${error.message}`, true);
  }
};

const setupTerminal = () => {
  if (!window.Terminal || !window.FitAddon || !window.FitAddon.FitAddon) {
    setStatus("xterm terminal libraries failed to load.", true);
    return;
  }

  terminal = new window.Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontFamily: "Cascadia Code",
    fontSize: 13,
    lineHeight: 1.35,
    theme: {
      background: "#0b1120",
      foreground: "#d4deef",
      cursor: "#8fb8ff",
      selectionBackground: "#275fa44c",
      black: "#1d2a3f",
      red: "#f38f98",
      green: "#4fd1b6",
      yellow: "#f2c97d",
      blue: "#63a9ff",
      magenta: "#c38fff",
      cyan: "#67d7ea",
      white: "#e6eefc",
      brightBlack: "#6d7f9d",
      brightRed: "#ffb0ba",
      brightGreen: "#77e7cd",
      brightYellow: "#ffe1a2",
      brightBlue: "#90c3ff",
      brightMagenta: "#ddb5ff",
      brightCyan: "#95e8f4",
      brightWhite: "#ffffff",
    },
  });

  fitAddon = new window.FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(elements.terminalContainer);
  fitAddon.fit();
  registerTerminalLinks();

  terminal.onData((data) => {
    if (!state.activeTerminalSessionId) {
      return;
    }

    window.workbench.writeTerminalData(state.activeTerminalSessionId, data);
  });

  terminal.onResize(({ cols, rows }) => {
    if (!state.activeTerminalSessionId) {
      return;
    }

    window.workbench.resizeTerminalSession(
      state.activeTerminalSessionId,
      cols,
      rows
    );
  });

  terminalDataUnsubscribe = window.workbench.onTerminalData((payload) => {
    if (!payload || payload.sessionId !== state.activeTerminalSessionId) {
      return;
    }

    terminal.write(payload.data || "");
  });

  terminalExitUnsubscribe = window.workbench.onTerminalExit((payload) => {
    if (!payload || payload.sessionId !== state.activeTerminalSessionId) {
      return;
    }

    const exitCode =
      typeof payload.exitCode === "number"
        ? payload.exitCode
        : payload.signal || "unknown";

    terminalInfo(`Process exited (${exitCode})`);
    state.activeTerminalSessionId = null;
  });
};

const refreshExtensions = async () => {
  if (!state.rootPath) {
    state.extensions = [];
    renderExtensions();
    return;
  }

  try {
    const runtime = await window.workbench.loadExtensions(state.rootPath);
    state.extensions = Array.isArray(runtime.extensions)
      ? runtime.extensions
      : [];
    renderExtensions();
    setStatus(`Loaded ${state.extensions.length} extension(s).`);
  } catch (error) {
    setStatus(`Extension load failed: ${error.message}`, true);
  }
};

const executeExtensionCommand = async (commandId) => {
  if (!commandId) {
    return;
  }

  try {
    const result = await window.workbench.executeExtensionCommand(
      commandId,
      []
    );
    const output =
      result && Object.prototype.hasOwnProperty.call(result, "result")
        ? result.result
        : null;

    if (output !== null && output !== undefined) {
      terminalInfo(`[extension] ${commandId} -> ${String(output)}`);
    } else {
      terminalInfo(`[extension] ${commandId} executed`);
    }

    setStatus(`Executed ${commandId}`);
  } catch (error) {
    terminalInfo(`[extension error] ${error.message}`);
    setStatus(`Command failed: ${error.message}`, true);
  }
};

const createExtensionBaseplate = async () => {
  if (!state.rootPath) {
    setStatus("Open a folder before creating an extension.", true);
    return;
  }

  try {
    const response = await window.workbench.createExtensionBaseplate({
      workspacePath: state.rootPath,
      extensionId: elements.extensionIdInput.value.trim(),
    });

    elements.extensionIdInput.value = "";

    if (
      response &&
      response.runtime &&
      Array.isArray(response.runtime.extensions)
    ) {
      state.extensions = response.runtime.extensions;
      renderExtensions();
    } else {
      await refreshExtensions();
    }

    setStatus(`Created extension ${response.created.extensionId}`);
    setActivePanel("extensions-pane");
  } catch (error) {
    setStatus(`Baseplate creation failed: ${error.message}`, true);
  }
};

const openFolder = async (folderPath) => {
  if (!folderPath) {
    return;
  }

  try {
    await window.workbench.unwatchWorkspace();

    state.rootPath = folderPath;
    state.expandedDirectories = new Set([folderPath]);
    state.directoryCache = new Map();
    state.openTabs = [];
    state.searchIndexRoot = "";
    state.searchIndex = [];
    state.searchResults = [];
    state.selectedSearchResult = 0;

    clearEditorModels();

    elements.rootLabel.textContent = folderPath;

    elements.searchInput.value = "";
    hideSearchResults();

    await ensureDirectoryLoaded(folderPath);

    showWelcomeModel();
    renderFileTree();

    await window.workbench.watchWorkspace(folderPath);

    setStatus(`Folder opened: ${folderPath}`);

    void refreshExtensions();
    if (state.terminalVisible) {
      void startTerminalSession({ clear: true });
    }
  } catch (error) {
    setStatus(`Unable to open folder: ${error.message}`, true);
  }
};

const loadMonaco = () =>
  new Promise((resolve, reject) => {
    if (window.monaco) {
      resolve(window.monaco);
      return;
    }

    if (!window.require) {
      reject(new Error("Monaco loader is unavailable."));
      return;
    }

    const monacoBaseUrl = new URL(
      "../node_modules/monaco-editor/min/",
      window.location.href
    ).toString();

    window.MonacoEnvironment = {
      getWorkerUrl: () => {
        const workerSource = `self.MonacoEnvironment = { baseUrl: ${JSON.stringify(
          monacoBaseUrl
        )} };importScripts(${JSON.stringify(
          `${monacoBaseUrl}vs/base/worker/workerMain.js`
        )});`;

        return `data:text/javascript;charset=utf-8,${encodeURIComponent(workerSource)}`;
      },
    };

    window.require.config({
      paths: {
        vs: `${monacoBaseUrl}vs`,
      },
    });

    window.require(
      ["vs/editor/editor.main"],
      () => resolve(window.monaco),
      reject
    );
  });

const getUrlAtModelPosition = (model, position) => {
  if (!model || !position) {
    return "";
  }

  const line = model.getLineContent(position.lineNumber);
  externalUrlPattern.lastIndex = 0;

  let match;
  while ((match = externalUrlPattern.exec(line)) !== null) {
    const url = match[0];
    const start = match.index + 1;
    const end = start + url.length;

    if (position.column >= start && position.column <= end) {
      return url;
    }
  }

  return "";
};

const applyPlatformClass = () => {
  const platform =
    window.workbench && typeof window.workbench.platform === "string"
      ? window.workbench.platform
      : "linux";

  state.platform = platform;
  document.body.classList.add(`os-${platform}`);
};

const setupEvents = () => {
  elements.activityButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setActivePanel(button.dataset.panel);
    });
  });

  elements.reloadExtensionsButton.addEventListener("click", () => {
    void refreshExtensions();
  });

  elements.createExtensionButton.addEventListener("click", () => {
    void createExtensionBaseplate();
  });

  elements.extensionIdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void createExtensionBaseplate();
    }
  });

  elements.terminalRestartButton.addEventListener("click", () => {
    void startTerminalSession({ clear: false });
  });

  elements.terminalShellSelect.addEventListener("change", () => {
    void startTerminalSession({ clear: true });
  });

  elements.terminalCloseButton.addEventListener("click", () => {
    setTerminalVisible(false);
  });

  elements.terminalToggleButton.addEventListener("click", () => {
    setTerminalVisible(!state.terminalVisible);
  });

  elements.searchInput.addEventListener("input", () => {
    void runSearch(elements.searchInput.value);
  });

  elements.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSearchSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSearchSelection(-1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      void openSearchResult(state.selectedSearchResult);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      elements.searchInput.value = "";
      hideSearchResults();
      elements.searchInput.blur();
    }
  });

  elements.searchClearButton.addEventListener("click", () => {
    elements.searchInput.value = "";
    hideSearchResults();
    elements.searchInput.focus();
  });

  document.addEventListener("mousedown", (event) => {
    if (!elements.searchShell.contains(event.target)) {
      hideSearchResults();
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const anchor = target.closest("a[href]");
    if (!anchor) {
      return;
    }

    event.preventDefault();

    if (!(event.ctrlKey || event.metaKey)) {
      setStatus("Use Ctrl/Cmd+Click to open links.");
      return;
    }

    void openExternalLink(anchor.href);
  });

  window.addEventListener("resize", layoutWorkbench);
  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();

    if ((event.metaKey || event.ctrlKey) && key === "s") {
      event.preventDefault();
      void saveActiveFile();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && key === "k") {
      event.preventDefault();
      elements.searchInput.focus();
      elements.searchInput.select();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && key === "r") {
      event.preventDefault();
      return;
    }

    if (event.key === "F5") {
      event.preventDefault();
    }
  });

  setupSplitter(elements.verticalSplitter, "vertical");
  setupSplitter(elements.terminalSplitter, "horizontal");

  folderSelectionUnsubscribe = window.workbench.onFolderSelected(
    (folderPath) => {
      void openFolder(folderPath);
    }
  );

  saveRequestUnsubscribe = window.workbench.onSaveRequested(() => {
    void saveActiveFile();
  });

  workspaceChangedUnsubscribe = window.workbench.onWorkspaceChanged(
    (payload) => {
      if (!state.rootPath || !payload || typeof payload.path !== "string") {
        return;
      }

      const normalizedRoot = normalizePath(state.rootPath);
      const normalizedPath = normalizePath(payload.path);

      if (!normalizedPath.startsWith(normalizedRoot)) {
        return;
      }

      invalidateCachesForChange(payload.path);
      scheduleTreeRefresh();
    }
  );
};

const initialize = async () => {
  if (!window.workbench) {
    throw new Error("Workbench API is unavailable in this renderer.");
  }

  const originalWindowOpen = window.open.bind(window);
  window.open = (url, ...args) => {
    if (typeof url === "string" && isExternalUrl(url)) {
      void openExternalLink(url);
      return null;
    }

    return originalWindowOpen(url, ...args);
  };

  applyPlatformClass();
  setupEvents();
  setActivePanel("explorer-pane");
  setTerminalVisible(true);

  monacoInstance = await loadMonaco();

  welcomeModel = monacoInstance.editor.createModel(
    "// Open a folder and select a file from the explorer.\n",
    "plaintext"
  );

  editor = monacoInstance.editor.create(elements.editorContainer, {
    model: welcomeModel,
    theme: "vs-dark",
    minimap: { enabled: false },
    smoothScrolling: true,
    fontSize: 13,
    fontFamily: "Cascadia Code",
    scrollBeyondLastLine: false,
    automaticLayout: false,
    links: true,
  });

  editor.onDidChangeModelContent(() => {
    renderTabs();
  });

  editor.onMouseDown((mouseEvent) => {
    if (!(mouseEvent.event.metaKey || mouseEvent.event.ctrlKey)) {
      return;
    }

    const model = editor.getModel();
    const url = getUrlAtModelPosition(model, mouseEvent.target.position);
    if (url && isExternalUrl(url)) {
      void openExternalLink(url);
    }
  });

  state.initialCwd = await window.workbench.getInitialCwd();

  setupTerminal();

  renderFileTree();
  renderTabs();
  renderExtensions();
  setStatus("Ready");
  layoutWorkbench();

  void (async () => {
    await loadTerminalProfiles();
    await startTerminalSession({ clear: true });
    terminalInfo("Terminal ready. Use Ctrl/Cmd+Click to open links.");
  })();
};

window.addEventListener("beforeunload", () => {
  if (treeRefreshTimer) {
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = null;
  }

  if (state.activeTerminalSessionId) {
    void window.workbench.killTerminalSession(state.activeTerminalSessionId);
  }

  void window.workbench.unwatchWorkspace();

  folderSelectionUnsubscribe();
  saveRequestUnsubscribe();
  terminalDataUnsubscribe();
  terminalExitUnsubscribe();
  workspaceChangedUnsubscribe();
});

void initialize().catch((error) => {
  setStatus(`Initialization failed: ${error.message}`, true);
  if (terminal) {
    terminalInfo(error.message);
  }
});
