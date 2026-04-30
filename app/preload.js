'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings:       ()      => ipcRenderer.invoke('settings:get'),
  saveSettings:      (s)     => ipcRenderer.invoke('settings:set', s),

  // Dialogs
  openFile:          (f)     => ipcRenderer.invoke('dialog:open-file', f),
  openDirectory:     ()      => ipcRenderer.invoke('dialog:open-directory'),

  // File helpers
  saveBookTxtContent:   (c)  => ipcRenderer.invoke('files:save-book-txt-content', c),
  getImageList:         (d)  => ipcRenderer.invoke('files:get-image-list', d),
  copyImagesOrdered:    (a)  => ipcRenderer.invoke('files:copy-images-ordered', a),
  bookTxtExists:        ()   => ipcRenderer.invoke('files:book-txt-exists'),
  pagesExist:           ()   => ipcRenderer.invoke('files:pages-exist'),

  // Shell
  openOutput:        ()      => ipcRenderer.invoke('shell:open-output'),
  openMusicFolder:   ()      => ipcRenderer.invoke('shell:open-music-folder'),

  // Builds
  buildBook:         (opts)  => ipcRenderer.invoke('build:book', opts),
  buildVideo:        (opts)  => ipcRenderer.invoke('build:video', opts),
  cancelBuild:       ()      => ipcRenderer.invoke('build:cancel'),

  // Events from main → renderer
  onBuildLog:        (cb)    => ipcRenderer.on('build:log',    (_, msg) => cb(msg)),
  offBuildLog:       ()      => ipcRenderer.removeAllListeners('build:log'),

  // Setup window events
  onSetupLog:        (cb)    => ipcRenderer.on('setup:log',    (_, msg) => cb(msg)),
  onSetupStatus:     (cb)    => ipcRenderer.on('setup:status', (_, msg) => cb(msg)),
  onSetupError:      (cb)    => ipcRenderer.on('setup:error',  (_, msg) => cb(msg)),
});
