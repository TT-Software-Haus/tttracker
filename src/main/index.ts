import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron'
import { join } from 'node:path'
import { Store } from './store'
import { Tracker } from './tracker'
import { fetchCompDetail, fetchComps } from './comps'
import { getGameWindowRect } from './vision/gameWindow'
import { initCapture } from './vision/stream'
import { DEFAULT_PLACEMENTS, overlayScale, place, placementOf, sameRect, type Placement, type Rect } from './overlayLayout'
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

// ------------------------------------------------------------ overlay layout
//
// The odds, lobby and build overlays sit inside the game window and follow it
// (overlayLayout.ts has the maths). The anchor is the game's client area, or
// the screen's work area when there's no game window to sit in.

const KINDS = ['odds', 'lobby', 'build'] as const
let anchor: Rect | undefined
/** The bounds this code last gave each overlay, so its own moves aren't saved as drags. */
const placedAt: Partial<Record<OverlayKind, Rect>> = {}
/** Builds listed in the prompt, which shares the odds window and grows it. */
let promptRows = 0
// Header, one row per build, and the card's own padding.
const promptExtra = () => (promptRows ? 56 + promptRows * 46 : 0)

function placementFor(kind: OverlayKind): Placement {
  const p = store.getPlacement(kind) ?? DEFAULT_PLACEMENTS[kind]
  return kind === 'odds' ? { ...p, height: p.height + promptExtra() } : p
}

const scaleNow = () => overlayScale(anchor?.height ?? 0, store.settings.overlay.scale)

function layoutOverlays() {
  if (!anchor) return
  const scale = scaleNow()
  for (const kind of KINDS) {
    const win = overlays[kind]
    if (!win || win.isDestroyed()) continue
    const b = place(placementFor(kind), anchor, scale)
    placedAt[kind] = b
    if (!sameRect(b, win.getBounds(), 0)) win.setBounds(b)
    sendZoom(win, scale)
  }
}

/**
 * The window is sized by the scale; the content zooms to match. Sent per window
 * rather than set with webContents.setZoomFactor, because Chromium shares a
 * zoom level across every window of the same origin, the main window included.
 */
const zoomSent = new WeakMap<BrowserWindow, number>()
function sendZoom(win: BrowserWindow, zoom: number) {
  if (zoomSent.get(win) === zoom) return
  zoomSent.set(win, zoom)
  win.webContents.send('overlay:zoom', zoom)
}

/** A move or resize this code didn't make is the user's: remember it relative to the game. */
function onOverlayMoved(kind: OverlayKind) {
  const win = overlays[kind]
  if (!win || win.isDestroyed() || !anchor) return
  const b = win.getBounds()
  if (sameRect(b, placedAt[kind])) return
  const p = placementOf(b, anchor, scaleNow())
  store.setPlacement(kind, kind === 'odds' ? { ...p, height: p.height - promptExtra() } : p)
  placedAt[kind] = b
}

function createOverlay(kind: OverlayKind) {
  anchor ??= screen.getPrimaryDisplay().workArea
  const b = place(placementFor(kind), anchor, scaleNow())
  const win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: { preload, contextIsolation: true, sandbox: false },
  })
  placedAt[kind] = b
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true)
  win.on('moved', () => onOverlayMoved(kind))
  win.on('resized', () => onOverlayMoved(kind))
  // A fresh page hasn't had its zoom yet.
  win.webContents.on('did-finish-load', () => {
    zoomSent.delete(win)
    sendZoom(win, scaleNow())
  })
  loadPage(win, 'overlay', `?kind=${kind}`)
  overlays[kind] = win
}

/**
 * Follow the game window: the overlays and the highlight layer both. Moving or
 * resizing it writes nothing to the log, so it's polled, only while something
 * is showing. 50ms rather than 500: at half a second the overlays visibly
 * lagged behind a dragged window (seen live), and a look costs a microsecond
 * (gameWindow.ts), so the only real work is the setBounds when it has moved.
 */
const FOLLOW_MS = 50
function followGameWindow() {
  setInterval(async () => {
    const boxes = highlightWin && !highlightWin.isDestroyed() && highlightWin.isVisible()
    if (!boxes && !KINDS.some((k) => overlays[k]?.isVisible())) return
    const g = await getGameWindowRect()
    // Without this the boxes stayed where the window used to be (seen live):
    // the highlight layer was only moved when the log changed.
    if (boxes && g) fitHighlightWindow(g)
    const a = g ? { x: g.x, y: g.y, width: g.width, height: g.height } : screen.getPrimaryDisplay().workArea
    if (sameRect(a, anchor, 0)) return
    anchor = a
    layoutOverlays()
  }, FOLLOW_MS)
}

/** Size the highlight layer to the game's client area, which the boxes are drawn in. */
function fitHighlightWindow(rect: Rect) {
  const win = highlightWin
  if (!win || win.isDestroyed()) return
  const r = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  if (!sameRect(r, win.getBounds(), 0)) win.setBounds(r)
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
  fitHighlightWindow(rect)
  if (!win.isVisible()) win.showInactive()
}


function updateOverlays(snap: BgSnapshot = tracker.snapshot()) {
  const o = store.settings.overlay
  const inGame = snap.status === 'in-game' || snap.status === 'game-over'
  // The build prompt is the one overlay thing you have to click, so the odds
  // window stops being click-through for as long as it's up — and goes back to
  // whatever lock setting was in force the moment it's answered.
  const prompting = !!snap.buildPrompt?.length
  // The prompt grows the odds window while it's up, so it doesn't push the
  // odds card out of view; the layout shrinks it back once it's answered.
  if ((snap.buildPrompt?.length ?? 0) !== promptRows) {
    promptRows = snap.buildPrompt?.length ?? 0
    layoutOverlays()
  }
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
    // The Size setting is part of the overlays' scale.
    layoutOverlays()
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
  followGameWindow()
  await tracker.start()
  broadcast('data:changed')
  updateOverlays()
})

app.on('before-quit', () => {
  tracker?.stop()
  void store?.flushAll()
})
