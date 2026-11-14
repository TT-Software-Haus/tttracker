// Regression: a Duos fight that tied, predicted as a certain loss. Our teammate's
// warband came in under Illidan, whose Wingmen (Start of Combat: left- and
// right-most minions gain +2/+1 and attack immediately) made Dark Paradox a 9/9,
// enough to survive Crackling Cyclone. Reserves are copied before the fight, so
// their hero power has to run in the sim as they enter.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { CardDb } from '../src/main/cards/cardDb'
import { Game } from '../src/main/game/game'
import { BgGame } from '../src/main/bg/bgGame'
import { Combat, mulberry32 } from '../src/main/bg/sim/engine'

const fixtures = join(__dirname, 'fixtures')

describe('Duos reserves fire their hero power as they enter', () => {
  const db = new CardDb()
  db.load(JSON.parse(readFileSync(join(fixtures, 'cards-wingmen.json'), 'utf8')))
  const game = new Game('GameState') // fixtures keep only GameState lines
  const bg = new BgGame(game, db)
  bg.simIterations = 2000
  for (const l of gunzipSync(readFileSync(join(fixtures, 'bg-duos-wingmen.log.gz'))).toString().split('\n')) game.handleLine(l)
  const r3 = bg.snapshot().rounds.find((r) => r.round === 3)!

  it('predicts the tie that actually happened', () => {
    expect(r3.result).toBe('TIED')
    expect(r3.odds!.tie).toBeGreaterThan(0.6)
    expect(r3.odds!.unsupported).toEqual([])
  })

  it('applies Wingmen: +2/+1 to the outer minions, which attack immediately', () => {
    // A blank 1/10 (Prisonguard's text is shop-only) three times, entering against a 0/1000 wall.
    const blank = { cardId: 'BG36_345', atk: 1, health: 10 }
    const c = new Combat(db, mulberry32(1), { minions: [], heroTier: 2, reserve: { minions: [blank, blank, blank], heroTier: 2, heroPower: 'TB_BaconShop_HP_069' } }, { minions: [{ ...blank, atk: 0, health: 1000 }], heroTier: 2 })
    // Bring the reserve in and stop before the normal attack loop.
    ;(c as unknown as { bringInReserves(): boolean }).bringInReserves()
    const [left, mid, right] = c.sides[0].minions
    expect([left.atk, left.maxHp, mid.atk, mid.maxHp, right.atk, right.maxHp]).toEqual([3, 11, 1, 10, 3, 11])
    // Both outer minions already swung: 3 + 3 damage to the wall.
    expect(c.sides[1].minions[0].hp).toBe(994)
  })
})
