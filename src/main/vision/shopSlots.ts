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
// Height from width, measured from the top of the shield's magenta (where the
// box starts) to the bottom of the minion's oval. 1.35 stopped short of the
// attack/health gems; a live 3840x2160 tavern measured 340px for a 224px-wide
// card. Spells, the other thing in the tavern, are about as tall.
const CARD_ASPECT = 1.52

export function findShopSlots(bgra: Buffer, width: number, height: number): Rect[] {
  // NativeImage.toBitmap() is BGRA.
  const isShield = (i: number) => {
    const b = bgra[i]
    const g = bgra[i + 1]
    const r = bgra[i + 2]
    return r > 110 && b > 80 && g < 95 && r > g + 70 && b > g + 50
  }

  // The shields all sit on one row. Every other pixel is enough to find the
  // rows with magenta in them and halves the work. Only the top half is
  // searched: the tavern sits at ~29% of the height, and the cards in your
  // hand at the bottom carry the same shields, evenly fanned, which were
  // being boxed instead.
  const rowHits = new Array<number>(height).fill(0)
  for (let y = 0; y < height / 2; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x += 2) if (isShield(row + x * 4)) rowHits[y]++
  }

  // The busiest row isn't always the tavern. The Tier Up, Refresh and Freeze
  // buttons above it are magenta shields too, and measured live they out-pixel
  // a tavern of three tier-1 cards, which put "slot 1" on the Tier Up button.
  // So try the busiest bands in turn and take the first that looks like tier
  // shields: same-sized and evenly spaced. Bands that don't are blanked out.
  for (let attempt = 0; attempt < 6; attempt++) {
    const peak = Math.max(...rowHits)
    if (peak < 8) return []
    const mid = rowHits.indexOf(peak)
    let top = mid
    let bottom = mid
    while (top > 0 && rowHits[top - 1] > peak * 0.2) top--
    while (bottom < height - 1 && rowHits[bottom + 1] > peak * 0.2) bottom++
    const slots = slotsInBand(top, bottom)
    if (slots.length) return slots
    for (let y = top; y <= bottom; y++) rowHits[y] = 0
  }
  return []

  function slotsInBand(top: number, bottom: number): Rect[] {
    const cols = new Array<number>(width).fill(0)
    for (let y = top; y <= bottom; y++) {
      const row = y * width * 4
      for (let x = 0; x < width; x++) if (isShield(row + x * 4)) cols[x]++
    }

    // Each shield is a run of columns. Anything narrower than this is a stray.
    const minRun = Math.max(6, Math.round(width * 0.005))
    // The stars on a higher-tier shield cut its magenta into slivers a few
    // pixels apart (tier 5 at 4K: three runs of 15-18px, gaps of 2-3px), so
    // runs that close together are one shield. Neighbouring shields are ~10x
    // further apart than this.
    const runs: [start: number, end: number][] = []
    let start = -1
    for (let x = 0; x <= width; x++) {
      const on = x < width && cols[x] >= 4
      if (on && start < 0) start = x
      if (!on && start >= 0) {
        const last = runs.at(-1)
        if (last && start - last[1] <= minRun) last[1] = x
        else runs.push([start, x])
        start = -1
      }
    }
    // Sizes are relative to height, which the board scales with (a wider
    // window only adds margin). Measured at 2160: shields 52-57px wide, a slot
    // every 279-281px. The buttons' runs were 27-130px at uneven spacing.
    const shields = runs.filter(([s, e]) => e - s >= minRun && e - s >= height * 0.018 && e - s <= height * 0.035)
    const centres = shields.map(([s, e]) => Math.round((s + e - 1) / 2))
    if (centres.length < 2) return []

    // Slot pitch from the median gap, so one misdetected shield can't stretch
    // every box.
    const gaps = centres.slice(1).map((c, i) => c - centres[i]).sort((a, b) => a - b)
    const pitch = gaps[Math.floor(gaps.length / 2)]
    if (pitch < height * 0.1 || pitch > height * 0.16) return []

    // Tavern cards always sit side by side, so the tavern is one unbroken run
    // of shields a pitch apart. Anything else in the band is its own group and
    // dropped: seen live, a leaderboard hero portrait's purple robe matched in
    // size and colour, three slots left of the tavern, and every box shifted
    // one card over. Two runs means a shield was missed mid-tavern, so slot
    // numbers can't be trusted and nothing is drawn.
    const groups: number[][] = []
    for (const c of centres) {
      const g = groups.at(-1)
      if (g && Math.abs(c - g[g.length - 1] - pitch) <= pitch * 0.2) g.push(c)
      else groups.push([c])
    }
    const tavern = groups.filter((g) => g.length >= 2)
    if (tavern.length !== 1) return []

    const w = Math.round(pitch * CARD_WIDTH)
    const h = Math.round(w * CARD_ASPECT)
    return tavern[0].map((cx) => ({ x: Math.round(cx - w / 2), y: top, width: w, height: h }))
  }
}
