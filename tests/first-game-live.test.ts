import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import { Tracker } from '../src/main/tracker'

/**
 * Hearthstone creates Power.log when the session's first game starts. Its
 * first lines used to be treated as history being replayed, which skips the
 * screen reads, so the tribe banner was never read in the first game of a
 * session. Seen live on 2026-11-14.
 */
describe('the first game of a Hearthstone session', () => {
  const log = gunzipSync(readFileSync(join(__dirname, 'fixtures', 'bg-duos-both-streams.log.gz'))).toString()
  const lines = log.split('\n')
  // Just past the heroes being offered: an entity counts once its tag block
  // ends. The fixture is a reconnect, so its opening state dump already has
  // the hero picked; dropping that makes it a fresh hero select.
  const offered = lines.findIndex((l) => l.includes('BACON_HERO_CAN_BE_DRAFTED value=1'))
  const heroSelect = lines.slice(0, offered + 100).filter((l) => !l.includes('MULLIGAN_STATE value=DONE')).join('\n') + '\n'
  let root: string
  let session: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ht-first-'))
    session = join(root, 'Hearthstone', 'Logs', 'Hearthstone_2026_11_14_16_13_24')
    await fs.mkdir(session, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
  })

  const tracker = () => {
    const store = new Store(root)
    store.updateSettings({ hearthstonePath: join(root, 'Hearthstone') })
    const t = new Tracker(store, join(root, 'carddata')) as any
    t.startTribeRead = vi.fn()
    return t
  }

  it('reads the tribes when Power.log appears while we watch', async () => {
    const t = tracker()
    await t.attachToLogs() // the session folder exists, Power.log doesn't yet
    await fs.writeFile(join(session, 'Power.log'), heroSelect)
    await t.attachToLogs()
    await vi.waitFor(() => expect(t.startTribeRead).toHaveBeenCalled(), { timeout: 3000 })
    t.stop()
  })

  it('still skips them when replaying a game already under way', async () => {
    await fs.writeFile(join(session, 'Power.log'), heroSelect)
    const t = tracker()
    await t.attachToLogs()
    await vi.waitFor(() => expect(t.powerTail.offset).toBe(Buffer.byteLength(heroSelect)), { timeout: 3000 })
    expect(t.startTribeRead).not.toHaveBeenCalled()
    t.stop()
  })
})
