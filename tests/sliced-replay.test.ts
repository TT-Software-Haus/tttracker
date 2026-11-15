import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import { Tracker } from '../src/main/tracker'

/**
 * The replay of a game in progress used to run in one go (~0.7s on a real
 * game), and the main thread carries a system-wide mouse hook, so the user's
 * cursor froze for all of it. It now runs in slices, yielding in between.
 */
describe('replaying the log in slices', () => {
  const lines = gunzipSync(readFileSync(join(__dirname, 'fixtures', 'bg-duos-both-streams.log.gz'))).toString().split('\n')
  let root: string
  beforeEach(async () => (root = await fs.mkdtemp(join(tmpdir(), 'ht-slice-'))))
  afterEach(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }))

  const tracker = () => new Tracker(new Store(root), join(root, 'carddata')) as any
  const settled = async (t: any) => {
    while (t.lineQueue.length) await new Promise((r) => setImmediate(r))
  }

  it('yields to the event loop, and ends where a one-shot replay does', async () => {
    const sliced = tracker()
    sliced.feed(lines.slice(0, 20000), true)
    expect(sliced.lineQueue.length).toBe(1) // not all done before returning
    // Lines arriving mid-replay queue behind it.
    sliced.feed(lines.slice(20000, 30000), false)
    await settled(sliced)

    const whole = tracker()
    whole.ingest(lines.slice(0, 20000), true)
    whole.ingest(lines.slice(20000, 30000), false)

    const pick = (t: any) => {
      const s = t.bg.snapshot()
      return { round: s.round, phase: s.phase, board: s.board, lobby: s.lobby.map((p: any) => p.heroCardId), rounds: s.rounds.length }
    }
    expect(pick(sliced)).toEqual(pick(whole))
    sliced.stop()
    whole.stop()
  })
})
