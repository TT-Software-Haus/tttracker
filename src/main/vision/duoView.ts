// Pure pixel work, like shopSlots.ts: tested against real captured frames.

/** Each top corner checked, as a share of the frame's width and height. */
export const CORNER = 0.15
/** Share of bright cyan pixels in each corner that means the teammate view. */
const THRESHOLD = 0.08

/**
 * Is the screen showing your Duos teammate's board rather than yours?
 *
 * The log doesn't say: switching views is client-side, and nothing was logged
 * while the user looked at their teammate's board. The screen does: their view
 * has a bright cyan swirl in the corners, where yours has dark curtains.
 * Measured on real 1280x720 frames of the same shop: 35% and 31% cyan in the
 * top-left and top-right corners on the teammate's board, 0.2% and 0% on yours,
 * frozen (blue) cards and the blue teammate portal notwithstanding, since they
 * sit nearer the middle. Both corners must agree; the swirl moves, hence a
 * threshold well under what was measured.
 *
 * The corners are in the top strip the tavern reads already capture.
 */
export function isTeammateView(bgra: Buffer, width: number, height: number): boolean {
  const cw = Math.floor(width * CORNER)
  const ch = Math.floor(height * CORNER)
  const share = (x0: number) => {
    let hits = 0
    let n = 0
    // Every other pixel each way is plenty for a share.
    for (let y = 0; y < ch; y += 2)
      for (let x = x0; x < x0 + cw; x += 2) {
        const i = (y * width + x) * 4
        n++
        if (bgra[i] > 170 && bgra[i + 1] > 140 && bgra[i + 2] < 130) hits++
      }
    return hits / n
  }
  return share(0) > THRESHOLD && share(width - cw) > THRESHOLD
}
