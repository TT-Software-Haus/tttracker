import { describe, expect, it } from 'vitest'
import { decodeBuild, encodeBuild } from '../src/main/buildCode'
import type { Build } from '../src/shared/types'

/**
 * Build codes get pasted between people, so they have to survive a round trip
 * exactly, stay short enough to share, and fail clearly on junk rather than
 * producing a plausible-looking wrong build.
 */
describe('sharing a build as a code', () => {
  const CARDS: Record<string, number> = { BG_A: 110664, BG_B: 130298, BG_C: 96786, BG_D: 95265, BG_E: 132881 }
  const dbfOf = (id: string) => CARDS[id]
  const idOf = (d: number) => Object.keys(CARDS).find((k) => CARDS[k] === d)

  const build: Build = {
    id: 'local-id',
    name: 'Scam murlocs',
    tribe: 'MURLOC',
    targets: [
      { byTurn: 4, cardIds: ['BG_A', 'BG_B'] },
      { byTurn: 9, cardIds: ['BG_C', 'BG_D', 'BG_E'] },
    ],
    addons: ['BG_B'],
  }

  it('round trips everything except the local id', () => {
    const { build: out, missing } = decodeBuild(encodeBuild(build, dbfOf), idOf)
    expect(missing).toBe(0)
    const { id, ...rest } = build
    expect(out).toEqual(rest)
  })

  it('carries the original source when there is one', () => {
    const sourced: Build = { ...build, source: { name: 'HSReplay · JeefHS', url: 'https://hsreplay.net/x' } }
    const { build: out } = decodeBuild(encodeBuild(sourced, dbfOf), idOf)
    expect(out.source).toEqual(sourced.source)
  })

  it('stays short enough to paste into a message', () => {
    // Five stages of seven, the biggest build anyone would make.
    const big: Build = {
      ...build,
      name: 'A reasonably long build name',
      targets: Array.from({ length: 5 }, (_, i) => ({ byTurn: i * 3 + 4, cardIds: ['BG_A', 'BG_B', 'BG_C', 'BG_D', 'BG_E', 'BG_A', 'BG_B'] })),
    }
    expect(encodeBuild(big, dbfOf).length).toBeLessThan(300)
  })

  it('reports cards this card database does not know, rather than hiding them', () => {
    const code = encodeBuild(build, dbfOf)
    const { build: out, missing } = decodeBuild(code, (d) => (d === 96786 ? undefined : idOf(d)))
    expect(missing).toBe(1)
    expect(out.targets[1].cardIds).toEqual(['BG_D', 'BG_E'])
  })

  it('rejects something that is not a build code', () => {
    expect(() => decodeBuild('hello', idOf)).toThrow(/doesn't look like a build code/)
  })

  it('rejects a truncated code rather than importing half a build', () => {
    const code = encodeBuild(build, dbfOf)
    expect(() => decodeBuild(code.slice(0, code.length - 8), idOf)).toThrow(/damaged or incomplete/)
  })

  it('ignores surrounding whitespace from a sloppy copy/paste', () => {
    const code = encodeBuild(build, dbfOf)
    expect(decodeBuild(`\n  ${code}  \n`, idOf).build.name).toBe('Scam murlocs')
  })

  it('survives a build with no stages and no addons', () => {
    const empty: Build = { id: 'x', name: 'Empty', tribe: '', targets: [] }
    const { build: out } = decodeBuild(encodeBuild(empty, dbfOf), idOf)
    expect(out).toEqual({ name: 'Empty', tribe: '', targets: [], addons: [] })
  })
})
