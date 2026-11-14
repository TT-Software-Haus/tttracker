import { app } from 'electron'
import { join } from 'node:path'

/** What the Rust module in native/capture exports. */
export interface NativeCapture {
  ping(): string
}

/**
 * The Rust capture module, or undefined if it can't be loaded (not built, or
 * a broken build). Loaded on first use. No fallback by design: callers draw no
 * boxes and read no tribes, and this warns once.
 *
 * Packaged, the file is unpacked from the asar; Electron redirects the load
 * there by itself.
 */
let mod: NativeCapture | null | undefined
export function nativeCapture(): NativeCapture | undefined {
  if (mod === undefined) {
    try {
      mod = require(join(app.getAppPath(), 'native', 'capture.node')) as NativeCapture
    } catch (err) {
      console.warn('could not load the native capture module (is Rust installed? run `npm run native`)', err)
      mod = null
    }
  }
  return mod ?? undefined
}
