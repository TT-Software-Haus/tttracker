import { describe, expect, it } from 'vitest'
import { findShopSlots } from '../src/main/vision/shopSlots'

/**
 * These boxes get drawn on top of the real game, so a wrong one points at the
 * wrong minion mid-shop — worse than drawing nothing. The detector is built to
 * return nothing when it isn't sure.
 */
describe('finding the tavern slots', () => {
  const W = 1280
  const H = 720

  /** BGRA, like NativeImage.toBitmap() hands back. */
  function frame(shields: { x: number; y: number; w: number; h: number }[]) {
    const buf = Buffer.alloc(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      buf[i * 4] = 70 // B — wooden board, nothing like the shields
      buf[i * 4 + 1] = 100
      buf[i * 4 + 2] = 150
      buf[i * 4 + 3] = 255
    }
    for (const s of shields)
      for (let y = s.y; y < s.y + s.h; y++)
        for (let x = s.x; x < s.x + s.w; x++) {
          const i = (y * W + x) * 4
          buf[i] = 118 // B
          buf[i + 1] = 22 // G
          buf[i + 2] = 188 // R — the magenta tier shield
        }
    return buf
  }

  /**
   * Shields at real proportions: this frame is a 4K one at a third of the size,
   * where they measured 56px wide every 280px. So 19px wide, every 93px.
   */
  const row = (n: number, pitch = 93, x0 = 400) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * pitch, y: 200, w: 19, h: 20 }))
  /** Tier Up, Refresh and Freeze: big, unevenly spaced, above the tavern. */
  const buttons = [
    { x: 505, y: 100, w: 43, h: 60 },
    { x: 700, y: 100, w: 43, h: 60 },
    { x: 780, y: 100, w: 37, h: 60 },
  ]

  it('finds one slot per card, left to right', () => {
    const slots = findShopSlots(frame(row(5)), W, H)
    expect(slots).toHaveLength(5)
    expect(slots.map((s) => s.x)).toEqual([...slots.map((s) => s.x)].sort((a, b) => a - b))
  })

  it('centres each box on its shield and sizes it from the slot pitch', () => {
    const slots = findShopSlots(frame(row(5, 93, 400)), W, H)
    // Shield 1 spans 400..418 inclusive, so its centre is 409.
    // Boxes are 80% of the 93px pitch.
    expect(slots[0].width).toBe(74)
    expect(slots[0].x + slots[0].width / 2).toBe(409)
    expect(slots[0].height).toBe(Math.round(74 * 1.52))
  })

  it('handles a small tavern and a full one', () => {
    expect(findShopSlots(frame(row(3)), W, H)).toHaveLength(3)
    expect(findShopSlots(frame(row(7, 93, 300)), W, H)).toHaveLength(7)
  })

  it('drops a shield-like patch away from the tavern, and sizes boxes off the tavern', () => {
    // Seen live: a leaderboard hero portrait's purple robe, in the same band
    // and about three slots left of the tavern, became "slot 1".
    const portrait = { x: 120, y: 200, w: 19, h: 20 }
    const slots = findShopSlots(frame([portrait, ...row(4)]), W, H)
    expect(slots.map((s) => s.x + s.width / 2)).toEqual([409, 502, 595, 688])
    for (const s of slots) expect(s.width).toBe(74)
  })

  it('draws nothing when a shield is missing mid-tavern, as slot numbers would be off', () => {
    const shields = row(5).filter((_, i) => i !== 2)
    expect(findShopSlots(frame(shields), W, H)).toEqual([])
  })

  it('counts a high-tier shield whose stars split it into slivers', () => {
    // Measured live at 3840x2160: a tier-5 shield's stars cut its magenta into
    // three runs of 15-18px a few px apart, each under the 19px minimum, so
    // the shield vanished and every slot after it shifted left. Scaled here:
    // three 5px slivers (minimum 6) with 2px gaps, spanning 586..604.
    const tier5 = [586, 593, 600].map((x) => ({ x, y: 200, w: 5, h: 20 }))
    const shields = [...row(5).filter((_, i) => i !== 2), ...tier5]
    const slots = findShopSlots(frame(shields), W, H)
    expect(slots).toHaveLength(5)
    expect(slots[2].x + slots[2].width / 2).toBe(595)
  })

  it('looks past the Tier Up, Refresh and Freeze buttons above the tavern', () => {
    // Seen live: on turn 1 the buttons held more magenta than three tier-1
    // shields, and the first box landed on Tier Up.
    const slots = findShopSlots(frame([...buttons, ...row(3)]), W, H)
    expect(slots.map((s) => s.y)).toEqual([200, 200, 200])
    expect(slots.map((s) => s.x + s.width / 2)).toEqual([409, 502, 595])
  })

  it('draws nothing when the only magenta is the buttons', () => {
    expect(findShopSlots(frame(buttons), W, H)).toEqual([])
  })

  it('ignores the cards in hand, which carry the same shields', () => {
    // Seen live: with the tavern unreadable, the hand's evenly fanned shields
    // at the bottom of the screen were boxed instead.
    const hand = row(4, 93, 400).map((s) => ({ ...s, y: 650 }))
    expect(findShopSlots(frame(hand), W, H)).toEqual([])
    expect(findShopSlots(frame([...hand, ...row(3)]), W, H).map((s) => s.y)).toEqual([200, 200, 200])
  })

  it('draws nothing when there is no tavern on screen', () => {
    expect(findShopSlots(frame([]), W, H)).toEqual([])
  })

  it('draws nothing from a single stray patch of the right colour', () => {
    // One shield is not a tavern, and a pitch cannot be derived from it.
    expect(findShopSlots(frame([{ x: 300, y: 200, w: 19, h: 20 }]), W, H)).toEqual([])
  })

  it('ignores specks too small to be a tier shield', () => {
    const specks = Array.from({ length: 6 }, (_, i) => ({ x: 400 + i * 93, y: 200, w: 2, h: 20 }))
    expect(findShopSlots(frame(specks), W, H)).toEqual([])
  })
})
