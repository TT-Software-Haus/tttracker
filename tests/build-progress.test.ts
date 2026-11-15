import { describe, expect, it } from 'vitest'
import { buildProgress } from '../src/renderer/src/lib'
import type { BoardMinion, Build } from '../src/shared/types'

/**
 * Picking the wrong stage shows the wrong minions at a glance, mid-shop, which
 * is worse than showing nothing. These are the turns where the choice is
 * actually ambiguous.
 */
describe('tracking progress against a build', () => {
  const build: Build = {
    id: 'b1',
    name: 'Scam murlocs',
    tribe: 'MURLOC',
    targets: [
      { byTurn: 4, cardIds: ['BG_A', 'BG_B'] },
      { byTurn: 8, cardIds: ['BG_C', 'BG_D', 'BG_E'] },
    ],
  }
  const minion = (cardId: string): BoardMinion => ({ cardId, name: cardId, atk: 1, health: 1, tier: 1, golden: false })

  it('works towards the first stage before its turn', () => {
    const p = buildProgress(build, 2, [])
    expect(p?.stage.byTurn).toBe(4)
    expect(p?.turnsLeft).toBe(2)
    expect(p?.final).toBe(false)
  })

  it('still shows a stage on its deadline turn, not the next one', () => {
    // On turn 4 you are still trying to finish the turn-4 board.
    expect(buildProgress(build, 4, [])?.stage.byTurn).toBe(4)
  })

  it('moves to the next stage once the deadline passes', () => {
    const p = buildProgress(build, 5, [])
    expect(p?.stage.byTurn).toBe(8)
    expect(p?.turnsLeft).toBe(3)
  })

  it('stays on the last stage rather than running out of advice', () => {
    const p = buildProgress(build, 14, [])
    expect(p?.stage.byTurn).toBe(8)
    expect(p?.final).toBe(true)
    expect(p?.turnsLeft).toBe(-6) // overdue, for the UI to phrase
  })

  it('ticks off what you already have', () => {
    const p = buildProgress(build, 7, [minion('BG_C'), minion('BG_X')])
    expect(p?.have).toBe(1)
    expect(p?.minions).toEqual([
      { cardId: 'BG_C', have: true, inShop: false },
      { cardId: 'BG_D', have: false, inShop: false },
      { cardId: 'BG_E', have: false, inShop: false },
    ])
  })

  it('flags a wanted minion that is in the tavern right now', () => {
    const p = buildProgress(build, 7, [], [minion('BG_D'), minion('BG_Z')])
    expect(p?.minions.find((m) => m.cardId === 'BG_D')?.inShop).toBe(true)
    expect(p?.minions.find((m) => m.cardId === 'BG_E')?.inShop).toBe(false)
  })

  it('does not nag about a minion in the shop that you already own', () => {
    // Shops offer duplicates constantly; "buy this" is noise once you have it.
    const p = buildProgress(build, 7, [minion('BG_C')], [minion('BG_C')])
    expect(p?.minions.find((m) => m.cardId === 'BG_C')).toEqual({ cardId: 'BG_C', have: true, inShop: false })
  })

  it('matches a golden copy sitting in the tavern', () => {
    const p = buildProgress(build, 7, [], [minion('BG_D_G')])
    expect(p?.minions.find((m) => m.cardId === 'BG_D')?.inShop).toBe(true)
  })

  it('counts a golden copy as having the minion', () => {
    // Tripling into a golden must not read as "you still need this".
    expect(buildProgress(build, 7, [minion('BG_C_G')])?.have).toBe(1)
  })

  it("counts a golden whose id doesn't end in _G, by the card data's normal id", () => {
    // BG19_010_Gt is golden BG19_010t; stripping "_G" leaves it unmatched.
    const token: Build = { ...build, targets: [{ byTurn: 8, cardIds: ['BG19_010t'] }] }
    const golden = { ...minion('BG19_010_Gt'), golden: true, normalId: 'BG19_010t' }
    expect(buildProgress(token, 7, [golden])?.have).toBe(1)
  })

  it('needs one owned copy per slot when a stage wants a minion twice', () => {
    const two: Build = { ...build, targets: [{ byTurn: 8, cardIds: ['BG_C', 'BG_C', 'BG_D'] }] }
    const p = buildProgress(two, 7, [minion('BG_C')], [minion('BG_C')])
    expect(p?.have).toBe(1)
    expect(p?.minions).toEqual([
      { cardId: 'BG_C', have: true, inShop: false },
      { cardId: 'BG_C', have: false, inShop: true }, // the second copy is still worth buying
      { cardId: 'BG_D', have: false, inShop: false },
    ])
  })

  it('handles a build with no stages at all', () => {
    expect(buildProgress({ ...build, targets: [] }, 3, [])).toBeUndefined()
  })

  it('reads stages in turn order even when stored out of order', () => {
    const jumbled: Build = { ...build, targets: [build.targets[1], build.targets[0]] }
    expect(buildProgress(jumbled, 2, [])?.stage.byTurn).toBe(4)
  })
})
