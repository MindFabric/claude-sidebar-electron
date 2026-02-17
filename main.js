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

let mainWindow = null;
const terminals = new Map(); // id -> { pty, alive }

// ── Platform helpers ──

// Convert Windows path to WSL path: C:\Users\foo → /mnt/c/Users/foo
function winToWslPath(winPath) {
  if (!winPath || !IS_WIN) return winPath;
  const m = winPath.match(/^([A-Za-z]):[/\\](.*)/);
  if (!m) return winPath;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    frame: false,
    backgroundColor: '#1a1a1a',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.maximize();

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.webContents.send('save-state');
    setTimeout(() => {
      destroyAllTerminals();
      mainWindow.destroy();
    }, 300);
  });
}

function destroyAllTerminals() {
  for (const [id, term] of terminals) {
    try { term.pty.kill(); } catch (_) {}
  }
  terminals.clear();
}

// ── Environment ──

ipcMain.handle('get-home-dir', () => {
  return os.homedir();
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

// ── Terminal management ──

ipcMain.handle('terminal-create', (event, { id, cwd, resume }) => {
  const home = os.homedir();
  const dir = cwd || home;

  // Strip Claude Code env vars so spawned sessions don't think they're nested
  const cleanEnv = { ...process.env, HOME: home };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  let ptyProcess;

  if (IS_WIN) {
    // Windows: spawn wsl.exe, run claude inside WSL
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
    // Linux / macOS: spawn shell directly
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

  // Track data volume over a rolling window to distinguish working vs idle
  // Claude working = large bursts of output; Claude idle = tiny TUI refreshes
  let dataBytes = 0;
  let windowStart = Date.now();

  ptyProcess.onData((data) => {
    const now = Date.now();
    // Reset window every 2 seconds
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
      // If >500 bytes in the current 2s window, Claude is actively working
      // Idle TUI refreshes are typically <100 bytes
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
  // Build menu - Mac needs full menu bar, Windows/Linux just needs Edit for clipboard
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

  // Global toggle hotkey: Super+C on Linux/Windows, Cmd+Shift+C on Mac
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

  // Mac: re-create window when dock icon clicked
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
  if (!IS_MAC) app.quit(); // Mac apps stay alive in dock
});

app.on('will-quit', () => {
  destroyAllTerminals();
  globalShortcut.unregisterAll();
});
