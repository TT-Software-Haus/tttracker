import { desktopCapturer, session, type BrowserWindow } from 'electron'
import { getGameWindowRect } from './gameWindow'

/**
 * Frames of the Hearthstone window, from a stream of that one window running in
 * a hidden capture window (renderer side: src/renderer/src/capture.ts).
 *
 * desktopCapturer.getSources() can't capture one window: it renders a
 * thumbnail of every open window and returns them all, ~1.3s and 57MB per call
 * at 720p with 24 windows open, which the tavern loop paid every second or
 * two. The stream costs one frame per read. It's opened on the first read and
 * kept until stopCapture(), so callers stop it when they're done reading.
 *
 * Failure is quiet by design: no stream means no frame, the caller draws no
 * boxes or reads no tribes, and the next read tries again.
 */
let win: BrowserWindow | undefined
let warnedBlack = false
/** A read that takes longer than this has lost its stream request; give up on it. */
const READ_TIMEOUT_MS = 5000

export interface Frame {
  width: number
  height: number
  /** BGRA, like NativeImage.toBitmap(). */
  bgra: Buffer
}

export function initCapture(captureWindow: BrowserWindow) {
  win = captureWindow
  // The capture window asks for display media; answer with the Hearthstone
  // window. Listed without thumbnails, so nothing is rendered: ~0.5s, once per
  // stream opened.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
    const hs = sources.find((s) => s.name === 'Hearthstone')
    // Denying throws in Electron ("Video was requested, but no video stream
    // was provided"); the request then just fails, and READ_TIMEOUT_MS covers
    // the renderer side. captureFrame checks for the window first, so this only
    // happens if Hearthstone closes in between.
    try {
      callback(hs ? { video: hs } : {})
    } catch {}
  })
}

/** The latest frame of the Hearthstone window at `height`, or undefined. */
export async function captureFrame(height: number): Promise<Frame | undefined> {
  if (!win || win.isDestroyed()) return undefined
  // A microsecond to check; opening a stream to a window that isn't there costs
  // a 0.5s window list and a request that never completes.
  if (!(await getGameWindowRect())) return undefined
  try {
    const read = win.webContents.executeJavaScript(`window.capture.frame(${Math.round(height)})`) as Promise<
      { width: number; height: number; bgra: Uint8Array } | undefined
    >
    const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, READ_TIMEOUT_MS))
    const f = await Promise.race([read, timeout])
    if (!f) return undefined
    const bgra = Buffer.from(f.bgra.buffer, f.bgra.byteOffset, f.bgra.byteLength)
    if (isBlack(bgra)) {
      // Capture "succeeding" with black frames is how a game that can't be
      // captured shows up; say so once rather than silently drawing nothing.
      if (!warnedBlack) console.warn('the Hearthstone capture is coming back black')
      warnedBlack = true
      return undefined
    }
    return { width: f.width, height: f.height, bgra }
  } catch (err) {
    console.warn('could not capture the Hearthstone window', err)
    return undefined
  }
}

export function stopCapture() {
  if (win && !win.isDestroyed()) void win.webContents.executeJavaScript('window.capture.close()').catch(() => {})
}

/** Every sampled pixel near-black. A real game frame never is. */
function isBlack(bgra: Buffer) {
  for (let i = 0; i < bgra.length; i += 4 * 97) if (bgra[i] > 8 || bgra[i + 1] > 8 || bgra[i + 2] > 8) return false
  return true
}
