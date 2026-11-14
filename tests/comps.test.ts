import { describe, expect, it } from 'vitest'
import { parseCompDetail, parseCompsPage } from '../src/main/comps'

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

/**
 * Addon cards and the How to Play guide live on each comp's own page, not the
 * list — a separate blob with a different shape, so it gets its own contract.
 */
describe("reading a comp's own page", () => {
  const page = (comp: unknown) => `<html><script type="application/json" id="react_context">${JSON.stringify(comp)}</script></html>`
  const ids: Record<number, string> = { 113152: 'BG_A', 122516: 'BG_B', 130662: 'BG_C' }
  const lookup = (d: number) => ids[d]

  it('reads the addon cards', () => {
    expect(parseCompDetail(page({ comp_id: 76, comp_addon_cards: [113152, 122516] }), lookup).addons).toEqual(['BG_A', 'BG_B'])
  })

  it('treats a comp with no addons or guide as empty, not broken', () => {
    expect(parseCompDetail(page({ comp_id: 76, comp_core_cards: [1] }), lookup)).toEqual({ addons: [], howToPlay: '' })
  })

  it('drops addon cards this card database does not know', () => {
    expect(parseCompDetail(page({ comp_id: 76, comp_addon_cards: [113152, 999999] }), lookup).addons).toEqual(['BG_A'])
  })

  it('keeps the How to Play card links verbatim, to be resolved at display time', () => {
    // Real text from the Quilboar comp page, trimmed.
    const text = 'Allowing [[Felboar||110664]] or [[Twisted Wrathguard||130662]] to eat a huge shop. '
    expect(parseCompDetail(page({ comp_how_to_play: text }), lookup).howToPlay).toBe(text.trim())
  })

  it('throws when the page no longer has the blob', () => {
    expect(() => parseCompDetail('<html>Just a moment…</html>', lookup)).toThrow(/changed its page layout/)
  })
})
