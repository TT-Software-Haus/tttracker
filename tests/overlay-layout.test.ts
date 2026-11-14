import { describe, expect, it } from 'vitest'
import { DEFAULT_PLACEMENTS, overlayScale, place, placementOf, sameRect } from '../src/main/overlayLayout'

/**
 * The overlays must sit at the inside edges of the game window and move with
 * it. Asked for after a windowed game left them floating at the screen's edges,
 * outside a 1920x1080 window.
 */
describe('overlay layout', () => {
  // Fullscreen on a 4K monitor at 150%, and a 1920x1080 window on it, in DIPs.
  const fullscreen = { x: 0, y: 0, width: 2560, height: 1440 }
  const windowed = { x: 640, y: 371, width: 1280, height: 721 }

  it('puts the defaults at the inside edges', () => {
    const odds = place(DEFAULT_PLACEMENTS.odds, windowed, 1)
    expect(odds.x + odds.width / 2).toBe(windowed.x + windowed.width / 2) // centred
    expect(odds.y).toBeGreaterThanOrEqual(windowed.y)
    const lobby = place(DEFAULT_PLACEMENTS.lobby, windowed, 1)
    expect(lobby.x - windowed.x).toBeLessThan(20) // left edge
    const build = place(DEFAULT_PLACEMENTS.build, windowed, 1)
    expect(windowed.x + windowed.width - (build.x + build.width)).toBeLessThan(20) // right edge
  })

  it('follows the game window when it moves', () => {
    const before = place(DEFAULT_PLACEMENTS.build, windowed, 1)
    const after = place(DEFAULT_PLACEMENTS.build, { ...windowed, x: windowed.x - 300, y: windowed.y + 50 }, 1)
    expect(after.x - before.x).toBe(-300)
    expect(after.y - before.y).toBe(50)
  })

  it('stays inside the game window, however small', () => {
    const tiny = { x: 100, y: 100, width: 400, height: 300 }
    for (const p of Object.values(DEFAULT_PLACEMENTS)) {
      const b = place(p, tiny, 1)
      expect(b.x).toBeGreaterThanOrEqual(tiny.x)
      expect(b.y).toBeGreaterThanOrEqual(tiny.y)
      expect(b.x + b.width).toBeLessThanOrEqual(tiny.x + tiny.width)
      expect(b.y + b.height).toBeLessThanOrEqual(tiny.y + tiny.height)
    }
  })

  it('keeps a dragged overlay in the same place relative to the game', () => {
    // Dragged to the middle-right of a fullscreen game...
    const dragged = { x: 1800, y: 600, width: 290, height: 720 }
    const p = placementOf(dragged, fullscreen, 1)
    expect(place(p, fullscreen, 1)).toEqual(dragged)
    // ...then the game goes windowed: still middle-right, inside the window.
    const b = place(p, windowed, 1)
    expect(b.x).toBeGreaterThan(windowed.x + windowed.width / 2)
    expect(b.x + b.width).toBeLessThanOrEqual(windowed.x + windowed.width)
  })

  it('remembers a resize at scale 1, whatever the scale it was made at', () => {
    const p = placementOf({ x: 0, y: 0, width: 300, height: 400 }, fullscreen, 0.5)
    expect(p.width).toBe(600)
    expect(p.height).toBe(800)
  })

  it('treats a couple of pixels of rounding as no move', () => {
    const a = { x: 10, y: 10, width: 100, height: 100 }
    expect(sameRect(a, { x: 11, y: 9, width: 101, height: 100 })).toBe(true)
    expect(sameRect(a, { x: 20, y: 10, width: 100, height: 100 })).toBe(false)
  })

  it('is full size in fullscreen and shrinks with the window, down to a readable floor', () => {
    expect(overlayScale(fullscreen.height, 1)).toBe(1)
    expect(overlayScale(1080, 1)).toBe(0.75)
    expect(overlayScale(windowed.height, 1)).toBe(0.6) // 721/1440 is ~0.5, under the floor
    expect(overlayScale(fullscreen.height, 1.2)).toBeCloseTo(1.2) // the Size setting multiplies on top
  })

  it('shrinks the lobby list in a 1920x1080 window instead of covering the game', () => {
    // Seen live: at full size it filled most of the window's height and a big
    // slice of its width.
    const lobby = place(DEFAULT_PLACEMENTS.lobby, windowed, overlayScale(windowed.height, 1))
    expect(lobby.width).toBe(174)
    expect(lobby.height).toBe(432)
  })
})
