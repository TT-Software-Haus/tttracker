import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BgSnapshot, Build } from '../src/shared/types'

// The screen is whatever these say it is.
const screen = { slots: [] as { x: number; y: number; width: number; height: number }[] }
vi.mock('../src/main/vision/heroSelect', () => ({
  readLobbyTribes: async () => [],
  stopVision: async () => {},
  readShopSlots: async () => (screen.slots.length ? { slots: screen.slots, frame: { width: 1000, height: 500 } } : undefined),
}))
vi.mock('../src/main/vision/gameWindow', () => ({
  getGameWindowRect: async () => ({ x: 0, y: 0, width: 1000, height: 500 }),
}))

/**
 * Seen live: a box stayed put after a purchase re-centred the tavern, because
 * boxes were only worked out when the log's slot numbers changed. The log says
 * which slot a card is in, never where that slot is on screen, so the boxes
 * have to follow the screen.
 */
describe('highlight boxes over the tavern', () => {
  const build: Build = { id: 'b', name: 'Mechs', tribe: 'MECHANICAL', targets: [{ byTurn: 8, cardIds: ['BRANN'] }] }
  const minion = (cardId: string, pos: number) => ({ cardId, name: cardId, atk: 1, health: 1, tier: 5, golden: false, pos })
  const base = (shop: ReturnType<typeof minion>[]) => ({ phase: 'shop', board: [], shop }) as unknown as Omit<BgSnapshot, 'status' | 'statusDetail' | 'shopHighlights'>
  const slot = (x: number) => ({ x, y: 100, width: 80, height: 120 })
  let root: string
  let tracker: any // private members are what's under test

  beforeEach(async () => {
    vi.useFakeTimers()
    root = await fs.mkdtemp(join(tmpdir(), 'ht-hl-'))
    const { Store } = await import('../src/main/store')
    const { Tracker } = await import('../src/main/tracker')
    tracker = new Tracker(new Store(root), join(root, 'carddata'))
    tracker.publish = () => {}
  })
  afterEach(async () => {
    tracker.stop()
    vi.useRealTimers()
    // A settings change schedules a debounced save that can still be writing
    // into root, so retry rather than fail on ENOTEMPTY.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
  })

  it('follows the card when the tavern shifts without the log changing', async () => {
    screen.slots = [slot(100), slot(200), slot(300)]
    tracker.refreshHighlights(base([minion('A', 1), minion('BRANN', 3)]), build)
    await vi.advanceTimersByTimeAsync(600)
    expect(tracker.highlights.map((b: { x: number }) => b.x)).toEqual([300])

    // Same log, cards slid left on screen.
    screen.slots = [slot(50), slot(150), slot(250)]
    await vi.advanceTimersByTimeAsync(1000)
    expect(tracker.highlights.map((b: { x: number }) => b.x)).toEqual([250])
  })

  it('drops the boxes the moment the tavern changes, before the next read', async () => {
    screen.slots = [slot(100), slot(200), slot(300)]
    tracker.refreshHighlights(base([minion('A', 1), minion('BRANN', 3)]), build)
    await vi.advanceTimersByTimeAsync(600)
    expect(tracker.highlights).toHaveLength(1)

    // Bought A: Brann is now in slot 2, and the old box would be on the wrong card.
    tracker.refreshHighlights(base([minion('BRANN', 2)]), build)
    expect(tracker.highlights).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(tracker.highlights.map((b: { x: number }) => b.x)).toEqual([200])
  })

  it('tries again when a read finds no tavern', async () => {
    screen.slots = []
    tracker.refreshHighlights(base([minion('BRANN', 1)]), build)
    await vi.advanceTimersByTimeAsync(600)
    expect(tracker.highlights).toEqual([])
    screen.slots = [slot(100)]
    await vi.advanceTimersByTimeAsync(1000)
    expect(tracker.highlights).toHaveLength(1)
  })

  it('boxes every tavern minion in debug mode, marking the ones the build does not want', async () => {
    tracker.store.updateSettings({ overlay: { ...tracker.store.settings.overlay, debugHighlights: true } })
    screen.slots = [slot(100), slot(200), slot(300)]
    tracker.refreshHighlights(base([minion('A', 1), minion('B', 2), minion('BRANN', 3)]), build)
    await vi.advanceTimersByTimeAsync(600)
    expect(tracker.highlights.map((b: { x: number; debug?: boolean }) => [b.x, !!b.debug])).toEqual([
      [100, true],
      [200, true],
      [300, false],
    ])
  })

  it('stops reading the screen once nothing wanted is on offer', async () => {
    screen.slots = [slot(100)]
    tracker.refreshHighlights(base([minion('BRANN', 1)]), build)
    await vi.advanceTimersByTimeAsync(600)
    tracker.refreshHighlights(base([]), build)
    await vi.advanceTimersByTimeAsync(1000)
    expect(tracker.highlightLoop).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
