// The tavern's current offerings, replayed from a real log.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { CardDb } from '../src/main/cards/cardDb'
import { Game } from '../src/main/game/game'
import { BgGame } from '../src/main/bg/bgGame'

const fixtures = join(__dirname, 'fixtures')

/**
 * The shop sits in the *other* player's PLAY zone — the same slot that holds
 * the opponent's warband mid-fight. That overlap is the whole risk here: read
 * it one phase late and the "tavern" is actually the board you're fighting.
 */
describe('reading the tavern', () => {
  function replayTo(stopAfterLines: number) {
    const db = new CardDb()
    db.load(JSON.parse(readFileSync(join(fixtures, 'cards-reserves.json'), 'utf8')))
    const game = new Game('GameState')
    const bg = new BgGame(game, db)
    bg.simIterations = 1
    const lines = gunzipSync(readFileSync(join(fixtures, 'bg-duos-reserves.log.gz'))).toString().split('\n')
    for (const l of lines.slice(0, stopAfterLines)) game.handleLine(l)
    return bg.snapshot()
  }

  // Sampled across the whole fixture, so the assertions below can't pass by
  // the shop simply never being populated.
  const samples = Array.from({ length: 24 }, (_, i) => replayTo(1500 + i * 1500))
  const populated = samples.filter((s) => s.shop.length)

  it('actually reads the tavern', () => {
    expect(populated.length).toBeGreaterThan(3)
    // Round 6 of this fixture: a tier-3 tavern mid-shop.
    expect(replayTo(2500).shop.map((m) => m.name).sort()).toEqual(['Blue Volumizer', 'Friendly Saloonkeeper', 'Mummifier', 'Passenger'])
  })

  it('never reports a shop outside a shop phase', () => {
    // The same slot holds the opponent's warband mid-fight, so a missing phase
    // guard would quietly present the board you're fighting as "on offer".
    for (const s of samples) if (s.phase !== 'shop') expect(s.shop).toEqual([])
  })

  it('offers a plausible tavern, never a whole warband', () => {
    for (const s of populated) {
      expect(s.shop.length).toBeLessThanOrEqual(7)
      for (const m of s.shop) expect(m.name).toBeTruthy()
    }
  })

  it('always answers with an array, so the UI never has to guard', () => {
    expect(Array.isArray(replayTo(Number.MAX_SAFE_INTEGER).shop)).toBe(true)
  })
})
