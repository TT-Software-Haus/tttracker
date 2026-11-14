import { describe, expect, it } from 'vitest'
import { CardDb } from '../src/main/cards/cardDb'
import { Game } from '../src/main/game/game'
import { BgGame } from '../src/main/bg/bgGame'
import type { SimOdds } from '../src/shared/types'

/**
 * Sims run on a worker in the app (on the main thread they froze the user's
 * mouse), so odds arrive after the combat starts. A Duos resim must win over
 * the first sim of the same round whatever order they finish in.
 */
describe('odds from an async simulator', () => {
  const odds = (win: number) => ({ win, tie: 0, loss: 1 - win }) as unknown as SimOdds
  const setup = () => {
    const bg = new BgGame(new Game('GameState'), new CardDb()) as any
    const resolvers: ((o: SimOdds) => void)[] = []
    bg.simulate = () => new Promise<SimOdds>((r) => resolvers.push(r))
    bg.simJob = () => ({ a: {}, b: {}, opts: {}, partial: false })
    let changes = 0
    bg.onChange = () => changes++
    return { bg, resolvers, changes: () => changes }
  }

  it('fills in the odds when the sim answers', async () => {
    const { bg, resolvers, changes } = setup()
    const round = { round: 3, myBoard: [], oppBoard: [] } as any
    bg.simulateInto(round, {})
    expect(round.odds).toBeUndefined()
    resolvers[0](odds(0.7))
    await Promise.resolve()
    expect(round.odds.win).toBe(0.7)
    expect(changes()).toBe(1)
  })

  it("keeps a resim's odds even if the first sim answers last", async () => {
    const { bg, resolvers } = setup()
    const round = { round: 3, myBoard: [], oppBoard: [] } as any
    bg.simulateInto(round, {})
    bg.simulateInto(round, {}) // a teammate's warband came in
    resolvers[1](odds(0.4))
    resolvers[0](odds(0.9))
    await Promise.resolve()
    expect(round.odds.win).toBe(0.4)
  })
})
