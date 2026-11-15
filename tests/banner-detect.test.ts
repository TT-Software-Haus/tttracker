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
    // No lettering drawn, so the box stays the whole plate.
    const rect = findBannerRect(frame({ x: 100, y: 40, w: 180, h: 50 }), W, H)
    expect(rect).toEqual({ x: 100, y: 40, width: 180, height: 50 })
  })

  it('finds it wherever it sits horizontally', () => {
    // The real frame had it far right of centre; that must not matter.
    const rect = findBannerRect(frame({ x: 210, y: 30, w: 180, h: 40 }), W, H)
    expect(rect?.x).toBe(210)
    expect(rect?.width).toBe(180)
  })

  it('shrinks to the lettering, leaving the emblems out', () => {
    // At 1080p the gold emblems sitting on the plate cost a whole tribe, so the
    // box tightens onto text-coloured pixels only.
    const buf = frame({ x: 60, y: 30, w: 300, h: 60 })
    const put = (x: number, y: number, b: number, g: number, r: number) => {
      const i = (y * W + x) * 4
      buf[i] = b
      buf[i + 1] = g
      buf[i + 2] = r
    }
    // Gold emblem on the left of the plate: bright, but almost no blue.
    for (let y = 35; y < 80; y++) for (let x = 65; x < 110; x++) put(x, y, 96, 151, 178)
    // Lettering on the right: blue well above green.
    for (let y = 45; y < 65; y++) for (let x = 200; x < 300; x++) put(x, y, 229, 144, 226)
    const rect = findBannerRect(buf, W, H)
    expect(rect).toEqual({ x: 200, y: 45, width: 100, height: 20 })
  })

  it('keeps the plate when there is no lettering to find', () => {
    const rect = findBannerRect(frame({ x: 100, y: 40, w: 180, h: 50 }), W, H)
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
