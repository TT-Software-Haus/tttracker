// Live odds: re-simulated from the board as it is at each attack, shown while the fight is on,
// never saved (history keeps the opening odds).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { CardDb } from '../src/main/cards/cardDb'
import { Game } from '../src/main/game/game'
import { BgGame } from '../src/main/bg/bgGame'
import { Combat, mulberry32 } from '../src/main/bg/sim/engine'
import { newestOnly, Superseded } from '../src/main/bg/sim/newestOnly'
import type { BgMatch, SimOdds } from '../src/shared/types'

const fixtures = join(__dirname, 'fixtures')

describe('only the newest live sim runs', () => {
  it('a newer job replaces the one waiting; the running one finishes', async () => {
    const finish: ((v: string) => void)[] = []
    const ran: number[] = []
    const run = newestOnly((n: number) => {
      ran.push(n)
      return new Promise<string>((resolve) => finish.push(resolve))
    })
    const first = run(1)
    const second = run(2)
    const third = run(3)
    await expect(second).rejects.toBeInstanceOf(Superseded)
    finish[0]('one')
    expect(await first).toBe('one')
    await Promise.resolve()
    finish[1]('three')
    expect(await third).toBe('three')
    expect(ran).toEqual([1, 3])
  })
})

describe('the sim can start mid-fight', () => {
  it("resumes each side's attacks where the board says", () => {
    const m = { cardId: 'X', atk: 1, health: 1 }
    const c = new Combat(new CardDb(), mulberry32(1), { minions: [m, m, m], heroTier: 1, nextAttacker: 2 }, { minions: [m], heroTier: 1 })
    expect(c.sides.map((s) => s.nextAttacker)).toEqual([2, 0])
  })
})

describe('live odds over a real fight', () => {
  const db = new CardDb()
  db.load(JSON.parse(readFileSync(join(fixtures, 'cards-wingmen.json'), 'utf8')))
  const game = new Game('GameState') // fixtures keep only GameState lines
  const bg = new BgGame(game, db)
  bg.simIterations = 300
  // Round 3 is the Duos tie that opened at 100% loss before the Wingmen fix.
  const seen: SimOdds[] = []
  bg.onChange = () => {
    const live = bg.snapshot().rounds.find((r) => r.round === 3)?.liveOdds
    if (live && live !== seen[seen.length - 1]) seen.push(live)
  }
  // Without a worker (tests), BgGame sims inline and doesn't call onChange for it: poll per line.
  for (const l of gunzipSync(readFileSync(join(fixtures, 'bg-duos-wingmen.log.gz'))).toString().split('\n')) {
    game.handleLine(l)
    bg.onChange()
  }

  it('updates through the fight and ends on the real result', () => {
    expect(seen.length).toBeGreaterThan(5)
    expect(seen[seen.length - 1].tie).toBeGreaterThan(0.9)
  })

  it('is cleared when the fight ends, and never saved', () => {
    const r3 = bg.snapshot().rounds.find((r) => r.round === 3)!
    expect(r3.liveOdds).toBeUndefined()
    expect(r3.odds).toBeDefined()
    const saved: BgMatch[] = []
    bg.onMatchEnd = (m) => saved.push(m)
    ;(bg as unknown as { emitMatch(): void }).emitMatch()
    expect(saved[0].combats.every((c) => !('liveOdds' in c))).toBe(true)
  })
})
