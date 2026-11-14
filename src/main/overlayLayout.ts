/**
 * Where the odds, lobby and build overlays sit: always inside the game window,
 * following it as it moves and resizes.
 *
 * A position is a fraction of the free space inside the anchor (the game's
 * client area, or the screen's work area when there's no game window):
 * fx = 0 is flush left, 1 flush right, 0.5 centred, and likewise fy. That holds
 * whatever size the window or the overlay is, and clamping keeps an overlay
 * inside the game area however small it gets. Sizes are stored unscaled.
 *
 * Pure, so the maths is tested without windows.
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Placement {
  fx: number
  fy: number
  /** At scale 1. */
  width: number
  height: number
}

export const DEFAULT_PLACEMENTS = {
  // Top-centre, just under the edge.
  odds: { fx: 0.5, fy: 0.005, width: 440, height: 170 },
  // Down the left edge, below the hero portrait.
  lobby: { fx: 0.008, fy: 0.08, width: 290, height: 720 },
  // Opposite the lobby list.
  build: { fx: 0.992, fy: 0.08, width: 240, height: 520 },
} satisfies Record<string, Placement>

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** The overlay's bounds for this anchor. Never larger than the anchor, never outside it. */
export function place(p: Placement, anchor: Rect, scale: number): Rect {
  const width = Math.min(Math.round(p.width * scale), anchor.width)
  const height = Math.min(Math.round(p.height * scale), anchor.height)
  return {
    x: anchor.x + Math.round((anchor.width - width) * clamp01(p.fx)),
    y: anchor.y + Math.round((anchor.height - height) * clamp01(p.fy)),
    width,
    height,
  }
}

/** The placement that puts an overlay where the user dragged or resized it. */
export function placementOf(b: Rect, anchor: Rect, scale: number): Placement {
  const freeX = anchor.width - b.width
  const freeY = anchor.height - b.height
  return {
    fx: freeX > 0 ? clamp01((b.x - anchor.x) / freeX) : 0.5,
    fy: freeY > 0 ? clamp01((b.y - anchor.y) / freeY) : 0.5,
    width: b.width / scale,
    height: b.height / scale,
  }
}

/**
 * How big the overlays are drawn: in proportion to the game window's height,
 * times the Size setting. 1440 is the fullscreen height (in DIPs) of the 4K,
 * 150% monitor they were designed on, so fullscreen there looks as it always
 * did; a 1920x1080 window there (720 DIPs high) would be 0.5, which is where
 * text stops being comfortably readable, hence the floor.
 */
export const REFERENCE_HEIGHT = 1440
export const MIN_SCALE = 0.6
export function overlayScale(anchorHeight: number, userScale: number) {
  return Math.max(MIN_SCALE, anchorHeight / REFERENCE_HEIGHT) * userScale
}

/** Within a couple of pixels: DIP/physical rounding can nudge bounds we set ourselves. */
export function sameRect(a: Rect | undefined, b: Rect | undefined, slack = 2) {
  if (!a || !b) return false
  return Math.abs(a.x - b.x) <= slack && Math.abs(a.y - b.y) <= slack && Math.abs(a.width - b.width) <= slack && Math.abs(a.height - b.height) <= slack
}
