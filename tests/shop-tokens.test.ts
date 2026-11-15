import { describe, expect, it } from 'vitest'
import { CardDb } from '../src/main/cards/cardDb'
import { Game } from '../src/main/game/game'
import { BgGame } from '../src/main/bg/bgGame'

/**
 * Seen live: Dark Paradox (BG36_360t3), a token created into the tavern, is on
 * offer without IS_BACON_POOL_MINION, so the shop left it out and it got no
 * highlight box even though the screen-vs-log card count included it.
 */
describe('what the tavern offers', () => {
  it('includes every minion with a tavern slot, pool minion or not', () => {
    const bg = new BgGame(new Game('GameState'), new CardDb()) as any
    const DUMMY = 9
    bg.dummyPlayerId = () => DUMMY
    const add = (id: number, tags: Record<string, string>, cardId: string) =>
      bg.game.entities.set(id, { id, cardId, tags: { ZONE: 'PLAY', CONTROLLER: String(DUMMY), ...tags } })
    add(1, { CARDTYPE: 'MINION', ZONE_POSITION: '1', IS_BACON_POOL_MINION: '1' }, 'BG31_818')
    add(2, { CARDTYPE: 'MINION', ZONE_POSITION: '2' }, 'BG36_360t3') // the token
    add(3, { CARDTYPE: 'BATTLEGROUND_SPELL', ZONE_POSITION: '3' }, 'BG28_500') // a spell: a slot, not a minion
    add(4, { CARDTYPE: 'MINION', ZONE_POSITION: '0' }, 'BG00_000') // in play, but no slot
    bg.game.controllerOf = (e: any) => Number(e.tags.CONTROLLER)
    const shop = bg.shopMinions()
    expect(shop.map((m: any) => `${m.pos}:${m.cardId}`)).toEqual(['1:BG31_818', '2:BG36_360t3'])
    expect(bg.tavernSize()).toBe(3)
  })
})
