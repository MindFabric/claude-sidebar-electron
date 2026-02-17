const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const CLAUDE_CMD = process.env.CLAUDE_SIDEBAR_CMD || 'claude --dangerously-skip-permissions';
const STATE_DIR = path.join(app.getPath('userData'), 'state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// ── Editable app source ──
// On first run, copy UI files to a user-writable directory.
// The app loads from there so the System Claude can edit them live.
const APP_SOURCE_DIR = path.join(app.getPath('userData'), 'app-source');
const PLUGINS_DIR = path.join(APP_SOURCE_DIR, 'plugins');
const EDITABLE_FILES = ['renderer.js', 'styles.css', 'index.html'];

function ensureEditableSource() {
  fs.mkdirSync(APP_SOURCE_DIR, { recursive: true });
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  // Copy editable files if they don't exist yet (first run or reset)
  for (const file of EDITABLE_FILES) {
    const dest = path.join(APP_SOURCE_DIR, file);
    if (!fs.existsSync(dest)) {
      const src = path.join(__dirname, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    }
  }

  // Copy xterm assets if needed
  const xtermDest = path.join(APP_SOURCE_DIR, 'node_modules', '@xterm');
  if (!fs.existsSync(xtermDest)) {
    copyDirSync(path.join(__dirname, 'node_modules', '@xterm'), xtermDest);
  }

  // Always copy preload.js from bundle (not user-editable for security)
  fs.copyFileSync(path.join(__dirname, 'preload.js'), path.join(APP_SOURCE_DIR, 'preload.js'));

  // Write a CLAUDE.md to guide the System Claude
  const claudeMd = path.join(APP_SOURCE_DIR, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(claudeMd, `# Claude Sidebar - Editable Source

You are the System Claude for Claude Sidebar. You can modify the app's UI in real time.

## Editable files:
- **renderer.js** - All client-side logic (collections, tabs, grid, keybindings)
- **styles.css** - All styling (dark theme, layout, colors)
- **index.html** - HTML structure

## Plugins:
- Drop .js or .css files in the \`plugins/\` folder
- JS plugins are auto-loaded as <script> tags after renderer.js
- CSS plugins are auto-loaded as <link> tags after styles.css

## Key conventions:
- Accent color: #D97757 (orange)
- Background: #1a1a1a
- Font: Share Tech Mono
- The \`claude\` object (from preload.js) provides IPC to the main process
- Do NOT edit preload.js (it's overwritten on reload for security)

## After editing:
The app will auto-reload when you save changes. State is preserved across reloads.
`);
  }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

let mainWindow = null;
const terminals = new Map();
let fileWatcher = null;

// ── Platform helpers ──

function winToWslPath(winPath) {
  if (!winPath || !IS_WIN) return winPath;
  const m = winPath.match(/^([A-Za-z]):[/\\](.*)/);
  if (!m) return winPath;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

function createWindow() {
  ensureEditableSource();

  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    frame: false,
    backgroundColor: '#1a1a1a',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(APP_SOURCE_DIR, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load from editable source directory
  mainWindow.loadFile(path.join(APP_SOURCE_DIR, 'index.html'));
  mainWindow.maximize();

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.webContents.send('save-state');
    setTimeout(() => {
      destroyAllTerminals();
      stopFileWatcher();
      mainWindow.destroy();
    }, 300);
  });

  // Watch editable source for changes → hot reload
  startFileWatcher();
}

// ── File watcher for hot reload ──

function startFileWatcher() {
  stopFileWatcher();

  let debounce = null;
  fileWatcher = fs.watch(APP_SOURCE_DIR, { recursive: false }, (eventType, filename) => {
    if (!filename) return;
    // Only reload for editable files and plugins
    const isEditable = EDITABLE_FILES.includes(filename) || filename.endsWith('.css') || filename.endsWith('.js');
    if (!isEditable) return;

    // Debounce rapid saves
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        // For CSS-only changes, inject without full reload
        if (filename === 'styles.css') {
          mainWindow.webContents.send('hot-reload-css');
        } else {
          // Save state, then reload
          mainWindow.webContents.send('save-state');
          setTimeout(() => {
            mainWindow.webContents.reloadIgnoringCache();
          }, 200);
        }
      }
    }, 500);
  });

  // Also watch plugins dir
  if (fs.existsSync(PLUGINS_DIR)) {
    fs.watch(PLUGINS_DIR, (eventType, filename) => {
      if (!filename) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('save-state');
          setTimeout(() => mainWindow.webContents.reloadIgnoringCache(), 200);
        }
      }, 500);
    });
  }
}

