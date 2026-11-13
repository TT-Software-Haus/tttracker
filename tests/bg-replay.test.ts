// Replays a real (anonymised) Battlegrounds Duos log and checks what the tracker extracts.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { CardDb } from '../src/main/cards/cardDb'
import { Game } from '../src/main/game/game'
import { BgGame } from '../src/main/bg/bgGame'

const fixtures = join(__dirname, 'fixtures')

function replay() {
  const db = new CardDb()
  db.load(JSON.parse(readFileSync(join(fixtures, 'cards-subset.json'), 'utf8')))
  const game = new Game('GameState') // fixtures keep only GameState lines
  const bg = new BgGame(game, db)
  bg.simIterations = 500
  const lines = gunzipSync(readFileSync(join(fixtures, 'bg-duos-partial.log.gz'))).toString().split('\n')
  for (const l of lines) game.handleLine(l)
  return { game, bg, snap: bg.snapshot() }
}

describe('Battlegrounds Duos replay', () => {
  const { game, snap } = replay()

  it('identifies mode, local player and round', () => {
    expect(snap.mode).toBe('duos')
    expect(game.friendlyPlayerId).toBe(7)
    expect(snap.round).toBeGreaterThanOrEqual(4)
  })

  it('builds the 8-hero lobby with teams', () => {
    expect(snap.lobby).toHaveLength(8)
    const me = snap.lobby.find((p) => p.isMe)!
    const mate = snap.lobby.find((p) => p.isTeammate)!
    expect(me.heroName).toBe('Gall')
    expect(mate.heroName).toBe('Cho')
    expect(me.team).toBe(mate.team)
    expect(snap.lobby.filter((p) => p.isNextOpponent)).toHaveLength(2)
  })

  it('records every combat with boards, odds and the real result', () => {
    expect(snap.rounds.map((r) => r.round)).toEqual([1, 2, 3])
    for (const r of snap.rounds) {
      expect(r.opponentHeroName).toBeTruthy()
      expect(r.oppBoard.length).toBeGreaterThan(0)
      expect(r.odds).toBeDefined()
      expect(r.result).toBe('LOST')
      expect(r.damage).toBeGreaterThan(0)
    }
    expect(snap.rounds[0].opponentHeroName).toBe('George the Fallen')
  })

  it('remembers each opponent’s last board', () => {
    const seen = snap.lobby.filter((p) => p.lastBoard)
    expect(seen.length).toBeGreaterThanOrEqual(3)
  })

  it('collects the tribes seen in the lobby', () => {
    expect(snap.tribes).toEqual(expect.arrayContaining(['DEMON', 'QUILBOAR']))
  })

  it('ends your game when you are knocked out, saves it, and resets for the next one', () => {
    const { game, bg } = replay()
    const saved: string[] = []
    bg.onMatchEnd = (m) => saved.push(`${m.heroName} ${m.mode} ${m.placement}`)
    const P = 'D 23:59:00.0000000 GameState.DebugPrintPower() - '
    game.handleLine(`${P}TAG_CHANGE Entity=20 tag=PLAYSTATE value=LOST`)
    expect(game.phase).toBe('over')
    bg.flushPendingMatch()
    expect(saved).toEqual(['Gall duos 3'])
    game.handleLine(`${P}CREATE_GAME`)
    const fresh = bg.snapshot()
    expect(fresh.rounds).toEqual([])
    expect(fresh.lobby).toEqual([])
  })
})
