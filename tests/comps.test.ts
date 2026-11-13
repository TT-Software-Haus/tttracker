import { describe, expect, it } from 'vitest'
import { parseCompsPage } from '../src/main/comps'

/**
 * HSReplay has no API for this — the comps are read out of a JSON blob the page
 * server-renders. That's somebody else's page, so it will change without
 * warning; these tests say what we currently depend on, and that we fail
 * loudly rather than silently importing nothing.
 */
describe('reading the HSReplay comps page', () => {
  const page = (comps: unknown) => `<html><head><title>x</title>
    <script id="userdata" type="application/json">{"site":{}}</script>
    <script type="application/json" id="react_context">${JSON.stringify({ comps, season_number: 14 })}</script>
    </head><body></body></html>`

  const quilboar = {
    comp_id: 76,
    comp_name: 'Quilboar - APM Shop Buff',
    comp_slug: 'quilboar-apm-shop-buff',
    comp_tier: 1,
    comp_difficulty: 1,
    comp_summary: 'Cast spells to consume buffed shop.',
    comp_core_cards: [110664, 130298],
  }
  const ids: Record<number, string> = { 110664: 'BG28_633', 130298: 'BG36_701' }
  const lookup = (d: number) => ids[d]

  it('reads a comp and takes the tribe from its name', () => {
    expect(parseCompsPage(page([quilboar]), lookup)).toEqual([
      {
        id: 76,
        name: 'Quilboar - APM Shop Buff',
        tribe: 'QUILBOAR',
        summary: 'Cast spells to consume buffed shop.',
        tier: 1,
        difficulty: 1,
        cardIds: ['BG28_633', 'BG36_701'],
        url: 'https://hsreplay.net/battlegrounds/comps/76/quilboar-apm-shop-buff',
      },
    ])
  })

  it('leaves the tribe empty for a comp that has none', () => {
    // "Menagerie" is the one comp in the list with no tribe prefix; an empty
    // tribe means the build is offered in every lobby.
    const comp = parseCompsPage(page([{ ...quilboar, comp_name: 'Menagerie' }]), lookup)[0]
    expect(comp.tribe).toBe('')
  })

  it('drops core cards the card database does not know', () => {
    const comp = parseCompsPage(page([quilboar]), (d) => (d === 110664 ? 'BG28_633' : undefined))[0]
    expect(comp.cardIds).toEqual(['BG28_633'])
  })

  it('throws when the page no longer has the blob, rather than importing nothing', () => {
    expect(() => parseCompsPage('<html><body>Just a moment…</body></html>', lookup)).toThrow(/changed its page layout/)
  })

  it('survives the comps list being absent', () => {
    expect(parseCompsPage(page(undefined), lookup)).toEqual([])
  })
})
