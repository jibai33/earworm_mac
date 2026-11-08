'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ewMini', {
  onState: (cb) => ipcRenderer.on('mini:state', (_e, state) => cb(state)),
  onFlags: (cb) => ipcRenderer.on('mini:flags', (_e, flags) => cb(flags)),
  initialState: () => ipcRenderer.invoke('ew:mini-state'),
  send: (cmd) => ipcRenderer.send('ew:mini-command', cmd),
  action: (name) => ipcRenderer.send('ew:mini-action', name),
  seek: (ratio) => ipcRenderer.send('ew:mini-seek', ratio),
});
