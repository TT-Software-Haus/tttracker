// Regression: two Duos fights where only simulating the first pair of boards
// predicted a win, but the opponents' second warband won the fight.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { CardDb } from '../src/main/cards/cardDb'
import { Game } from '../src/main/game/game'
import { BgGame } from '../src/main/bg/bgGame'

const fixtures = join(__dirname, 'fixtures')

describe('Duos fights include both teammates’ warbands', () => {
  const db = new CardDb()
  db.load(JSON.parse(readFileSync(join(fixtures, 'cards-reserves.json'), 'utf8')))
  const game = new Game('GameState') // fixtures keep only GameState lines
  const bg = new BgGame(game, db)
  bg.simIterations = 2000
  for (const l of gunzipSync(readFileSync(join(fixtures, 'bg-duos-reserves.log.gz'))).toString().split('\n')) game.handleLine(l)
  const rounds = bg.snapshot().rounds

  it('finds all four warbands for each fight', () => {
    for (const r of rounds) {
      expect(r.oppReserve?.length).toBeGreaterThan(0)
      expect(r.myReserve?.length).toBeGreaterThan(0)
      expect(r.oppReserve!.length).toBeLessThanOrEqual(7)
    }
  })

  it('keeps hand cards out of the boards', () => {
    const t7 = rounds.find((r) => r.round === 7)!
    expect(t7.oppReserve!.map((m) => m.name)).not.toContain('Bream Counter') // was in hand
  })

  it('predicts the losses that actually happened', () => {
    for (const r of rounds) {
      expect(r.result).toBe('LOST')
      expect(r.odds!.loss).toBeGreaterThan(0.6)
      expect(r.odds!.partial).toBeFalsy()
    }
  })
})
