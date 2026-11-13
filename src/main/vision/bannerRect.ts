// Pure pixel work, kept free of electron so it can be tested — and prototyped
// against a real captured frame — without a display.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Find the "Choose a Hero" plate by its colour.
 *
 * The obvious approach — a fixed rect as a fraction of the window — was tried
 * and dropped. Measured against a real 2560x1440 frame, the banner sat 640px
 * right of where centring predicts, and tesseract needs a *tight* crop: the
 * exact banner reads all five tribes, a loose band around it reads one, and a
 * full-width strip reads none. A rect that has to be right to ±100px and can't
 * be derived from the window size is a calibration knob nobody wants to turn.
 *
 * The plate is a saturated purple that nothing else on that screen matches, so
 * finding it directly sidesteps resolution, aspect ratio, UI scale and any
 * slide-in animation still in progress.
 */
export function findBannerRect(bgra: Buffer, width: number, height: number): Rect | undefined {
  const scanH = Math.floor(height * 0.4) // the plate is always in the upper area
  // NativeImage.toBitmap() is BGRA, not RGBA.
  const isPlate = (i: number) => {
    const b = bgra[i]
    const g = bgra[i + 1]
    const r = bgra[i + 2]
    return r > 90 && b > 110 && b > g + 40 && r > g + 30
  }
  const rowHits = new Array<number>(scanH).fill(0)
  for (let y = 0; y < scanH; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) if (isPlate(row + x * 4)) rowHits[y]++
  }
  const peak = Math.max(...rowHits)
  // Too little purple: this isn't the hero-select screen.
  if (peak < width * 0.05) return undefined

  // Grow out from the densest row while the rows are still mostly plate. This
  // is what keeps the purple hero cards below from being swallowed into the box.
  const floor = peak * 0.25
  let top = rowHits.indexOf(peak)
  let bottom = top
  while (top > 0 && rowHits[top - 1] > floor) top--
  while (bottom < scanH - 1 && rowHits[bottom + 1] > floor) bottom++

  let minX = width
  let maxX = -1
  for (let y = top; y <= bottom; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (!isPlate(row + x * 4)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
    }
  }
  if (maxX <= minX) return undefined
  // Bounds are inclusive, hence the +1. Deliberately not padded beyond that —
  // adding even 10px of margin drags in enough noise to cost two of the five
  // tribes.
  return { x: minX, y: top, width: maxX - minX + 1, height: bottom - top + 1 }
}
