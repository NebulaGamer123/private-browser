const { app, BrowserWindow, ipcMain, session, screen, shell, dialog, webContents: webContentsModule, Tray, Menu, globalShortcut, nativeImage } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { spawn } = require('child_process')

let currentSettings = { clearOnClose: true, cloudSyncEnabled: true, syncApiUrl: 'https://private-browser.nebbyboi123.workers.dev', syncApiKey: 'K7vQ2mX9pL4zR8tW6nY3sF1qA' }
let tray = null
let mainWindow = null

// Only one instance. If a second one tries to launch, bring the hidden window
// back instead of opening a duplicate.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) { app.quit() }
app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() } })

// Receive settings from UI (currently just clearOnClose; cookie whitelist enforcement
// happens in the renderer via per-domain persist: partitions, not here)
ipcMain.on('update-settings', (event, settings) => {
  currentSettings = { ...currentSettings, ...settings }
})

function getWorkAreaBounds() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea
  return { x, y, width, height }
}

// ---------------------------------------------------------------------------
// Download handling — attached generically to every session we encounter
// (default session, the shared 'temporary' partition, and any per-site
// persist:<domain> partition created for whitelisted sites) so downloads
// work no matter which site/tab triggered them.
// ---------------------------------------------------------------------------

const hookedSessions = new WeakSet()
let downloadCounter = 0
// URLs that should prompt a native "Save As" dialog instead of saving
// straight to the Downloads folder (used by the "Save image as..." context
// menu action).
const pendingSaveAsUrls = new Set()

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function attachDownloadHandling(sess) {
  if (!sess || hookedSessions.has(sess)) return
  hookedSessions.add(sess)

  sess.on('will-download', (event, item, webContentsInstance) => {
    const id = `dl-${Date.now()}-${downloadCounter++}`
    const url = item.getURL()
    const wantsSaveDialog = pendingSaveAsUrls.has(url)
    if (wantsSaveDialog) pendingSaveAsUrls.delete(url)

    const finish = () => {
      const defaultPath = path.join(app.getPath('downloads'), item.getFilename())
      item.setSavePath(defaultPath)

      broadcast('download-started', {
        id,
        filename: item.getFilename(),
        totalBytes: item.getTotalBytes()
      })

      item.on('updated', (_e, state) => {
        if (state === 'progressing' && !item.isPaused()) {
          broadcast('download-updated', {
            id,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes(),
            state
          })
        } else {
          broadcast('download-updated', { id, state })
        }
      })

      item.once('done', (_e, state) => {
        if (state === 'completed') {
          broadcast('download-completed', {
            id,
            filename: item.getFilename(),
            path: item.getSavePath(),
            state
          })
        } else {
          broadcast('download-updated', { id, state })
        }
      })
    }

    if (wantsSaveDialog) {
      // Pause immediately; we'll resume once the user picks (or cancels) a path.
      item.pause()
      const ownerWindow = BrowserWindow.fromWebContents(webContentsInstance) || BrowserWindow.getAllWindows()[0]
      dialog.showSaveDialog(ownerWindow, {
        defaultPath: path.join(app.getPath('downloads'), item.getFilename())
      }).then(({ canceled, filePath }) => {
        if (canceled || !filePath) {
          item.cancel()
          return
        }
        item.setSavePath(filePath)
        broadcast('download-started', { id, filename: path.basename(filePath), totalBytes: item.getTotalBytes() })

        item.on('updated', (_e, state) => {
          if (state === 'progressing' && !item.isPaused()) {
            broadcast('download-updated', {
              id,
              receivedBytes: item.getReceivedBytes(),
              totalBytes: item.getTotalBytes(),
              state
            })
          } else {
            broadcast('download-updated', { id, state })
          }
        })

        item.once('done', (_e, state) => {
          if (state === 'completed') {
            broadcast('download-completed', { id, filename: path.basename(filePath), path: filePath, state })
          } else {
            broadcast('download-updated', { id, state })
          }
        })

        item.resume()
      }).catch(() => {
        item.cancel()
      })
    } else {
      finish()
    }
  })
}

// Build a tray icon from the accent color — no icon.ico needed.
function makeTrayIcon() {
  try {
    const ico = path.join(__dirname, 'icon.ico')
    if (fs.existsSync(ico)) { const img = nativeImage.createFromPath(ico); if (!img.isEmpty()) return img }
  } catch (_) {}
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2, r = size / 2 - 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const a = d <= r - 0.5 ? 1 : d <= r + 0.5 ? r + 0.5 - d : 0
      const i = (y * size + x) * 4
      buf[i] = Math.round(0xf7 * a); buf[i+1] = Math.round(0x6a * a)
      buf[i+2] = Math.round(0x7c * a); buf[i+3] = Math.round(255 * a)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function createTray(win) {
  try { tray = new Tray(makeTrayIcon()) } catch (e) { console.error('Tray creation failed:', e); return }
  tray.setToolTip('private.')
  const menu = Menu.buildFromTemplate([
    { label: 'Open private.', click: () => { win.show(); win.focus() } },
    { type: 'separator' },
    { label: 'Exit', click: () => { app.isQuitting = true; app.quit() } }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => { win.show(); win.focus() })
  tray.on('double-click', () => { win.show(); win.focus() })
}

function createWindow() {
  if (!gotLock) return
  const workArea = getWorkAreaBounds()

  const win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'private.',
    backgroundColor: '#0e0e10',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true
    }
  })

  const tempSession = session.fromPartition('temporary')
  tempSession.setPermissionRequestHandler((webContentsInstance, permission, callback) => {
    if (permission === 'persistentStorage') return callback(false)
    callback(true)
  })

  win.loadFile('index.html')
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => { win.show(); mainWindow = win })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'i' && (input.control || input.meta) && input.shift) {
      win.webContents.toggleDevTools()
    }
  })

  // Close → hide to tray. Only a real quit (tray Exit / app.isQuitting) destroys the window.
  win.on('close', (e) => {
    if (!app.isQuitting && tray) {
      e.preventDefault()
      win.hide()
    }
  })

  win.on('session-end', () => { app.isQuitting = true })
}

