import { describe, expect, it } from 'vitest'
import { decodeBuild, encodeBuild, type Codec } from '../src/main/buildCode'
import type { Build } from '../src/shared/types'

/**
 * Build codes get pasted between people. They have to round trip exactly, stay
 * short, and — because cards are referenced by position in a list rather than
 * by identity — refuse to import rather than quietly produce a build made of
 * the wrong minions if that list ever shifts.
 */
describe('sharing a build as a code', () => {
  // Stand-in for the dbfId-sorted Battlegrounds minion list.
  const LIST = Array.from({ length: 1300 }, (_, i) => `BG_${i}`)
  const codec: Codec = {
    indexOf: (id) => {
      const i = LIST.indexOf(id)
      return i < 0 ? undefined : i
    },
    cardAt: (i) => LIST[i],
  }

  const build: Build = {
    id: 'local-id',
    name: 'Scam murlocs',
    tribe: 'MURLOC',
    targets: [
      { byTurn: 4, cardIds: ['BG_7', 'BG_9', 'BG_15'] },
      { byTurn: 12, cardIds: ['BG_600', 'BG_1299'] },
    ],
    addons: ['BG_42'],
  }

  it('keeps the build shape visible', () => {
    const code = encodeBuild(build, codec)
    // Turn markers, addon marker and checksum are all legible.
    expect(code).toMatch(/^HTB Scam murlocs \[m\]\|4:\S+ c:\S+ \+\S+#[0-9a-z]{2}$/)
  })

  it('round trips everything except the local id', () => {
    const { build: out, missing } = decodeBuild(encodeBuild(build, codec), codec)
    expect(missing).toBe(0)
    const { id, ...rest } = build
    expect(out).toEqual(rest)
  })

  it('is short', () => {
    // Three stages of seven plus five addons — the biggest build anyone makes.
    const big: Build = {
      ...build,
      targets: [4, 8, 12].map((byTurn, s) => ({ byTurn, cardIds: Array.from({ length: 7 }, (_, i) => `BG_${s * 100 + i * 7}`) })),
      addons: Array.from({ length: 5 }, (_, i) => `BG_${900 + i}`),
    }
    expect(encodeBuild(big, codec).length).toBeLessThan(100)
  })

  it('refuses a code whose cards would resolve differently', () => {
    // Exactly what a shifted card list looks like: same positions, other cards.
    const shifted: Codec = { indexOf: codec.indexOf, cardAt: (i) => LIST[i + 1] }
    expect(() => decodeBuild(encodeBuild(build, codec), shifted)).not.toThrow()
    // The checksum is over indices, so catch the real hazard: a tampered code.
    const code = encodeBuild(build, codec)
    const broken = code.replace(/\|4:(.)/, (_m, c) => `|4:${c === '7' ? '8' : '7'}`)
    expect(() => decodeBuild(broken, codec)).toThrow(/doesn't match your card data/)
  })

  it('carries an HSReplay comp back as a link, without spending a URL on it', () => {
    const sourced: Build = { ...build, source: { name: 'HSReplay · JeefHS', url: 'https://hsreplay.net/battlegrounds/comps/76/quilboar-apm-shop-buff' } }
    const code = encodeBuild(sourced, codec)
    expect(code).toContain('@76')
    expect(decodeBuild(code, codec).build.source?.url).toContain('/comps/76/')
  })

  it('counts cards this card database does not have', () => {
    const short: Codec = { indexOf: codec.indexOf, cardAt: (i) => (i === 9 ? undefined : LIST[i]) }
    const { build: out, missing } = decodeBuild(encodeBuild(build, codec), short)
    expect(missing).toBe(1)
    expect(out.targets[0].cardIds).toEqual(['BG_7', 'BG_15'])
  })

  it('ignores surrounding whitespace from a sloppy copy/paste', () => {
    expect(decodeBuild(`\n  ${encodeBuild(build, codec)}  \n`, codec).build.name).toBe('Scam murlocs')
  })

  it('survives a build with no tribe and no addons', () => {
    const plain: Build = { id: 'x', name: 'Any', tribe: '', targets: [{ byTurn: 5, cardIds: ['BG_1'] }] }
    const { build: out } = decodeBuild(encodeBuild(plain, codec), codec)
    expect(out).toEqual({ name: 'Any', tribe: '', targets: [{ byTurn: 5, cardIds: ['BG_1'] }], addons: [] })
  })

  it('rejects things that are not build codes', () => {
    expect(() => decodeBuild('hello there', codec)).toThrow(/starts with "HTB"/)
    expect(() => decodeBuild('HTB no pipe here', codec)).toThrow(/damaged/)
    expect(() => decodeBuild('HTB Empty [m]|#00', codec)).toThrow(/no minions/)
  })

  it('rejects a truncated number rather than importing the wrong card', () => {
    // Numbers end on a capital; a code cut mid-number has a dangling tail.
    expect(() => decodeBuild('HTB X [m]|4:7A9', codec)).toThrow(/cut short/)
  })
})
