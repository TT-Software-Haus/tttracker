import { describe, expect, it } from 'vitest'
import { decodeBuild, encodeBuild } from '../src/main/buildCode'
import type { Build } from '../src/shared/types'

/**
 * Builds are shared as text people read and edit, so the format has to survive
 * a round trip, tolerate hand-editing and sloppy pasting, and fail by naming
 * what it couldn't find rather than silently handing over a short board.
 */
describe('sharing a build as text', () => {
  const NAMES: Record<string, string> = {
    BG_A: 'Murloc Tidecaller',
    BG_B: 'Murloc Tidehunter',
    BG_C: 'Primalfin Lookout',
    BG_D: 'Bloodlust Warleader',
    BG_E: 'Agamaggan, the Great Boar',
    BG_F: 'Zapp Slywick',
  }
  const nameOf = (id: string) => NAMES[id]
  const idOf = (n: string) => Object.keys(NAMES).find((k) => NAMES[k].toLowerCase() === n.toLowerCase())

  const build: Build = {
    id: 'local-id',
    name: 'Scam murlocs',
    tribe: 'MURLOC',
    targets: [
      { byTurn: 4, cardIds: ['BG_A', 'BG_B'] },
      { byTurn: 9, cardIds: ['BG_C', 'BG_D'] },
    ],
    addons: ['BG_F'],
  }

  it('is readable', () => {
    expect(encodeBuild(build, nameOf)).toBe(
      ['HTB Scam murlocs [Murlocs]', 'T4: Murloc Tidecaller; Murloc Tidehunter', 'T9: Primalfin Lookout; Bloodlust Warleader', '+: Zapp Slywick'].join('\n'),
    )
  })

  it('round trips everything except the local id', () => {
    const { build: out, missing } = decodeBuild(encodeBuild(build, nameOf), idOf)
    expect(missing).toEqual([])
    const { id, ...rest } = build
    expect(out).toEqual(rest)
  })

  it('handles card names containing a comma', () => {
    // 51 pool names have one, which is why minions are split on ";".
    const withComma: Build = { ...build, targets: [{ byTurn: 5, cardIds: ['BG_E', 'BG_A'] }] }
    const { build: out, missing } = decodeBuild(encodeBuild(withComma, nameOf), idOf)
    expect(missing).toEqual([])
    expect(out.targets[0].cardIds).toEqual(['BG_E', 'BG_A'])
  })

  it('carries the original source when there is one', () => {
    const sourced: Build = { ...build, source: { name: 'HSReplay · JeefHS', url: 'https://hsreplay.net/battlegrounds/comps/76/x' } }
    expect(decodeBuild(encodeBuild(sourced, nameOf), idOf).build.source).toEqual(sourced.source)
  })

  it('accepts a build pasted onto one line', () => {
    // Some chats strip newlines, so "|" works as a row separator too.
    const oneLine = 'HTB Scam murlocs [Murlocs] | T4: Murloc Tidecaller; Murloc Tidehunter | +: Zapp Slywick'
    const { build: out } = decodeBuild(oneLine, idOf)
    expect(out.targets).toEqual([{ byTurn: 4, cardIds: ['BG_A', 'BG_B'] }])
    expect(out.addons).toEqual(['BG_F'])
  })

  it('tolerates hand-editing: odd spacing, casing and a trailing separator', () => {
    const edited = '  HTB  My build  [murlocs]\n t4 :  murloc tidecaller ;  MURLOC TIDEHUNTER ; \n'
    const { build: out, missing } = decodeBuild(edited, idOf)
    expect(missing).toEqual([])
    expect(out.name).toBe('My build')
    expect(out.tribe).toBe('MURLOC')
    expect(out.targets[0].cardIds).toEqual(['BG_A', 'BG_B'])
  })

  it('names what it could not find, so the line can be fixed', () => {
    const { build: out, missing } = decodeBuild('HTB X [Murlocs]\nT4: Murloc Tidecaller; Nonexistent Minion', idOf)
    expect(missing).toEqual(['Nonexistent Minion'])
    expect(out.targets[0].cardIds).toEqual(['BG_A'])
  })

  it('ignores a line someone added as a note', () => {
    const { build: out } = decodeBuild('HTB X [Murlocs]\nplay this when you have spare gold\nT4: Murloc Tidecaller', idOf)
    expect(out.targets).toEqual([{ byTurn: 4, cardIds: ['BG_A'] }])
  })

  it('rejects something that is not a build', () => {
    expect(() => decodeBuild('hello there', idOf)).toThrow(/starts with "HTB"/)
  })

  it('rejects a build with no minions rather than creating an empty one', () => {
    expect(() => decodeBuild('HTB Just a name [Murlocs]', idOf)).toThrow(/no minions in it/)
  })

  it('survives a build with no tribe', () => {
    const anyTribe: Build = { ...build, tribe: '', addons: [] }
    const text = encodeBuild(anyTribe, nameOf)
    expect(text.split('\n')[0]).toBe('HTB Scam murlocs')
    expect(decodeBuild(text, idOf).build.tribe).toBe('')
  })
})