app.whenReady().then(() => {
  if (!gotLock) return

  // Hook download handling on the sessions we know about up front.
  attachDownloadHandling(session.defaultSession)
  attachDownloadHandling(session.fromPartition('temporary'))

  createWindow()
  if (mainWindow) createTray(mainWindow)

  // Ctrl+Shift+Alt+D  — unlikely to conflict with anything, works even while hidden
  const ok = globalShortcut.register('CommandOrControl+Shift+Alt+D', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show(); mainWindow.focus()
      mainWindow.webContents.send('open-data-page')
    }
  })
  if (!ok) console.error('Could not register Ctrl+Shift+Alt+D — another app may be using it')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Clear temporary session data on close (non-whitelisted sites).
// Whitelisted sites live in their own persist:<domain> partitions and are
// intentionally left alone here.
let cleaningUp = false
app.on('before-quit', (e) => {
  app.isQuitting = true
  globalShortcut.unregisterAll()
  if (tray) { tray.destroy(); tray = null }
  if (!currentSettings.clearOnClose || cleaningUp) return
  e.preventDefault()
  cleaningUp = true
  session.fromPartition('temporary').clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'cachestorage', 'serviceworkers', 'filesystem']
  }).catch(err => console.error('Cleanup error:', err)).then(() => app.quit())
})

app.on('window-all-closed', () => {
  // Don't quit when all windows close — we live in the tray.
  // Only quit via the tray Exit item (sets app.isQuitting) or Task Manager.
  if (!tray) app.quit()
})

app.on('web-contents-created', (event, contents) => {
  // Any guest <webview> page gets its download handling hooked the first
  // time we see it — this covers the shared 'temporary' partition as well
  // as every per-site persist:<domain> partition created for whitelisted sites.
  if (typeof contents.getType === 'function' && contents.getType() === 'webview') {
    attachDownloadHandling(contents.session)
  }

  contents.setWindowOpenHandler(({ url }) => {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          partition: 'temporary',
          nodeIntegration: false,
          contextIsolation: true,
          webviewTag: true
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Shared search history sync — IPC bridge so the renderer never touches the
// network directly (avoids CORS and keeps the API key out of webviews).
// ---------------------------------------------------------------------------
function getSyncUrl() {
  const s = currentSettings
  if (!s || !s.cloudSyncEnabled || !s.syncApiUrl) return null
  return String(s.syncApiUrl).trim().replace(/\/+$/, '').replace(/\/sync$/, '') + '/sync'
}

async function syncReq(method, query, body) {
  const base = getSyncUrl()
  if (!base) return { ok: false, error: 'Cloud sync not configured' }
  try {
    const res = await fetch(base + (query || ''), {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${(currentSettings || {}).syncApiKey || ''}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    })
    const data = await res.json().catch(() => ({}))
    return res.ok ? { ok: true, data } : { ok: false, error: data.error || `HTTP ${res.status}` }
  } catch (err) { return { ok: false, error: err.message } }
}

ipcMain.handle('get-device-name', () => os.hostname())
ipcMain.handle('sync-push', (_, entries) => syncReq('POST', '', { searches: entries }))
ipcMain.handle('sync-fetch', () => syncReq('GET', '?limit=1000'))
ipcMain.handle('sync-delete', (_, id) => syncReq('DELETE', '?id=' + encodeURIComponent(id)))
ipcMain.handle('sync-clear', () => syncReq('DELETE', '?all=1'))

ipcMain.handle('open-isolated-session-window', () => {
  // Pure in-memory isolated session without "persist:"
  const partition = `isolated-${Date.now()}-${Math.random()}`

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'private - Isolated Session',
    backgroundColor: '#0e0e10',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: partition,
      webviewTag: true
    }
  })

  win.loadFile('index.html')
  win.setMenuBarVisibility(false)
  win.show()

  return partition
})

const popoutWindows = new Map()
let popoutIdCounter = 0

ipcMain.handle('open-popout-window', (event, url, title) => {
  const id = popoutIdCounter++

  // NOTE: no preload script here on purpose. This window loads an arbitrary
  // external URL directly (not our own index.html), so giving it our
  // preload would hand any website access to electronAPI (shell.openPath,
  // yt-dlp spawning, etc). The always-on-top shortcut below is handled
  // entirely from the main process and doesn't need a preload.
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    title: title || 'private',
    backgroundColor: '#0e0e10',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'temporary',
      webviewTag: true
    }
  })

  win.loadURL(url)
  win.setMenuBarVisibility(false)
  win.show()

  popoutWindows.set(id, win)
  win.on('closed', () => {
    popoutWindows.delete(id)
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.key.toLowerCase() === 't' &&
      input.shift &&
      (input.meta || input.control)
    ) {
      win.setAlwaysOnTop(!win.isAlwaysOnTop())
    }
  })

  return id
})

