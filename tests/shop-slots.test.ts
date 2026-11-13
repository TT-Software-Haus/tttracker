import { describe, expect, it } from 'vitest'
import { findShopSlots } from '../src/main/vision/shopSlots'

/**
 * These boxes get drawn on top of the real game, so a wrong one points at the
 * wrong minion mid-shop — worse than drawing nothing. The detector is built to
 * return nothing when it isn't sure.
 */
describe('finding the tavern slots', () => {
  const W = 800
  const H = 500

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

  /** Five evenly spaced shields, like a tier-3 tavern. */
  const row = (n: number, pitch = 100, x0 = 150) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * pitch, y: 120, w: 24, h: 12 }))

  it('finds one slot per card, left to right', () => {
    const slots = findShopSlots(frame(row(5)), W, H)
    expect(slots).toHaveLength(5)
    expect(slots.map((s) => s.x)).toEqual([...slots.map((s) => s.x)].sort((a, b) => a - b))
  })

  it('centres each box on its shield and sizes it from the slot pitch', () => {
    const slots = findShopSlots(frame(row(5, 100, 150)), W, H)
    // Shield 1 spans 150..173 inclusive, so its centre is 161.5 -> 162.
    // Boxes are 80% of the 100px pitch.
    expect(slots[0].width).toBe(80)
    expect(slots[0].x + slots[0].width / 2).toBe(162)
    expect(slots[0].height).toBe(Math.round(80 * 1.35))
  })

  it('handles a small tavern and a full one', () => {
    expect(findShopSlots(frame(row(3)), W, H)).toHaveLength(3)
    expect(findShopSlots(frame(row(7, 90, 60)), W, H)).toHaveLength(7)
  })

  it('takes the pitch from the median gap, so one odd shield cannot stretch every box', () => {
    const shields = [...row(4, 100, 100), { x: 700, y: 120, w: 24, h: 12 }]
    const slots = findShopSlots(frame(shields), W, H)
    expect(slots).toHaveLength(5)
    // The last gap is 300px; every box should still be sized off the 100 pitch.
    for (const s of slots) expect(s.width).toBe(80)
  })

  it('draws nothing when there is no tavern on screen', () => {
    expect(findShopSlots(frame([]), W, H)).toEqual([])
  })

  it('draws nothing from a single stray patch of the right colour', () => {
    // One shield is not a tavern, and a pitch cannot be derived from it.
    expect(findShopSlots(frame([{ x: 300, y: 120, w: 24, h: 12 }]), W, H)).toEqual([])
  })

  it('ignores specks too small to be a tier shield', () => {
    const specks = Array.from({ length: 6 }, (_, i) => ({ x: 100 + i * 60, y: 120, w: 2, h: 10 }))
    expect(findShopSlots(frame(specks), W, H)).toEqual([])
  })
})
