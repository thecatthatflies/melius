const languageByExtension = new Map([
  ['c', 'c'],
  ['cc', 'cpp'],
  ['cpp', 'cpp'],
  ['css', 'css'],
  ['go', 'go'],
  ['h', 'c'],
  ['hpp', 'cpp'],
  ['html', 'html'],
  ['java', 'java'],
  ['js', 'javascript'],
  ['json', 'json'],
  ['jsx', 'javascript'],
  ['md', 'markdown'],
  ['mjs', 'javascript'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['rs', 'rust'],
  ['sh', 'shell'],
  ['sql', 'sql'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['txt', 'plaintext'],
  ['xml', 'xml'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
]);

const state = {
  rootPath: '',
  expandedDirectories: new Set(),
  directoryCache: new Map(),
  activeFilePath: '',
  terminalCwd: '',
  isDirty: false,
};

const editorModels = new Map();
const savedVersionIds = new Map();

let monacoInstance;
let editor;
let folderSelectionUnsubscribe = () => {};
let saveRequestUnsubscribe = () => {};

const elements = {
  activeFileLabel: document.getElementById('active-file-label'),
  clearTerminalButton: document.getElementById('clear-terminal-button'),
  editorContainer: document.getElementById('editor-container'),
  fileTree: document.getElementById('file-tree'),
  horizontalSplitter: document.getElementById('horizontal-splitter'),
  openFolderButton: document.getElementById('open-folder-button'),
  rootLabel: document.getElementById('root-label'),
  statusBar: document.getElementById('status-bar'),
  terminalForm: document.getElementById('terminal-form'),
  terminalInput: document.getElementById('terminal-input'),
  terminalOutput: document.getElementById('terminal-output'),
  terminalPrompt: document.getElementById('terminal-prompt'),
  verticalSplitter: document.getElementById('vertical-splitter'),
  workspace: document.getElementById('workspace'),
};

const basename = (fullPath) => {
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : fullPath;
};

const detectLanguage = (filePath) => {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith('dockerfile')) {
    return 'dockerfile';
  }

  const extensionMatch = lowerPath.match(/\.([^.\\/]+)$/);
  if (!extensionMatch) {
    return 'plaintext';
  }

  const extension = extensionMatch[1];
  return languageByExtension.get(extension) || 'plaintext';
};

const getPromptLabel = () => {
  if (!state.terminalCwd) {
    return '$';
  }

  return `${basename(state.terminalCwd)}$`;
};

const setStatus = (message, isError = false) => {
  elements.statusBar.textContent = message;
  elements.statusBar.style.background = isError
    ? 'linear-gradient(90deg, #8f2d35, #7e2129)'
    : 'linear-gradient(90deg, #0f6dcf, #0f5eaf)';
  elements.statusBar.style.borderTopColor = isError ? '#d35c62' : '#2d93ff';
};

const appendTerminalLine = (content, kind = '') => {
  const line = document.createElement('div');
  line.className = `terminal-line${kind ? ` ${kind}` : ''}`;
  line.textContent = content;
  elements.terminalOutput.appendChild(line);
  elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
};

const updateTerminalPrompt = () => {
  elements.terminalPrompt.textContent = getPromptLabel();
};

const updateActiveFileLabel = () => {
  if (!state.activeFilePath) {
    elements.activeFileLabel.textContent = 'No file selected';
    return;
  }

  elements.activeFileLabel.textContent = `${state.activeFilePath}${
    state.isDirty ? ' *' : ''
  }`;
};

const updateDirtyState = () => {
  const model = editor ? editor.getModel() : null;
  if (!model || !state.activeFilePath) {
    state.isDirty = false;
    updateActiveFileLabel();
    return;
  }

  const savedVersion = savedVersionIds.get(state.activeFilePath);
  state.isDirty = savedVersion !== model.getAlternativeVersionId();
  updateActiveFileLabel();
};

const layoutEditor = () => {
  if (editor) {
    editor.layout();
  }
};

const setupSplitter = (splitterElement, orientation) => {
  splitterElement.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    splitterElement.classList.add('dragging');

    const onMove = (moveEvent) => {
      const workspaceRect = elements.workspace.getBoundingClientRect();

      if (orientation === 'vertical') {
        const minWidth = 170;
        const maxWidth = Math.max(minWidth, workspaceRect.width - 260);
        const nextWidth = Math.min(
          Math.max(moveEvent.clientX - workspaceRect.left, minWidth),
          maxWidth,
        );
        document.documentElement.style.setProperty(
          '--sidebar-width',
          `${Math.round(nextWidth)}px`,
        );
      } else {
        const minHeight = 120;
        const maxHeight = Math.max(minHeight, workspaceRect.height - 160);
        const nextHeight = Math.min(
          Math.max(workspaceRect.bottom - moveEvent.clientY, minHeight),
          maxHeight,
        );
        document.documentElement.style.setProperty(
          '--terminal-height',
          `${Math.round(nextHeight)}px`,
        );
      }

      layoutEditor();
    };

    const onUp = () => {
      splitterElement.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      layoutEditor();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
};

const renderFileEntries = (entries, depth, targetNode) => {
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = `tree-item${
      entry.type === 'file' && entry.path === state.activeFilePath ? ' selected' : ''
    }`;
    row.style.paddingLeft = `${10 + depth * 14}px`;

    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';

    if (entry.type === 'directory') {
      const expanded = state.expandedDirectories.has(entry.path);
      arrow.textContent = expanded ? 'v' : '>';
      icon.textContent = 'dir';
    } else {
      arrow.textContent = '';
      icon.textContent = 'file';
    }

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = entry.name;

    row.append(arrow, icon, name);
    row.addEventListener('click', () => {
      if (entry.type === 'directory') {
        void toggleDirectory(entry.path);
      } else {
        void openFile(entry.path);
      }
    });

    targetNode.appendChild(row);

    if (entry.type === 'directory' && state.expandedDirectories.has(entry.path)) {
      const childEntries = state.directoryCache.get(entry.path) || [];
      renderFileEntries(childEntries, depth + 1, targetNode);
    }
  });
};

const renderFileTree = () => {
  elements.fileTree.innerHTML = '';

  if (!state.rootPath) {
    const empty = document.createElement('div');
    empty.className = 'empty-explorer';
    empty.textContent = 'Open a folder from File > Open Folder.';
    elements.fileTree.appendChild(empty);
    return;
  }

  const rootEntries = state.directoryCache.get(state.rootPath) || [];
  if (rootEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-explorer';
    empty.textContent = 'This folder is empty.';
    elements.fileTree.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  renderFileEntries(rootEntries, 0, fragment);
  elements.fileTree.appendChild(fragment);
};

const ensureDirectoryLoaded = async (directoryPath) => {
  if (state.directoryCache.has(directoryPath)) {
    return;
  }

  const entries = await window.workbench.listDirectory(directoryPath);
  state.directoryCache.set(directoryPath, entries);
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

const getOrCreateModel = (filePath, content) => {
  if (editorModels.has(filePath)) {
    return editorModels.get(filePath);
  }

  const uri = monacoInstance.Uri.file(filePath);
  const model = monacoInstance.editor.createModel(
    content,
    detectLanguage(filePath),
    uri,
  );

  editorModels.set(filePath, model);
  savedVersionIds.set(filePath, model.getAlternativeVersionId());
  return model;
};

const openFile = async (filePath) => {
  try {
    const content = await window.workbench.readFile(filePath);
    const model = getOrCreateModel(filePath, content);

    editor.setModel(model);
    state.activeFilePath = filePath;
    state.isDirty =
      savedVersionIds.get(filePath) !== model.getAlternativeVersionId();

    renderFileTree();
    updateActiveFileLabel();
    layoutEditor();
    setStatus(`Opened ${filePath}`);
  } catch (error) {
    setStatus(`Unable to open file: ${error.message}`, true);
  }
};

const saveActiveFile = async () => {
  if (!state.activeFilePath || !editor || !editor.getModel()) {
    setStatus('No active file to save.', true);
    return;
  }

  try {
    const model = editor.getModel();
    await window.workbench.writeFile(state.activeFilePath, model.getValue());
    savedVersionIds.set(state.activeFilePath, model.getAlternativeVersionId());
    state.isDirty = false;
    updateActiveFileLabel();
    setStatus(`Saved ${state.activeFilePath}`);
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, true);
  }
};

const openFolder = async (folderPath) => {
  if (!folderPath) {
    return;
  }

  try {
    state.rootPath = folderPath;
    state.expandedDirectories = new Set([folderPath]);
    state.directoryCache = new Map();
    state.terminalCwd = folderPath;
    state.activeFilePath = '';
    state.isDirty = false;

    elements.rootLabel.textContent = folderPath;
    updateTerminalPrompt();
    updateActiveFileLabel();

    await ensureDirectoryLoaded(folderPath);
    renderFileTree();
    appendTerminalLine(`Opened folder: ${folderPath}`, 'meta');
    setStatus(`Folder opened: ${folderPath}`);
  } catch (error) {
    setStatus(`Unable to open folder: ${error.message}`, true);
  }
};

const runTerminalCommand = async (command) => {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return;
  }

  appendTerminalLine(`${getPromptLabel()} ${trimmedCommand}`, 'prompt');
  elements.terminalInput.value = '';
  elements.terminalInput.disabled = true;

  try {
    const result = await window.workbench.runTerminalCommand(
      trimmedCommand,
      state.terminalCwd,
    );

    if (typeof result.cwd === 'string' && result.cwd.length > 0) {
      state.terminalCwd = result.cwd;
      updateTerminalPrompt();
    }

    if (result.output) {
      appendTerminalLine(result.output);
    }

    if (result.error) {
      appendTerminalLine(result.error, 'error');
    }

    appendTerminalLine(`[exit ${result.exitCode}]`, 'meta');
  } catch (error) {
    appendTerminalLine(error.message, 'error');
  } finally {
    elements.terminalInput.disabled = false;
    elements.terminalInput.focus();
  }
};

const loadMonaco = () =>
  new Promise((resolve, reject) => {
    if (window.monaco) {
      resolve(window.monaco);
      return;
    }

    if (!window.require) {
      reject(new Error('Monaco loader is unavailable.'));
      return;
    }

    const monacoBaseUrl = new URL(
      '../node_modules/monaco-editor/min/',
      window.location.href,
    ).toString();

    window.MonacoEnvironment = {
      getWorkerUrl: () => {
        const workerSource = `self.MonacoEnvironment = { baseUrl: ${JSON.stringify(
          monacoBaseUrl,
        )} };importScripts(${JSON.stringify(
          `${monacoBaseUrl}vs/base/worker/workerMain.js`,
        )});`;
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(
          workerSource,
        )}`;
      },
    };

    window.require.config({
      paths: {
        vs: `${monacoBaseUrl}vs`,
      },
    });

    window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
  });

const setupEvents = () => {
  elements.openFolderButton.addEventListener('click', async () => {
    try {
      const folderPath = await window.workbench.openFolder();
      await openFolder(folderPath);
    } catch (error) {
      setStatus(`Unable to open folder picker: ${error.message}`, true);
    }
  });

  elements.terminalForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void runTerminalCommand(elements.terminalInput.value);
  });

  elements.clearTerminalButton.addEventListener('click', () => {
    elements.terminalOutput.innerHTML = '';
  });

  window.addEventListener('resize', layoutEditor);
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveActiveFile();
    }
  });

  setupSplitter(elements.verticalSplitter, 'vertical');
  setupSplitter(elements.horizontalSplitter, 'horizontal');

  folderSelectionUnsubscribe = window.workbench.onFolderSelected((folderPath) => {
    void openFolder(folderPath);
  });

  saveRequestUnsubscribe = window.workbench.onSaveRequested(() => {
    void saveActiveFile();
  });
};

const initialize = async () => {
  if (!window.workbench) {
    throw new Error('Workbench API is unavailable in this renderer.');
  }

  setupEvents();

  monacoInstance = await loadMonaco();
  editor = monacoInstance.editor.create(elements.editorContainer, {
    value: '// Open a folder and select a file from the explorer.\n',
    language: 'javascript',
    theme: 'vs-dark',
    minimap: { enabled: false },
    smoothScrolling: true,
    fontSize: 13,
    scrollBeyondLastLine: false,
    automaticLayout: false,
  });

  editor.onDidChangeModelContent(() => {
    updateDirtyState();
  });

  const initialCwd = await window.workbench.getInitialCwd();
  if (typeof initialCwd === 'string' && initialCwd.length > 0) {
    state.terminalCwd = initialCwd;
  }

  updateTerminalPrompt();
  renderFileTree();
  updateActiveFileLabel();

  appendTerminalLine('Terminal ready.', 'meta');
  setStatus('Ready');
  elements.terminalInput.focus();
};

window.addEventListener('beforeunload', () => {
  folderSelectionUnsubscribe();
  saveRequestUnsubscribe();
});

void initialize().catch((error) => {
  setStatus(`Initialization failed: ${error.message}`, true);
  appendTerminalLine(error.message, 'error');
});