function stopFileWatcher() {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

function destroyAllTerminals() {
  for (const [id, term] of terminals) {
    try { term.pty.kill(); } catch (_) {}
  }
  terminals.clear();
}

// ── Environment ──

ipcMain.handle('get-home-dir', () => os.homedir());
ipcMain.handle('get-platform', () => process.platform);
ipcMain.handle('get-app-source-dir', () => APP_SOURCE_DIR);

// ── Reset to defaults ──

ipcMain.handle('reset-app-source', () => {
  for (const file of EDITABLE_FILES) {
    const src = path.join(__dirname, file);
    const dest = path.join(APP_SOURCE_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }
  return true;
});

// ── Terminal management ──

ipcMain.handle('terminal-create', (event, { id, cwd, resume }) => {
  const home = os.homedir();
  const dir = cwd || home;

  const cleanEnv = { ...process.env, HOME: home };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  let ptyProcess;

  if (IS_WIN) {
    const wslDir = winToWslPath(dir);
    const claudeArg = resume
      ? `cd "${wslDir}" && ${CLAUDE_CMD} --continue; exec bash`
      : `cd "${wslDir}" && ${CLAUDE_CMD}; exec bash`;

    ptyProcess = pty.spawn('wsl.exe', ['bash', '-c', claudeArg], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: dir,
      env: cleanEnv,
    });
  } else {
    const shell = process.env.SHELL || '/bin/bash';
    const cmd = resume
      ? `cd "${dir}" && ${CLAUDE_CMD} --continue`
      : `cd "${dir}" && ${CLAUDE_CMD}`;

    ptyProcess = pty.spawn(shell, ['-c', `${cmd}; exec ${shell}`], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: dir,
      env: cleanEnv,
    });
  }

  let dataBytes = 0;
  let windowStart = Date.now();

  ptyProcess.onData((data) => {
    const now = Date.now();
    if (now - windowStart > 2000) {
      dataBytes = 0;
      windowStart = now;
    }
    dataBytes += data.length;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', { id, data });
    }
  });

  ptyProcess.onExit(() => {
    const term = terminals.get(id);
    if (term) term.alive = false;
  });

  terminals.set(id, {
    pty: ptyProcess,
    alive: true,
    isWorking: () => {
      return dataBytes > 500 && (Date.now() - windowStart) < 3000;
    },
  });
  return { id };
});

ipcMain.on('terminal-input', (event, { id, data }) => {
  const term = terminals.get(id);
  if (term && term.alive) {
    term.pty.write(data);
  }
});

ipcMain.on('terminal-resize', (event, { id, cols, rows }) => {
  const term = terminals.get(id);
  if (term && term.alive) {
    try { term.pty.resize(cols, rows); } catch (_) {}
  }
});

ipcMain.on('terminal-destroy', (event, { id }) => {
  const term = terminals.get(id);
  if (term) {
    try { term.pty.kill(); } catch (_) {}
    terminals.delete(id);
  }
});

ipcMain.handle('terminal-is-active', (event, { id }) => {
  const term = terminals.get(id);
  if (!term) return false;
  return term.isWorking();
});

// ── State persistence ──

ipcMain.handle('save-state', (event, state) => {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save state:', e);
    return false;
  }
});

ipcMain.handle('load-state', () => {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
});

// ── Folder picker ──

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'New Collection — Select Project Folder',
    defaultPath: os.homedir(),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ── App lifecycle ──

app.whenReady().then(() => {
  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  };

  if (IS_MAC) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      editMenu,
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { role: 'close' },
        ],
      },
    ]));
  } else {
    Menu.setApplicationMenu(Menu.buildFromTemplate([editMenu]));
  }

  createWindow();

  const toggleKey = IS_MAC ? 'Command+Shift+C' : 'Super+C';
  globalShortcut.register(toggleKey, () => {
    if (mainWindow.isVisible()) {
      mainWindow.webContents.send('save-state');
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.maximize();
      mainWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (!IS_MAC) app.quit();
});

app.on('will-quit', () => {
  destroyAllTerminals();
  stopFileWatcher();
  globalShortcut.unregisterAll();
});
