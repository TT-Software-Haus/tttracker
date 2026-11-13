import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron'
import { join } from 'node:path'
import { Store } from './store'
import { Tracker } from './tracker'
import { fetchCompAddons, fetchComps } from './comps'
import { decodeBuild, encodeBuild } from './buildCode'
import type { BgSnapshot, Build, Settings } from '../shared/types'

let store: Store
let tracker: Tracker
let mainWin: BrowserWindow | undefined
type OverlayKind = 'odds' | 'lobby' | 'build'
const overlays: Partial<Record<OverlayKind, BrowserWindow>> = {}

const preload = join(__dirname, '../preload/index.cjs')

function loadPage(win: BrowserWindow, page: 'index' | 'overlay', query = '') {
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html${query}`)
  else win.loadFile(join(__dirname, `../renderer/${page}.html`), { search: query.replace(/^\?/, '') })
}

function rememberBounds(win: BrowserWindow, name: string) {
  const save = () => !win.isDestroyed() && store.setBounds(name, win.getBounds())
  win.on('moved', save)
  win.on('resized', save)
}

function createMainWindow() {
  const saved = store.getBounds('main')
  mainWin = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    x: saved?.x,
    y: saved?.y,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0b0d12',
    title: 'Hearth Tracker',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#9aa3b5', height: 36 },
    webPreferences: { preload, contextIsolation: true, sandbox: false },
  })
  rememberBounds(mainWin, 'main')
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadPage(mainWin, 'index')
  mainWin.on('closed', () => {
    mainWin = undefined
    app.quit()
  })
}

function createOverlay(kind: OverlayKind) {
  const saved = store.getBounds(`overlay-${kind}`)
  const area = screen.getPrimaryDisplay().workArea
  const defaults =
    kind === 'odds'
      ? { width: 440, height: 170, x: area.x + Math.round(area.width / 2 - 220), y: area.y + 8 }
      : kind === 'build'
        ? // Right-hand side, opposite the lobby list.
          { width: 240, height: Math.min(520, area.height - 180), x: area.x + area.width - 256, y: area.y + 90 }
        : { width: 290, height: Math.min(720, area.height - 140), x: area.x + 16, y: area.y + 90 }
  const win = new BrowserWindow({
    ...defaults,
    ...(saved ?? {}),
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: { preload, contextIsolation: true, sandbox: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true)
  rememberBounds(win, `overlay-${kind}`)
  loadPage(win, 'overlay', `?kind=${kind}`)
  overlays[kind] = win
}

function updateOverlays(snap: BgSnapshot = tracker.snapshot()) {
  const o = store.settings.overlay
  const inGame = snap.status === 'in-game' || snap.status === 'game-over'
  // The build prompt is the one overlay thing you have to click, so the odds
  // window stops being click-through for as long as it's up — and goes back to
  // whatever lock setting was in force the moment it's answered.
  const prompting = !!snap.buildPrompt?.length
  for (const kind of ['odds', 'lobby', 'build'] as const) {
    const win = overlays[kind]
    if (!win || win.isDestroyed()) continue
    const clickable = kind === 'odds' && prompting
    // The build sidebar has nothing to say until a build is chosen, so unlike
    // the others it stays hidden even when its toggle is on.
    const on = kind === 'odds' ? o.showOdds || prompting : kind === 'lobby' ? o.showLobby : o.showBuild && !!snap.selectedBuild
    const wanted = o.enabled && on && (inGame || !o.locked)
    win.setIgnoreMouseEvents(o.locked && !clickable, { forward: true })
    win.setFocusable(!o.locked || clickable)
    win.setOpacity(o.opacity)
    if (wanted && !win.isVisible()) win.showInactive()
    if (!wanted && win.isVisible()) win.hide()
  }
}

function broadcast(channel: string, payload?: unknown) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
}

function registerIpc() {
  ipcMain.handle('tracker:snapshot', () => tracker.snapshot())
  ipcMain.handle('setup:status', () => tracker.setupStatus())
  ipcMain.handle('setup:fixLogConfig', () => tracker.fixLogConfig())
  ipcMain.handle('setup:browse', async () => {
    const r = await dialog.showOpenDialog(mainWin!, { properties: ['openDirectory'], title: 'Select your Hearthstone folder' })
    if (r.canceled || !r.filePaths[0]) return undefined
    await tracker.setInstallPath(r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('matches:list', () => store.matches)
  ipcMain.handle('matches:delete', (_e, id: string) => {
    store.deleteMatch(id)
    broadcast('data:changed')
  })

  // Builds are only read by the page that edits them (and, from M2, pushed in the
  // snapshot), so saving doesn't need to broadcast.
  ipcMain.handle('builds:list', () => store.builds)
  ipcMain.handle('builds:save', (_e, b: Build) => store.saveBuild(b))
  ipcMain.handle('builds:delete', (_e, id: string) => store.deleteBuild(id))
  ipcMain.handle('builds:select', (_e, id: string | null) => tracker.selectBuild(id))
  ipcMain.handle('comps:list', () => fetchComps(tracker.cards))
  ipcMain.handle('comps:addons', (_e, url: string) => {
    // The renderer supplies this URL, so pin it to the comps section rather
    // than letting any address reach the network through us.
    if (!/^https:\/\/hsreplay\.net\/battlegrounds\/comps\/[\w/-]+$/.test(url)) throw new Error('Not an HSReplay comp URL')
    return fetchCompAddons(url, (dbfId) => tracker.cards.byDbfId(dbfId)?.id)
  })
  ipcMain.handle('builds:export', (_e, id: string) => {
    const b = store.builds.find((x) => x.id === id)
    if (!b) throw new Error('That build no longer exists')
    return encodeBuild(b, (cardId) => tracker.cards.get(cardId)?.dbfId)
  })
  ipcMain.handle('builds:import', (_e, code: string) => decodeBuild(code, (dbfId) => tracker.cards.byDbfId(dbfId)?.id))

  ipcMain.handle('cards:pool', () => tracker.cards.pool())

  ipcMain.handle('settings:get', () => store.settings)
  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => {
    store.updateSettings(patch)
    if (patch.simIterations) tracker.setSimIterations(patch.simIterations)
    updateOverlays()
    broadcast('settings:changed', store.settings)
    return store.settings
  })

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
  })
}

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'))
  tracker = new Tracker(store, join(app.getPath('userData'), 'carddata'))
  tracker.on('snapshot', (snap: BgSnapshot) => {
    broadcast('tracker:snapshot', snap)
    updateOverlays(snap)
  })
  tracker.on('data', () => broadcast('data:changed'))
  registerIpc()
  createMainWindow()
  createOverlay('odds')
  createOverlay('lobby')
  createOverlay('build')
  await tracker.start()
  broadcast('data:changed')
  updateOverlays()
})

app.on('before-quit', () => {
  tracker?.stop()
  void store?.flushAll()
})
