import { screen } from 'electron'
import koffi from 'koffi'

export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * user32, called in-process through koffi. This used to shell out to
 * PowerShell, whose Add-Type started the C# compiler on every lookup: about a
 * second of CPU across several cores each time, and the highlight window asked
 * on every snapshot. Measured natively: about a microsecond per lookup, so
 * there's nothing left to cache.
 *
 * Bound on first use, so importing this module costs nothing.
 */
let api: ReturnType<typeof bind> | undefined
function bind() {
  const user32 = koffi.load('user32.dll')
  const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' })
  return {
    RECT,
    POINT,
    FindWindowW: user32.func('void * __stdcall FindWindowW(const char16_t *cls, const char16_t *name)'),
    IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
    GetClientRect: user32.func('bool __stdcall GetClientRect(void *hwnd, _Out_ RECT *rect)'),
    ClientToScreen: user32.func('bool __stdcall ClientToScreen(void *hwnd, _Inout_ POINT *pt)'),
  }
}

/**
 * Where Hearthstone's client area is on the desktop, in Electron's
 * device-independent pixels, or undefined if it isn't running or is minimised.
 *
 * The window is found by its title, the same way the screen capture picks it.
 * The client area rather than the window rect, so a title bar in windowed mode
 * doesn't shift everything down. Electron's main process is DPI-aware, so
 * user32 answers in physical pixels (3840 wide at 150%, where setBounds wants
 * 2560); screenToDipRect converts, checked against a window of known bounds.
 */
export async function getGameWindowRect(): Promise<WindowRect | undefined> {
  api ??= bind()
  const h = api.FindWindowW(null, 'Hearthstone')
  if (!h || api.IsIconic(h)) return undefined
  const r = { left: 0, top: 0, right: 0, bottom: 0 }
  const origin = { x: 0, y: 0 }
  if (!api.GetClientRect(h, r) || !api.ClientToScreen(h, origin)) return undefined
  const physical = { x: origin.x, y: origin.y, width: r.right - r.left, height: r.bottom - r.top }
  if (physical.width <= 0 || physical.height <= 0) return undefined
  return screen.screenToDipRect(null, physical)
}
