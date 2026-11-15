import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { CORNER, isTeammateView } from '../src/main/vision/duoView'

/**
 * In Duos you can look at your teammate's board, and the log doesn't say when
 * you do, so the boxes for your tavern landed on theirs (seen live). The
 * fixtures are the two top corners of real 1280x720 captures of one shop, on
 * the user's own board and then the teammate's.
 */
describe("telling your teammate's board from yours", () => {
  const W = 1280
  const H = 720
  const cw = Math.floor(W * CORNER)
  const ch = Math.floor(H * CORNER)

  /** A frame with the captured corners put back, black elsewhere. */
  function frame(name: string) {
    const corners = gunzipSync(readFileSync(join(__dirname, 'fixtures', `duo-view-${name}-corners.bgra.gz`)))
    const bgra = Buffer.alloc(W * H * 4)
    let at = 0
    for (const x0 of [0, W - cw])
      for (let y = 0; y < ch; y++) {
        corners.copy(bgra, (y * W + x0) * 4, at, at + cw * 4)
        at += cw * 4
      }
    return bgra
  }

  it('sees the teammate view', () => {
    expect(isTeammateView(frame('teammate'), W, H)).toBe(true)
  })

  it('sees your own board', () => {
    expect(isTeammateView(frame('own'), W, H)).toBe(false)
  })

  it('needs both corners, so one cyan corner is not enough', () => {
    const mixed = frame('own')
    const teammate = frame('teammate')
    for (let y = 0; y < ch; y++) teammate.copy(mixed, y * W * 4, y * W * 4, (y * W + cw) * 4) // top-left only
    expect(isTeammateView(mixed, W, H)).toBe(false)
  })
})
