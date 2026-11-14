import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// What each banner read returns, in order; [] once the list runs out.
const reads: string[][] = []
let readCount = 0
vi.mock('../src/main/vision/heroSelect', () => ({
  readLobbyTribes: async () => (readCount++, reads.shift() ?? []),
  stopVision: async () => {},
  readShopSlots: async () => undefined,
}))
vi.mock('../src/main/vision/stream', () => ({ stopCapture: () => {} }))

/**
 * The lobby's tribes come only from the hero-select banner, so they're read the
 * moment heroes are offered, and saved with the game: after a tracker restart
 * mid-game the banner is long gone.
 */
describe('reading the tribe banner', () => {
  let root: string

  beforeEach(async () => {
    vi.useFakeTimers()
    root = await fs.mkdtemp(join(tmpdir(), 'ht-tribes-'))
    reads.length = 0
    readCount = 0
  })
  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
  })

  const tracker = async (store?: unknown) => {
    const { Store } = await import('../src/main/store')
    const { Tracker } = await import('../src/main/tracker')
    const t = new Tracker((store as never) ?? new Store(root), join(root, 'carddata')) as any
    t.publish = () => {}
    return t
  }

  it('reads at once, keeps going through a half-drawn banner, and stops when two reads agree', async () => {
    reads.push([], ['BEAST'], ['BEAST', 'DEMON'], ['BEAST', 'DEMON'])
    const t = await tracker()
    t.startTribeRead()
    await vi.advanceTimersByTimeAsync(0)
    expect(readCount).toBe(1) // no waiting for the first read
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.screenTribes).toEqual(['BEAST', 'DEMON'])
    expect(readCount).toBe(4) // settled: no more OCR
    t.stop()
  })

  it('keeps the tribes across a restart mid-game', async () => {
    const { Store } = await import('../src/main/store')
    const store = new Store(root)
    reads.push(['BEAST', 'DEMON'], ['BEAST', 'DEMON'])
    const a = await tracker(store)
    a.beginGame('C:/Logs/x|100')
    a.startTribeRead()
    await vi.advanceTimersByTimeAsync(5000)
    a.stop()

    const b = await tracker(store)
    b.beginGame('C:/Logs/x|100')
    expect(b.screenTribes).toEqual(['BEAST', 'DEMON'])
    b.stop()
  })

  it('saves tribes read before the game key arrives under the new game', async () => {
    // GameState runs ahead of PowerTaskList: the read can finish first.
    const { Store } = await import('../src/main/store')
    const store = new Store(root)
    reads.push(['MECHANICAL'], ['MECHANICAL'])
    const a = await tracker(store)
    a.beginGame('C:/Logs/x|100')
    a.startTribeRead()
    await vi.advanceTimersByTimeAsync(5000)
    a.beginGame('C:/Logs/x|900')
    a.stop()

    const b = await tracker(store)
    b.beginGame('C:/Logs/x|900')
    expect(b.screenTribes).toEqual(['MECHANICAL'])
    b.stop()
  })
})
