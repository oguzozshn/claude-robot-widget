'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('robot', {
  onState: (cb) => ipcRenderer.on('state', (_e, payload) => cb(payload)),
  onConfig: (cb) => ipcRenderer.on('config', (_e, payload) => cb(payload)),

  menu: () => ipcRenderer.invoke('menu'),

  dragStart: () => ipcRenderer.invoke('drag-start'),
  dragMove: (x, y) => ipcRenderer.send('drag-move', { x, y }),
  dragEnd: () => ipcRenderer.send('drag-end'),

  setIgnore: (ignore) => ipcRenderer.send('set-ignore', ignore)
});
