// Replays a real (anonymised) Duos log the way the live tracker does: the
// animation-synced PowerTaskList stream drives everything, with the GameState
// stream as lookahead for the hidden warband copies.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { CardDb } from '../src/main/cards/cardDb'
import { Game } from '../src/main/game/game'
import { BgGame } from '../src/main/bg/bgGame'
import type { BgMatch } from '../src/shared/types'

const fixtures = join(__dirname, 'fixtures')

describe('live replay (PowerTaskList + GameState lookahead)', () => {
  const db = new CardDb()
  db.load(JSON.parse(readFileSync(join(fixtures, 'cards-both-streams.json'), 'utf8')))
  const game = new Game('PowerTaskList')
  const lookahead = new Game('GameState')
  const bg = new BgGame(game, db, lookahead)
  bg.simIterations = 2000
  const saved: BgMatch[] = []
  bg.onMatchEnd = (m) => saved.push(m)

  // Record what the odds overlay would show, in log order.
  const shown: string[] = []
  bg.onChange = () => {
    const c = bg.snapshot().combat
    if (c?.odds) shown.push(`${c.round}:${c.result ?? '-'}:${Math.round(c.odds.loss * 100)}`)
  }
  const lines = gunzipSync(readFileSync(join(fixtures, 'bg-duos-both-streams.log.gz'))).toString().split('\n')
  for (const l of lines) {
    lookahead.handleLine(l)
    game.handleLine(l)
  }
  bg.flushPendingMatch()

  it('sees all four warbands even though PowerTaskList hides their details', () => {
    const r = bg.snapshot().rounds.at(-1)!
    expect(r.oppReserve?.length).toBeGreaterThan(0)
    expect(r.myReserve?.length).toBeGreaterThan(0)
  })

  it("carries a golden's normal card from the card data, for build matching", () => {
    const s = bg.snapshot()
    const all = [...s.rounds.flatMap((r) => [...r.myBoard, ...r.oppBoard]), ...s.board, ...s.hand, ...s.shop]
    const goldens = all.filter((m) => db.get(m.cardId)?.normalId)
    expect(goldens.length).toBeGreaterThan(0)
    for (const m of goldens) expect(m.normalId).toBe(db.get(m.cardId)!.normalId)
    expect(all.filter((m) => !db.get(m.cardId)?.normalId).every((m) => m.normalId === undefined)).toBe(true)
  })

  it('never shows a result before the odds (no spoilers) and predicts the loss', () => {
    const first = shown[0]
    expect(first.split(':')[1]).toBe('-') // odds first, result later
    const final = bg.snapshot().rounds.at(-1)!
    expect(final.result).toBe('LOST')
    expect(final.odds!.loss).toBeGreaterThan(0.5)
  })

  it('saves the game when you are knocked out', () => {
    expect(saved).toHaveLength(1)
    expect(saved[0].mode).toBe('duos')
    expect(saved[0].placement).toBeGreaterThan(0)
  })
})

describe('combat sims that answer after the game is saved', () => {
  it('fills in the saved match and asks for it to be saved again', async () => {
    const db = new CardDb()
    db.load(JSON.parse(readFileSync(join(fixtures, 'cards-both-streams.json'), 'utf8')))
    const game = new Game('PowerTaskList')
    const lookahead = new Game('GameState')
    const bg = new BgGame(game, db, lookahead)
    // A worker that hasn't answered anything yet.
    const answers: (() => void)[] = []
    const odds = { win: 0.5, tie: 0, loss: 0.5, avgDamageTaken: 1, avgDamageDealt: 1, iterations: 1 }
    bg.simulate = () => new Promise((resolve) => answers.push(() => resolve(odds as never)))
    const saved: BgMatch[] = []
    let updates = 0
    bg.onMatchEnd = (m) => saved.push(m)
    bg.onMatchUpdated = () => updates++
    for (const l of gunzipSync(readFileSync(join(fixtures, 'bg-duos-both-streams.log.gz'))).toString().split('\n')) {
      lookahead.handleLine(l)
      game.handleLine(l)
    }
    bg.flushPendingMatch()
    expect(saved).toHaveLength(1)
    expect(answers.length).toBeGreaterThan(0)
    expect(updates).toBe(0)

    for (const answer of answers) answer()
    await new Promise((r) => setTimeout(r, 0))
    expect(updates).toBeGreaterThan(0)
    expect(saved[0].combats.some((r) => r.odds?.win === 0.5)).toBe(true)
  })
})
