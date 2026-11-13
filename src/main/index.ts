import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron'
import { join } from 'node:path'
import { Store } from './store'
import { Tracker } from './tracker'
import { fetchCompDetail, fetchComps } from './comps'
import { getGameWindowRect } from './vision/gameWindow'
import { initCapture } from './vision/stream'
import { decodeBuild, encodeBuild } from './buildCode'
import type { BgSnapshot, Build, Settings } from '../shared/types'

let store: Store
let tracker: Tracker
let mainWin: BrowserWindow | undefined
/** Draws boxes over Hearthstone itself; sized to the game, never interactive. */
let highlightWin: BrowserWindow | undefined
type OverlayKind = 'odds' | 'lobby' | 'build'
const overlays: Partial<Record<OverlayKind, BrowserWindow>> = {}
/**
 * Overlays whose pointer is over a button right now. Locked overlays are
 * click-through, so their buttons only take clicks while hovered, and clicks
 * anywhere else on the overlay still reach the game.
 */
const hovered = new Set<BrowserWindow>()

const preload = join(__dirname, '../preload/index.cjs')

function loadPage(win: BrowserWindow, page: 'index' | 'overlay', query = '') {
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html${query}`)
  else win.loadFile(join(__dirname, `../renderer/${page}.html`), { search: query.replace(/^\?/, '') })
}

/** Windows we're resizing ourselves, so their temporary size isn't persisted. */
const resizingOurselves = new Set<string>()

function rememberBounds(win: BrowserWindow, name: string) {
  const save = () => !win.isDestroyed() && !resizingOurselves.has(name) && store.setBounds(name, win.getBounds())
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

function createHighlightWindow() {
  highlightWin = new BrowserWindow({
    width: 800,
    height: 600,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: { preload, contextIsolation: true, sandbox: false },
  })
  highlightWin.setAlwaysOnTop(true, 'screen-saver')
  highlightWin.setVisibleOnAllWorkspaces(true)
  // Always click-through: this one sits over the board itself, so it must
  // never take a click meant for the game.
  highlightWin.setIgnoreMouseEvents(true, { forward: true })
  loadPage(highlightWin, 'overlay', '?kind=slots')
}

/**
 * Never shown: it streams the Hearthstone window for the screen reading in
 * vision/. Background throttling would starve a hidden window's video.
 */
function createCaptureWindow() {
  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: { preload, contextIsolation: true, sandbox: false, backgroundThrottling: false },
  })
  loadPage(win, 'overlay', '?kind=capture')
  initCapture(win)
}

/**
 * Keep the highlight window exactly over Hearthstone's client area, so the
 * renderer can work in game coordinates and ignore where the window is.
 */
async function updateHighlightWindow(snap: BgSnapshot) {
  const win = highlightWin
  if (!win || win.isDestroyed()) return
  const wanted = store.settings.overlay.enabled && snap.shopHighlights.length > 0
  if (!wanted) {
    if (win.isVisible()) win.hide()
    return
  }
  const rect = await getGameWindowRect()
  if (!rect) return
  const b = win.getBounds()
  if (b.x !== rect.x || b.y !== rect.y || b.width !== rect.width || b.height !== rect.height) win.setBounds(rect)
  if (!win.isVisible()) win.showInactive()
}


/**
 * Make room for the build prompt in the odds window.
 *
 * Both cards live in that one window, which defaults to 170px tall — enough
 * for the odds alone. With a prompt above them the odds card is pushed almost
 * entirely out of view, and a lobby matching several builds pushes the prompt's
 * own lower options out too, where they can't be clicked.
 *
 * So the window grows while a prompt is up and goes back to the size the user
 * chose once it's answered. The saved bounds are left alone throughout —
 * this is our resize, not theirs.
 */
function growOddsForPrompt(count: number) {
  const win = overlays.odds
  if (!win || win.isDestroyed()) return
  const saved = store.getBounds('overlay-odds')
  const base = saved?.height ?? 170
  if (!count) {
    if (!resizingOurselves.has('overlay-odds')) return
    resizingOurselves.delete('overlay-odds')
    const b = win.getBounds()
    win.setBounds({ ...b, height: base })
    return
  }
  // Header, one row per build, and the card's own padding.
  const wanted = Math.min(base + 56 + count * 46, screen.getPrimaryDisplay().workArea.height - 40)
  if (win.getBounds().height >= wanted) return
  resizingOurselves.add('overlay-odds')
  win.setBounds({ ...win.getBounds(), height: wanted })
}

function updateOverlays(snap: BgSnapshot = tracker.snapshot()) {
  const o = store.settings.overlay
  const inGame = snap.status === 'in-game' || snap.status === 'game-over'
  // The build prompt is the one overlay thing you have to click, so the odds
  // window stops being click-through for as long as it's up — and goes back to
  // whatever lock setting was in force the moment it's answered.
  const prompting = !!snap.buildPrompt?.length
  growOddsForPrompt(snap.buildPrompt?.length ?? 0)
  for (const kind of ['odds', 'lobby', 'build'] as const) {
    const win = overlays[kind]
    if (!win || win.isDestroyed()) continue
    const clickable = (kind === 'odds' && prompting) || hovered.has(win)
    // The build sidebar has nothing to say until a build is chosen, so unlike
    // the others it stays hidden even when its toggle is on.
    const on = kind === 'odds' ? o.showOdds || prompting : kind === 'lobby' ? o.showLobby : o.showBuild && !!snap.selectedBuild
    const wanted = o.enabled && on && (inGame || !o.locked)
    win.setIgnoreMouseEvents(o.locked && !clickable, { forward: true })
    win.setFocusable(!o.locked || clickable)
    win.setOpacity(o.opacity)
    if (wanted && !win.isVisible()) win.showInactive()
    if (!wanted && win.isVisible()) win.hide()
    // A hidden window gets no mouseleave, so forget it was hovered.
    if (!wanted) hovered.delete(win)
  }
}

function broadcast(channel: string, payload?: unknown) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
}

/** Card lookups for build codes, which address cards by their share index. */
const codec = () => ({
  indexOf: (cardId: string) => tracker.cards.shareIndexOf(cardId),
  cardAt: (index: number) => tracker.cards.shareCardAt(index),
})

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
  ipcMain.handle('comps:detail', (_e, url: string) => {
    // The renderer supplies this URL, so pin it to the comps section rather
    // than letting any address reach the network through us.
    if (!/^https:\/\/hsreplay\.net\/battlegrounds\/comps\/[\w/-]+$/.test(url)) throw new Error('Not an HSReplay comp URL')
    return fetchCompDetail(url, (dbfId) => tracker.cards.byDbfId(dbfId)?.id)
  })
  ipcMain.handle('builds:export', (_e, id: string) => {
    const b = store.builds.find((x) => x.id === id)
    if (!b) throw new Error('That build no longer exists')
    return encodeBuild(b, codec())
  })
  ipcMain.handle('builds:import', (_e, code: string) => decodeBuild(code, codec()))

  ipcMain.handle('cards:pool', () => tracker.cards.pool())

  ipcMain.handle('settings:get', () => store.settings)
  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => {
    store.updateSettings(patch)
    if (patch.simIterations) tracker.setSimIterations(patch.simIterations)
    // Republish so a change to debugHighlights boxes (or unboxes) the tavern now.
    tracker.publish()
    updateOverlays()
    broadcast('settings:changed', store.settings)
    return store.settings
  })

  ipcMain.handle('overlay:interactive', (e, on: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (on) hovered.add(win)
    else hovered.delete(win)
    updateOverlays()
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
    void updateHighlightWindow(snap)
  })
  tracker.on('data', () => broadcast('data:changed'))
  registerIpc()
  createMainWindow()
  createOverlay('odds')
  createOverlay('lobby')
  createOverlay('build')
  createHighlightWindow()
  createCaptureWindow()
  await tracker.start()
  broadcast('data:changed')
  updateOverlays()
})

app.on('before-quit', () => {
  tracker?.stop()
  void store?.flushAll()
})