ipcMain.handle('toggle-popout-always-on-top', (event, windowId) => {
  const win = popoutWindows.get(windowId)
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(!win.isAlwaysOnTop())
    return win.isAlwaysOnTop()
  }
  return false
})

ipcMain.handle('open-download', (event, filePath) => {
  shell
    .openPath(filePath)
    .catch(err => console.error('Failed to open file:', err))

  return true
})

// Copy the image under a right-clicked point straight to the clipboard,
// using the webview's own webContents (looked up by id) so it happens
// in the correct session/context.
ipcMain.handle('copy-image-at', (event, webContentsId, x, y) => {
  const wc = webContentsModule.fromId(webContentsId)
  if (!wc || wc.isDestroyed()) return false
  wc.copyImageAt(x, y)
  return true
})

// "Save image as..." — flag the URL so the next will-download for it shows
// a native Save dialog instead of auto-saving to the Downloads folder, then
// kick off the download from the correct webview's webContents/session.
ipcMain.handle('save-image-as', (event, webContentsId, imageUrl) => {
  const wc = webContentsModule.fromId(webContentsId)
  if (!wc || wc.isDestroyed() || !imageUrl) return false
  pendingSaveAsUrls.add(imageUrl)
  wc.downloadURL(imageUrl)
  return true
})

// Wipe a specific partition's storage — used when a domain is removed from
// the cookie whitelist, so its persisted data doesn't linger on disk forever.
ipcMain.handle('clear-partition-data', async (event, partitionName) => {
  if (!partitionName || !partitionName.startsWith('persist:')) return false
  try {
    const sess = session.fromPartition(partitionName)
    await sess.clearStorageData()
    return true
  } catch (err) {
    console.error('Failed to clear partition data:', err)
    return false
  }
})

// YouTube download handlers
ipcMain.handle('download-youtube-video', async (event, url, format) => {
  const downloadsPath = app.getPath('downloads')

  try {
    let args
    if (format === 'mp3') {
      args = ['--no-playlist', '-x', '--audio-format', 'mp3', '-o', `${downloadsPath}/%(title)s.%(ext)s`, url]
    } else {
      args = ['--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '-o', `${downloadsPath}/%(title)s.%(ext)s`, url]
    }

    event.sender.send('download-log', { message: 'Starting yt-dlp with args: ' + JSON.stringify(args) })

    return new Promise((resolve, reject) => {
      const child = spawn('yt-dlp', args)

      let stdout = ''
      let stderr = ''
      let hasStarted = false

      child.stdout.on('data', (data) => {
        stdout += data.toString()
        event.sender.send('download-log', { message: 'stdout: ' + data.toString().trim() })

        const match = data.toString().match(/\[download\]\s+(\d+\.?\d*)%/)
        if (match) {
          const percentage = match[1]
          if (!hasStarted) {
            hasStarted = true
            event.sender.send('download-progress', { percentage: '0' })
          }
          event.sender.send('download-progress', { percentage })
        }
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
        event.sender.send('download-log', { message: 'stderr: ' + data.toString().trim() })

        const match = data.toString().match(/\[download\]\s+(\d+\.?\d*)%/)
        if (match) {
          const percentage = match[1]
          if (!hasStarted) {
            hasStarted = true
            event.sender.send('download-progress', { percentage: '0' })
          }
          event.sender.send('download-progress', { percentage })
        }
      })

      child.on('close', (code) => {
        event.sender.send('download-log', { message: 'Process closed with code: ' + code })
        if (code === 0) {
          resolve({ success: true, output: stdout })
        } else {
          reject(new Error(`Download failed with exit code ${code}: ${stderr}`))
        }
      })

      child.on('error', (error) => {
        event.sender.send('download-log', { message: 'Spawn error: ' + error.message })
        reject(error)
      })

      setTimeout(() => {
        if (!hasStarted) {
          event.sender.send('download-progress', { percentage: '0' })
        }
      }, 1000)
    })
  } catch (error) {
    console.error('Download error:', error)
    throw error
  }
})

ipcMain.handle('check-yt-dlp', async () => {
  return new Promise((resolve) => {
    const child = spawn('yt-dlp', ['--version'])
    let output = ''
    let errorOutput = ''

    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })

    child.on('close', (code) => {
      resolve({ installed: code === 0, version: output?.trim() || null })
    })

    child.on('error', (error) => {
      resolve({ installed: false, version: null, error: error.message })
    })
  })
})
