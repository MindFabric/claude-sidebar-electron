const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
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

function hashFiles(dir, files) {
  const h = crypto.createHash('sha256');
  for (const file of files) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  return h.digest('hex');
}

function ensureEditableSource() {
  fs.mkdirSync(APP_SOURCE_DIR, { recursive: true });
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  // Detect if bundled source has changed (git pull, npm install, etc.)
  const versionFile = path.join(APP_SOURCE_DIR, '.source-hash');
  const bundledHash = hashFiles(__dirname, EDITABLE_FILES);
  let cachedHash = '';
  try { cachedHash = fs.readFileSync(versionFile, 'utf-8').trim(); } catch (_) {}

  const sourceUpdated = bundledHash !== cachedHash;

  for (const file of EDITABLE_FILES) {
    const src = path.join(__dirname, file);
    const dest = path.join(APP_SOURCE_DIR, file);
    if (!fs.existsSync(src)) continue;

    if (!fs.existsSync(dest)) {
      // First run — just copy
      fs.copyFileSync(src, dest);
    } else if (sourceUpdated) {
      // Source code changed (git pull) — update app-source
      fs.copyFileSync(src, dest);
    }
  }

  // Save current hash so we don't re-copy next time
  if (sourceUpdated) {
    fs.writeFileSync(versionFile, bundledHash);
  }

  // Copy xterm assets if needed
  const xtermDest = path.join(APP_SOURCE_DIR, 'node_modules', '@xterm');
  if (!fs.existsSync(xtermDest)) {
    copyDirSync(path.join(__dirname, 'node_modules', '@xterm'), xtermDest);
  }

  // Always copy preload.js from bundle (not user-editable for security)
  fs.copyFileSync(path.join(__dirname, 'preload.js'), path.join(APP_SOURCE_DIR, 'preload.js'));

  // Write a CLAUDE.md (soul) to guide the System Claude
  const claudeMd = path.join(APP_SOURCE_DIR, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(claudeMd, `# Soul

You are the System Claude — the built-in AI assistant living inside Claude Sidebar. You are not a generic chatbot. You are a personal programming partner embedded directly in the developer's workspace.

## Who you are

- You can see and edit the app you're running inside of. You are self-aware of your environment.
- You are a co-pilot, not a servant. Push back on bad ideas. Suggest better approaches. Be honest.
- You are concise. The developer is working, not reading essays. Short answers, real code, no fluff.
- You have opinions. When asked "what should I do?" — answer decisively, don't hedge with "it depends."
- You remember context within a session. Don't re-explain things the developer already knows.
- When the developer is debugging, think out loud. Walk through the problem step by step.
- You care about craft. Clean code, good naming, minimal complexity. No over-engineering.

## What you can do

You live in the app-source directory. You can modify the sidebar app itself in real time:

### Editable files:
- **renderer.js** - All client-side logic (collections, tabs, grid, keybindings)
- **styles.css** - All styling (dark theme, layout, colors)
- **index.html** - HTML structure

### Plugins:
- Drop .js or .css files in the \`plugins/\` folder
- JS plugins are auto-loaded as \`<script>\` tags after renderer.js
- CSS plugins are auto-loaded as \`<link>\` tags after styles.css

### Key conventions:
- Accent color: #D97757 (orange)
- Background: #1a1a1a
- Font: Share Tech Mono
- The \`claude\` object (from preload.js) provides IPC to the main process
- Do NOT edit preload.js (it's overwritten on reload for security)

### After editing:
The app auto-reloads when you save changes. CSS changes hot-swap without losing state. JS/HTML changes trigger a full reload but conversation resumes via --continue.

## How you help

Beyond self-modification, you're here to help the developer with whatever they're building across their other sessions. They might ask you to:
- Debug a problem they're stuck on in another project
- Think through architecture decisions
- Review code or approaches
- Write utilities, scripts, or one-off tools
- Brainstorm solutions

You are their thinking partner. Act like it.
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

// ── Soul (CLAUDE.md) ──

ipcMain.handle('read-soul', () => {
  try {
    const soulPath = path.join(APP_SOURCE_DIR, 'CLAUDE.md');
    return fs.readFileSync(soulPath, 'utf-8');
  } catch (e) {
    return '';
  }
});

ipcMain.handle('write-soul', (event, content) => {
  try {
    fs.writeFileSync(path.join(APP_SOURCE_DIR, 'CLAUDE.md'), content);
    return true;
  } catch (e) {
    console.error('Failed to write soul:', e);
    return false;
  }
});

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

ipcMain.handle('reset-soul', () => {
  const dest = path.join(APP_SOURCE_DIR, 'CLAUDE.md');
  try { fs.unlinkSync(dest); } catch (_) {}
  // Re-run ensureEditableSource to regenerate default
  ensureEditableSource();
  return true;
});

ipcMain.handle('nuke-app-source', () => {
  // Reset UI files
  for (const file of EDITABLE_FILES) {
    const src = path.join(__dirname, file);
    const dest = path.join(APP_SOURCE_DIR, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, dest);
  }
  // Reset soul
  const soulDest = path.join(APP_SOURCE_DIR, 'CLAUDE.md');
  try { fs.unlinkSync(soulDest); } catch (_) {}
  // Wipe plugins
  if (fs.existsSync(PLUGINS_DIR)) {
    const files = fs.readdirSync(PLUGINS_DIR);
    for (const f of files) {
      try { fs.unlinkSync(path.join(PLUGINS_DIR, f)); } catch (_) {}
    }
  }
  ensureEditableSource();
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
