import type { Rect } from './bannerRect'

/**
 * Where the tavern's cards are on screen.
 *
 * Every card on offer carries a magenta tier shield at its top edge, and
 * nothing else on the shop screen is that colour. Finding those gives the slot
 * positions directly, which beats deriving them from the window: Hearthstone
 * insets and letterboxes its board, so the window rect says little about where
 * the tavern actually sits. Measured on a real 2560x1440 frame the five
 * shields came out evenly spaced at a pitch of 186px — the regularity is a
 * useful check, not an assumption.
 *
 * Returns left-to-right, which is the order the log's ZONE_POSITION uses.
 */
const CARD_WIDTH = 0.8 // of the gap between neighbouring slots
const CARD_ASPECT = 1.35 // height from width

export function findShopSlots(bgra: Buffer, width: number, height: number): Rect[] {
  // NativeImage.toBitmap() is BGRA.
  const isShield = (i: number) => {
    const b = bgra[i]
    const g = bgra[i + 1]
    const r = bgra[i + 2]
    return r > 110 && b > 80 && g < 95 && r > g + 70 && b > g + 50
  }

  // The shields all sit on one row, so find the busiest row band first. Every
  // other pixel is enough to locate it and halves the work.
  const rowHits = new Array<number>(height).fill(0)
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x += 2) if (isShield(row + x * 4)) rowHits[y]++
  }
  const peak = Math.max(...rowHits)
  if (peak < 8) return []
  const mid = rowHits.indexOf(peak)
  let top = mid
  let bottom = mid
  while (top > 0 && rowHits[top - 1] > peak * 0.2) top--
  while (bottom < height - 1 && rowHits[bottom + 1] > peak * 0.2) bottom++

  const cols = new Array<number>(width).fill(0)
  for (let y = top; y <= bottom; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) if (isShield(row + x * 4)) cols[x]++
  }

  // Each shield is a run of columns. Anything narrower than this is a stray.
  const minRun = Math.max(6, Math.round(width * 0.005))
  const centres: number[] = []
  let start = -1
  for (let x = 0; x <= width; x++) {
    const on = x < width && cols[x] >= 4
    if (on && start < 0) start = x
    if (!on && start >= 0) {
      if (x - start >= minRun) centres.push(Math.round((start + x - 1) / 2))
      start = -1
    }
  }
  if (centres.length < 2) return []

  // Slot pitch from the median gap, so one misdetected shield can't stretch
  // every box.
  const gaps = centres.slice(1).map((c, i) => c - centres[i]).sort((a, b) => a - b)
  const pitch = gaps[Math.floor(gaps.length / 2)]
  const w = Math.round(pitch * CARD_WIDTH)
  const h = Math.round(w * CARD_ASPECT)
  return centres.map((cx) => ({ x: Math.round(cx - w / 2), y: top, width: w, height: h }))
}
