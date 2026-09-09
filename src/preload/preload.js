'use strict';

/** レンダラーへ公開する最小限のAPI(contextIsolation有効・sandbox有効)。 */

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = [
  'job:start',
  'job:progress',
  'job:done',
  'log:entry',
  'settings:changed',
  'shortcuts:state',
  'ui:focus-section',
];

contextBridge.exposeInMainWorld('api', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  addGame: (partial) => ipcRenderer.invoke('game:add', partial),
  updateGame: (id, patch) => ipcRenderer.invoke('game:update', { id, patch }),
  removeGame: (gameId) => ipcRenderer.invoke('game:remove', gameId),
  setActiveGame: (gameId) => ipcRenderer.invoke('game:setActive', gameId),

  pickFolder: (options) => ipcRenderer.invoke('dialog:pickFolder', options),
  validatePath: (target) => ipcRenderer.invoke('path:validate', target),
  openPath: (target) => ipcRenderer.invoke('shell:open', target),
  openLog: () => ipcRenderer.invoke('shell:openLog'),

  runJob: (direction) => ipcRenderer.invoke('job:run', direction),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  getJobStatus: () => ipcRenderer.invoke('job:status'),

  listSnapshots: () => ipcRenderer.invoke('snapshots:list'),

  buildAccelerator: (keyEvent) => ipcRenderer.invoke('accelerator:build', keyEvent),
  formatAccelerator: (accelerator) => ipcRenderer.invoke('accelerator:format', accelerator),
  suspendShortcuts: () => ipcRenderer.invoke('shortcuts:suspend'),
  resumeShortcuts: () => ipcRenderer.invoke('shortcuts:resume'),

  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  /** メインプロセスからのイベント購読。解除用の関数を返す。 */
  on: (channel, listener) => {
    if (!EVENTS.includes(channel)) throw new Error(`未許可のチャンネルです: ${channel}`);
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
