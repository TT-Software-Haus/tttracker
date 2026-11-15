import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BgSnapshot } from '../src/shared/types'

/**
 * The Setup page re-reads the logging config, so it can discover that logging is
 * on when the last published snapshot still says 'setup-needed'. If that
 * discovery isn't republished the banner stays up for good — the Setup page
 * shows a green tick while the banner above it still tells you to enable logging.
 */
describe('setup status republishes', () => {
  it('clears setup-needed once the logging config is valid', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ht-tracker-'))
    const local = join(root, 'Local')
    const install = join(root, 'Hearthstone')
    await fs.mkdir(join(local, 'Blizzard', 'Hearthstone'), { recursive: true })
    await fs.mkdir(install, { recursive: true })
    process.env.LOCALAPPDATA = local

    const { Store } = await import('../src/main/store')
    const { Tracker } = await import('../src/main/tracker')
    const { ensureLogConfig } = await import('../src/main/logs/hsPaths')

    const store = new Store(root)
    store.updateSettings({ hearthstonePath: install })
    const tracker = new Tracker(store, join(root, 'carddata'))

    // Nothing has checked the config yet, so the tracker is still on its initial
    // "logging is off" assumption — the state a user sees on first launch.
    expect(tracker.snapshot().status).toBe('setup-needed')

    await ensureLogConfig(install)

    const published: BgSnapshot[] = []
    tracker.on('snapshot', (s: BgSnapshot) => published.push(s))
    const status = await tracker.setupStatus()

    expect(status.logConfigOk).toBe(true)
    expect(published).not.toHaveLength(0)
    expect(published.at(-1)?.status).not.toBe('setup-needed')
    expect(tracker.snapshot().status).not.toBe('setup-needed')

    tracker.stop()
    await fs.rm(root, { recursive: true, force: true })
  })
})
