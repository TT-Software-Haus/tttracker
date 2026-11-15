import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Build } from '../src/shared/types'

/**
 * Builds are the only thing in the app the user authors by hand, so losing them
 * on restart is the one failure that actually costs work. This covers the full
 * round trip through disk, which the UI can't prove on its own.
 */
describe('build storage', () => {
  const build = (over: Partial<Build> = {}): Build => ({
    id: 'b1',
    name: 'Scam murlocs',
    tribe: 'MURLOC',
    targets: [{ byTurn: 6, cardIds: ['BG_EX1_509'] }],
    ...over,
  })

  it('survives a restart, and saves replace rather than duplicate', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ht-builds-'))
    const { Store } = await import('../src/main/store')

    const first = new Store(dir)
    expect(first.builds).toEqual([])
    first.saveBuild(build())
    first.saveBuild(build({ id: 'b2', name: 'Beasts', tribe: 'BEAST' }))
    // Editing an existing build must update it in place, not append a second copy.
    first.saveBuild(build({ name: 'Scam murlocs v2' }))
    await first.flushAll()

    const restarted = new Store(dir)
    expect(restarted.builds.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(restarted.builds[0].name).toBe('Scam murlocs v2')
    expect(restarted.builds[0].targets).toEqual([{ byTurn: 6, cardIds: ['BG_EX1_509'] }])

    restarted.deleteBuild('b1')
    await restarted.flushAll()
    expect(new Store(dir).builds.map((b) => b.id)).toEqual(['b2'])
  })

  it('starts empty when the file is missing or corrupt', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ht-builds-'))
    await fs.writeFile(join(dir, 'builds.json'), '{ not json')
    const { Store } = await import('../src/main/store')
    expect(new Store(dir).builds).toEqual([])
  })
})
