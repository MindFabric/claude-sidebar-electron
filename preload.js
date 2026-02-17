const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claude', {
  // Environment
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getAppSourceDir: () => ipcRenderer.invoke('get-app-source-dir'),

  // Terminal
  createTerminal: (opts) => ipcRenderer.invoke('terminal-create', opts),
  sendInput: (id, data) => ipcRenderer.send('terminal-input', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', { id, cols, rows }),
  destroyTerminal: (id) => ipcRenderer.send('terminal-destroy', { id }),
  isTerminalActive: (tabId) => ipcRenderer.invoke('terminal-is-active', { id: tabId }),
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (event, { id, data }) => callback(id, data));
  },

  // State
  saveState: (state) => ipcRenderer.invoke('save-state', state),
  loadState: () => ipcRenderer.invoke('load-state'),
  onSaveState: (callback) => ipcRenderer.on('save-state', callback),

  // Self-modification
  resetAppSource: () => ipcRenderer.invoke('reset-app-source'),
  onHotReloadCss: (callback) => ipcRenderer.on('hot-reload-css', callback),

  // Dialogs
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
