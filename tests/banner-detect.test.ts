import { describe, expect, it } from 'vitest'
import { findBannerRect } from '../src/main/vision/bannerRect'

/**
 * Locating the banner by colour is what replaced a fixed crop rect, after a
 * real 2560x1440 frame put the banner 640px from where centring predicted.
 * tesseract needs the crop tight — the exact banner reads all five tribes, a
 * loose band reads one — so these tests are about the box being right, not
 * merely close.
 */
describe('finding the hero-select banner', () => {
  const W = 400
  const H = 300

  /** NativeImage.toBitmap() hands back BGRA, which is easy to get backwards. */
  function frame(plate?: { x: number; y: number; w: number; h: number }) {
    const buf = Buffer.alloc(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      buf[i * 4] = 30 // B — a dark, unsaturated background
      buf[i * 4 + 1] = 30 // G
      buf[i * 4 + 2] = 30 // R
      buf[i * 4 + 3] = 255
    }
    if (plate) {
      for (let y = plate.y; y < plate.y + plate.h; y++)
        for (let x = plate.x; x < plate.x + plate.w; x++) {
          const i = (y * W + x) * 4
          buf[i] = 200 // B
          buf[i + 1] = 40 // G
          buf[i + 2] = 150 // R — saturated purple
        }
    }
    return buf
  }

  it('finds a plate in the upper area', () => {
    const rect = findBannerRect(frame({ x: 100, y: 40, w: 180, h: 50 }), W, H)
    expect(rect).toEqual({ x: 100, y: 40, width: 180, height: 50 })
  })

  it('finds it wherever it sits horizontally', () => {
    // The real frame had it far right of centre; that must not matter.
    const rect = findBannerRect(frame({ x: 210, y: 30, w: 180, h: 40 }), W, H)
    expect(rect?.x).toBe(210)
    expect(rect?.width).toBe(180)
  })

  it('returns nothing when the banner is not on screen', () => {
    expect(findBannerRect(frame(), W, H)).toBeUndefined()
  })

  it('ignores a plate too small to be the banner', () => {
    // A stray purple element shouldn't be mistaken for the title plate.
    expect(findBannerRect(frame({ x: 10, y: 20, w: 8, h: 6 }), W, H)).toBeUndefined()
  })

  it('ignores purple below the scan band, where the hero cards are', () => {
    // Hero card frames are purple too, and sit well down the screen.
    expect(findBannerRect(frame({ x: 50, y: 200, w: 200, h: 60 }), W, H)).toBeUndefined()
  })
})
