import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BgSnapshot, Build } from '../src/shared/types'

// The screen is whatever these say it is.
const screen = { slots: [] as { x: number; y: number; width: number; height: number }[], reads: 0 }
vi.mock('../src/main/vision/heroSelect', () => ({
  readLobbyTribes: async () => [],
  stopVision: async () => {},
  readShopSlots: async () => (screen.reads++, screen.slots.length ? { slots: screen.slots, frame: { width: 1000, height: 500 } } : undefined),
}))
// Fullscreen by default: the capture covers exactly the client area.
const game = { rect: { x: 0, y: 0, width: 1000, height: 500, captured: { x: 0, y: 0, width: 1000, height: 500 } } }
vi.mock('../src/main/vision/gameWindow', () => ({
  getGameWindowRect: async () => game.rect,
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
  let logSize: number | undefined

  beforeEach(async () => {
    vi.useFakeTimers()
    root = await fs.mkdtemp(join(tmpdir(), 'ht-hl-'))
    const { Store } = await import('../src/main/store')
    const { Tracker } = await import('../src/main/tracker')
    tracker = new Tracker(new Store(root), join(root, 'carddata'))
    tracker.publish = () => {}
    // The log's tavern size, spells included. Defaults to what the screen shows.
    logSize = undefined
    tracker.bg.tavernSize = () => logSize ?? screen.slots.length
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

  it('stops reading once the cards have settled, until the tavern changes', async () => {
    // Reading every second all turn was the suspect for hitches seen live.
    screen.slots = [slot(100), slot(200), slot(300)]
    screen.reads = 0
    tracker.refreshHighlights(base([minion('A', 1), minion('BRANN', 3)]), build)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(screen.reads).toBe(2) // placed, then confirmed in the same place
    expect(tracker.highlights.map((b: { x: number }) => b.x)).toEqual([300])

    tracker.refreshHighlights(base([minion('BRANN', 2)]), build)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(screen.reads).toBe(4)
    expect(tracker.highlights.map((b: { x: number }) => b.x)).toEqual([200])
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

  it('draws nothing while the screen and the log disagree on how many cards there are', async () => {
    // Seen live: a box on a spell. A missed end shield shifts every slot one
    // over; the slot count is the giveaway.
    logSize = 4 // three minions and a spell
    screen.slots = [slot(200), slot(300), slot(400)] // first shield missed
    tracker.refreshHighlights(base([minion('A', 1), minion('B', 2), minion('BRANN', 3)]), build)
    await vi.advanceTimersByTimeAsync(600)
    expect(tracker.highlights).toEqual([])
    screen.slots = [slot(100), slot(200), slot(300), slot(400)]
    await vi.advanceTimersByTimeAsync(1000)
    expect(tracker.highlights.map((b: { x: number }) => b.x)).toEqual([300])
  })

  it('waits for the cards to finish sliding after a purchase', async () => {
    logSize = 3
    screen.slots = [slot(100), slot(200), slot(300)]
    tracker.refreshHighlights(base([minion('A', 1), minion('BRANN', 2), minion('C', 3)]), build)
    await vi.advanceTimersByTimeAsync(600)
    expect(tracker.highlights.map((b: { x: number }) => b.x)).toEqual([200])
    // Bought A: the log says two cards at once, the screen still shows three.
    logSize = 2
    tracker.refreshHighlights(base([minion('BRANN', 1), minion('C', 2)]), build)
    await vi.advanceTimersByTimeAsync(1000)
    expect(tracker.highlights).toEqual([])
    screen.slots = [slot(150), slot(250)] // settled, re-centred
    await vi.advanceTimersByTimeAsync(1000)
    expect(tracker.highlights.map((b: { x: number }) => b.x)).toEqual([150])
  })

  it('maps boxes into the client area when the capture includes a title bar', async () => {
    // Windowed, as measured live: the captured frame is a bit bigger than the
    // client area and starts above it (title bar) and just left of it.
    game.rect = { x: 100, y: 100, width: 1000, height: 500, captured: { x: 99, y: 70, width: 1002, height: 530 } }
    screen.slots = [slot(100), slot(200), slot(300)] // frame is 1000x500
    tracker.refreshHighlights(base([minion('A', 1), minion('B', 2), minion('BRANN', 3)]), build)
    await vi.advanceTimersByTimeAsync(600)
    const [box] = tracker.highlights
    // Frame x 300 -> 300 * 1002/1000 - 1 = 300 (rounded); y 100 -> 100 * 530/500 - 30 = 76.
    expect(box).toMatchObject({ x: 300, y: 76, width: 80, height: 127 })
    game.rect = { x: 0, y: 0, width: 1000, height: 500, captured: { x: 0, y: 0, width: 1000, height: 500 } }
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
