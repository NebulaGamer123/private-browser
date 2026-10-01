const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onOpenUrlInTab: (callback) => ipcRenderer.on('open-url-in-tab', (event, url) => callback(url)),
  openIsolatedSessionWindow: () => ipcRenderer.invoke('open-isolated-session-window'),
  openPopoutWindow: (url, title) => ipcRenderer.invoke('open-popout-window', url, title),
  togglePopoutAlwaysOnTop: (windowId) => ipcRenderer.invoke('toggle-popout-always-on-top', windowId),
  openDownload: (filePath) => ipcRenderer.invoke('open-download', filePath),

  // General (non-YouTube) file downloads — fired for every download,
  // regardless of which tab/site/partition triggered it.
  onDownloadStarted: (callback) => ipcRenderer.on('download-started', (event, data) => callback(data)),
  onDownloadUpdated: (callback) => ipcRenderer.on('download-updated', (event, data) => callback(data)),
  onDownloadCompleted: (callback) => ipcRenderer.on('download-completed', (event, data) => callback(data)),

  // YouTube (yt-dlp) download progress/log — separate channel, unrelated to
  // the general download tracking above.
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
  onDownloadLog: (callback) => ipcRenderer.on('download-log', (event, data) => callback(data)),
  downloadYoutubeVideo: (url, format) => ipcRenderer.invoke('download-youtube-video', url, format),
  checkYtDlp: () => ipcRenderer.invoke('check-yt-dlp'),

  updateSettings: (settings) => ipcRenderer.send('update-settings', settings),

  // Context-menu actions
  copyImageAt: (webContentsId, x, y) => ipcRenderer.invoke('copy-image-at', webContentsId, x, y),
  saveImageAs: (webContentsId, imageUrl) => ipcRenderer.invoke('save-image-as', webContentsId, imageUrl),

  // Cookie whitelist cleanup
  clearPartitionData: (partitionName) => ipcRenderer.invoke('clear-partition-data', partitionName),

  // Data page (search activity dashboard) — hotkey fires from main process
  onOpenDataPage: (cb) => ipcRenderer.on('open-data-page', () => cb()),

  // Shared search history sync (network calls run in main to avoid CORS)
  getDeviceName: () => ipcRenderer.invoke('get-device-name'),
  syncPush:   (entries) => ipcRenderer.invoke('sync-push', entries),
  syncFetch:  ()        => ipcRenderer.invoke('sync-fetch'),
  syncDelete: (id)      => ipcRenderer.invoke('sync-delete', id),
  syncClear:  ()        => ipcRenderer.invoke('sync-clear'),

  platform: process.platform
})
