import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import { Tracker } from '../src/main/tracker'

/**
 * Restarting the tracker mid-game replays the log from the start of the game.
 * That used to forget the build being followed, and, because the hero pick was
 * ignored during the replay, take away "Pick a build" for the rest of the game.
 * Driven with a real log: hero picked on its line 7710.
 */
describe('the build choice surviving a tracker restart', () => {
  const lines = gunzipSync(readFileSync(join(__dirname, 'fixtures', 'bg-duos-both-streams.log.gz'))).toString().split('\n')
  const midGame = lines.slice(0, 9000)
  let root: string

  // Private members are what's under test: the log feed and the per-game state.
  const start = (store: Store, logDir = 'C:/Logs/Hearthstone_2026_11_13') => {
    const t = new Tracker(store, join(root, 'carddata')) as any
    t.logDir = logDir
    t.ingest(midGame, true)
    return t
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ht-choice-'))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
  })

  it('counts the hero pick while catching up', () => {
    const t = start(new Store(root))
    expect(t.heroPicked).toBe(true)
    t.stop()
  })

  it('keeps the selected build when the same game is replayed', async () => {
    const before = new Store(root)
    const a = start(before)
    a.selectBuild('b1')
    a.stop()
    await before.flushAll()

    const b = start(new Store(root))
    expect(b.selectedBuildId).toBe('b1')
    expect(b.buildPromptAnswered).toBe(true)
    b.stop()
  })

  it('keeps "Not this game" too, so the prompt does not come back', async () => {
    const before = new Store(root)
    const a = start(before)
    a.selectBuild(null)
    a.stop()
    await before.flushAll()

    const b = start(new Store(root))
    expect(b.selectedBuildId).toBeUndefined()
    expect(b.buildPromptAnswered).toBe(true)
    b.stop()
  })

  it('does not carry a choice into a different game', async () => {
    const before = new Store(root)
    const a = start(before)
    a.selectBuild('b1')
    a.stop()
    await before.flushAll()

    // Same log lines, but a later Hearthstone launch: a different game.
    const b = start(new Store(root), 'C:/Logs/Hearthstone_2026_11_14')
    expect(b.selectedBuildId).toBeUndefined()
    expect(b.buildPromptAnswered).toBe(false)
    b.stop()
  })
})
