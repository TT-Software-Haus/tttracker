import { nativeCapture } from './native'
import { mark } from '../stallWatch'

/**
 * Frames of the Hearthstone window, from the Rust module in native/capture.
 *
 * It keeps one Windows Graphics Capture session on the game window between
 * reads, and copies back only the top `fraction` of each frame: the detectors
 * never look below it. This replaced a hidden window streaming the game through
 * getDisplayMedia, which copied a whole video frame from the GPU per read; with
 * the boxes on, the user's mouse froze at random moments.
 *
 * The session is opened on the first read and kept until stopCapture(), so
 * callers stop it when they're done reading. Failure is quiet by design: no
 * frame means the caller draws no boxes or reads no tribes, and the next read
 * tries again.
 */
let warnedBlack = false

export interface Frame {
  width: number
  height: number
  /** BGRA, like NativeImage.toBitmap(). Rows below the strip are zero. */
  bgra: Buffer
}

/** The latest frame of the Hearthstone window at `height`, with its top `fraction` filled in, or undefined. */
export async function captureFrame(height: number, fraction: number): Promise<Frame | undefined> {
  const cap = nativeCapture()
  if (!cap) return undefined
  try {
    const t = performance.now()
    const f = cap.frame(Math.round(height), fraction)
    const ms = performance.now() - t
    if (ms > 16) mark(`capture at ${height} took ${ms.toFixed(0)}ms (${f ? 'a frame' : 'no frame yet'})`)
    if (!f) return undefined
    if (isBlack(f.bgra)) {
      // Capture "succeeding" with black frames is how a game that can't be
      // captured shows up; say so once rather than silently drawing nothing.
      if (!warnedBlack) console.warn('the Hearthstone capture is coming back black')
      warnedBlack = true
      return undefined
    }
    return f
  } catch (err) {
    console.warn('could not capture the Hearthstone window', err)
    return undefined
  }
}

export function stopCapture() {
  nativeCapture()?.close()
}

/** Every sampled pixel near-black (the zeroed rows below the strip are). A real game frame never is. */
function isBlack(bgra: Buffer) {
  for (let i = 0; i < bgra.length; i += 4 * 97) if (bgra[i] > 8 || bgra[i + 1] > 8 || bgra[i + 2] > 8) return false
  return true
}
