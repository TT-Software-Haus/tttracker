import { describe, expect, it } from 'vitest'
import { CardDb } from '../src/main/cards/cardDb'
import { Game } from '../src/main/game/game'
import { BgGame } from '../src/main/bg/bgGame'

/**
 * Hearthstone logs a golden from a triple as a copy of one of the three
 * (COPIED_FROM_ENTITY_ID), the same tag it puts on the copies it makes for a
 * fight. Dropping every copy lost goldens from your hand (seen live).
 */
describe('copies in your hand', () => {
  const bg = new BgGame(new Game('GameState'), new CardDb()) as any
  const entities: Map<number, { id: number; tags: Record<string, string> }> = bg.game.entities
  const add = (id: number, tags: Record<string, string>) => entities.set(id, { id, tags } as never)

  it('keeps a golden whose originals were set aside', () => {
    add(1, { ZONE: 'SETASIDE' })
    add(2, { ZONE: 'HAND', COPIED_FROM_ENTITY_ID: '1', PREMIUM: '1' })
    expect(bg.isFightCopy(entities.get(2))).toBe(false)
  })

  it('drops a fight copy of a card still in a hand', () => {
    add(3, { ZONE: 'HAND' })
    add(4, { ZONE: 'HAND', COPIED_FROM_ENTITY_ID: '3' })
    expect(bg.isFightCopy(entities.get(4))).toBe(true)
  })

  it('keeps an ordinary card', () => {
    add(5, { ZONE: 'HAND' })
    expect(bg.isFightCopy(entities.get(5))).toBe(false)
  })
})
