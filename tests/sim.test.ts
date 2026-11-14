import { describe, expect, it } from 'vitest'
import { CardDb } from '../src/main/cards/cardDb'
import { Combat, mulberry32, simulateMany, type BoardInput } from '../src/main/bg/sim/engine'
import { compileFx } from '../src/main/bg/sim/effects'
import type { CardInfo } from '../src/shared/types'

const M = (id: string, name: string, attack: number, health: number, extra: Partial<CardInfo> = {}): CardInfo => ({
  id,
  dbfId: id.length * 1000 + attack * 10 + health,
  name,
  cost: 0,
  type: 'MINION',
  set: 'BATTLEGROUNDS',
  attack,
  health,
  techLevel: 1,
  ...extra,
})

function db() {
  const d = new CardDb()
  d.load([
    M('VAN', 'Vanilla', 2, 2),
    M('BIG', 'Big Guy', 10, 10, { techLevel: 4 }),
    M('BONE', 'Harmless Bonehead', 1, 1, { races: ['UNDEAD'], mechanics: ['DEATHRATTLE'], text: '<b>Deathrattle:</b> Summon two 1/1 Skeletons.', goldenId: 'BONE_G' }),
    M('BONE_G', 'Harmless Bonehead', 2, 2, { races: ['UNDEAD'], mechanics: ['DEATHRATTLE'], text: '<b>Deathrattle:</b> Summon four 1/1 Skeletons.', normalId: 'BONE' }),
    M('SKEL', 'Skeleton', 1, 1, { races: ['UNDEAD'] }),
    M('RIDER', 'Risen Rider', 2, 1, { races: ['UNDEAD'], mechanics: ['TAUNT', 'REBORN'], text: '<b>Taunt</b> <b>Reborn</b>' }),
    M('TITUS', 'Titus Rivendare', 1, 7, { techLevel: 5, mechanics: ['AURA'], text: 'Your <b>Deathrattles</b> trigger an extra time.' }),
    M('PUP', 'Wolf Pup', 3, 6, { races: ['BEAST'], mechanics: ['BACON_RALLY'], text: '<b>Rally:</b> Give your other minions +4/+1.' }),
    M('CLEAVER', 'Blade Collector', 3, 2, { races: ['PIRATE'], text: 'Also damages the enemies next to whomever this attacks.' }),
    M('BOOM', 'Boom-in-a-Box', 5, 10, { mechanics: ['START_OF_COMBAT', 'TAUNT'], text: '<b>Taunt</b> <b>Start of Combat:</b> Deal 3 damage to all other minions.' }),
    M('ODD', 'Oddity', 1, 1, { text: '<b>Start of Combat:</b> Teleport to the moon.' }),
    M('IMP', 'Imp', 2, 2, { races: ['DEMON'] }),
    M('BG33_155', 'Devout Hellcaller', 4, 4, { races: ['DEMON'], text: 'After another friendly Demon deals damage, gain +2/+2 permanently.' }),
    M('BG36_241', 'Crimson Vindicator', 9, 7, { races: ['DRAGON'], mechanics: ['BACON_RALLY'], text: '<b>Divine Shield</b>. <b>Windfury</b>. <b>Rally:</b> Cast Mighty Dragonbreath.' }),
    M('WHELP', 'Whelp', 1, 1, { races: ['DRAGON'] }),
    M('BG26_354', 'Choral Mrrrglr', 6, 6, { races: ['MURLOC'], text: '<b>Start of Combat:</b> Gain the stats of all the minions in your hand.' }),
    M('ARC', 'Runic Arcanist', 2, 4, { races: ['DRAGON'], text: '<b>Start of Combat:</b> Cast Shiny Ring twice.' }),
    { id: 'RING', dbfId: 99, name: 'Shiny Ring', cost: 1, type: 'BATTLEGROUND_SPELL', set: 'BATTLEGROUNDS', text: 'Give your minions +1/+1.' },
  ])
  return d
}

const board = (heroTier: number, ...minions: BoardInput['minions']): BoardInput => ({ heroTier, minions })
const v = (cardId: string, atk: number, health: number, extra: Partial<BoardInput['minions'][0]> = {}) => ({ cardId, atk, health, ...extra })

describe('combat rules', () => {
  it('a bigger minion always wins and deals tier + minion tiers', () => {
    const r = simulateMany(db(), board(3, v('BIG', 10, 10)), board(2, v('VAN', 2, 2)), { iterations: 200, seed: 1 })
    expect(r.win).toBe(1)
    expect(r.avgDamageDealt).toBe(3 + 4)
  })

  it('caps the damage of one fight while the game’s damage cap is on, lethal included', () => {
    // Uncapped: 3 + 4 = 7 damage, lethal against 5 health. Capped at 5 it's still lethal; at 4 it isn't.
    const opts = { iterations: 50, seed: 1, oppHealth: 5 }
    expect(simulateMany(db(), board(3, v('BIG', 10, 10)), board(2, v('VAN', 2, 2)), opts).avgDamageDealt).toBe(7)
    const at5 = simulateMany(db(), board(3, v('BIG', 10, 10)), board(2, v('VAN', 2, 2)), { ...opts, damageCap: 5 })
    expect([at5.avgDamageDealt, at5.lethalWin]).toEqual([5, 1])
    const at4 = simulateMany(db(), board(3, v('BIG', 10, 10)), board(2, v('VAN', 2, 2)), { ...opts, damageCap: 4 })
    expect([at4.avgDamageDealt, at4.lethalWin]).toEqual([4, 0])
  })

  it('mirror boards with no damage left tie', () => {
    const r = simulateMany(db(), board(1, v('VAN', 2, 2)), board(1, v('VAN', 2, 2)), { iterations: 200, seed: 1 })
    expect(r.tie).toBe(1)
  })

  it('divine shield wins an otherwise even trade', () => {
    const r = simulateMany(db(), board(1, v('VAN', 2, 2, { divineShield: true })), board(1, v('VAN', 2, 2)), { iterations: 200, seed: 1 })
    expect(r.win).toBe(1)
  })

  it('venomous kills anything', () => {
    const r = simulateMany(db(), board(1, v('VAN', 1, 30, { venomous: true })), board(1, v('BIG', 10, 10)), { iterations: 200, seed: 1 })
    expect(r.win).toBe(1)
  })

  it('windfury attacks twice', () => {
    // 3 attack windfury vs two 3/3s: kills both in one turn when going first and surviving the first hit.
    const c = new Combat(db(), mulberry32(3), board(1, v('VAN', 3, 4, { windfury: true })), board(1, v('VAN', 3, 3), v('VAN', 3, 3)))
    const r = c.simulate({ firstAttacker: 0 })
    expect(r.winner).toBe(null) // 3/4 takes 3+3 and dies after killing both: a tie
  })

  it('must attack taunts first', () => {
    for (let seed = 1; seed < 30; seed++) {
      const c = new Combat(db(), mulberry32(seed), board(1, v('VAN', 1, 50)), board(1, v('VAN', 0, 5), v('VAN', 0, 1, { taunt: true })))
      c.simulate({ firstAttacker: 0 })
      // The taunt (1 health) is always hit first, so it's always dead.
      expect(c.sides[1].minions.some((m) => m.hp === 1)).toBe(false)
    }
  })

  it('reborn comes back with 1 health', () => {
    const c = new Combat(db(), mulberry32(1), board(1, v('BIG', 10, 10)), board(1, v('RIDER', 2, 1, { taunt: true, reborn: true })))
    c.simulate({ firstAttacker: 0 })
    // Big Guy kills the rider twice (original + reborn copy): takes 2 + 2 damage.
    expect(c.sides[0].minions[0].hp).toBe(6)
  })

  it('stops when neither side can attack', () => {
    const r = simulateMany(db(), board(1, v('VAN', 0, 5)), board(1, v('VAN', 0, 5)), { iterations: 50, seed: 1 })
    expect(r.tie).toBe(1)
  })
})

describe('card effects from text', () => {
  it('Deathrattle summons tokens (and golden summons more)', () => {
    const c = new Combat(db(), mulberry32(1), board(1, v('BONE', 1, 1)), board(1, v('VAN', 0, 9)))
    c.sides[0].minions[0].hp = 0
    c.resolveDeaths(c.sides[0])
    expect(c.sides[0].minions.map((m) => `${m.name} ${m.atk}/${m.hp}`)).toEqual(['Skeleton 1/1', 'Skeleton 1/1'])

    const g = new Combat(db(), mulberry32(1), board(1, v('BONE_G', 2, 2)), board(1, v('VAN', 0, 9)))
    g.sides[0].minions[0].hp = 0
    g.resolveDeaths(g.sides[0])
    expect(g.sides[0].minions).toHaveLength(4)
  })

  it('Titus doubles deathrattles', () => {
    const c = new Combat(db(), mulberry32(1), board(1, v('BONE', 1, 1), v('TITUS', 1, 7)), board(1, v('VAN', 0, 9)))
    c.sides[0].minions[0].hp = 0
    c.resolveDeaths(c.sides[0])
    expect(c.sides[0].minions.filter((m) => m.name === 'Skeleton')).toHaveLength(4)
  })

  it('Rally buffs fire when the minion attacks', () => {
    const c = new Combat(db(), mulberry32(1), board(1, v('PUP', 3, 6), v('VAN', 2, 2)), board(1, v('VAN', 0, 50, { taunt: true })))
    c.sides[0].nextAttacker = 0
    c.singleAttack(c.sides[0], c.sides[0].minions[0])
    expect(c.sides[0].minions[1].atk).toBe(6)
    expect(c.sides[0].minions[1].hp).toBe(3)
  })

  it('cleave hits neighbours', () => {
    const c = new Combat(db(), mulberry32(1), board(1, v('CLEAVER', 3, 2)), board(1, v('VAN', 0, 3), v('VAN', 0, 3, { taunt: true }), v('VAN', 0, 3)))
    c.singleAttack(c.sides[0], c.sides[0].minions[0])
    expect(c.alive(c.sides[1])).toHaveLength(0)
  })

  it('start of combat damage resolves before attacks', () => {
    const r = simulateMany(db(), board(1, v('BOOM', 5, 10, { taunt: true })), board(1, v('VAN', 2, 2), v('VAN', 2, 2)), { iterations: 100, seed: 1 })
    expect(r.win).toBe(1)
  })

  it('Devout Hellcaller grows when another Demon deals damage', () => {
    const c = new Combat(db(), mulberry32(1), board(1, v('IMP', 2, 2), v('BG33_155', 4, 4)), board(1, v('VAN', 0, 50)))
    c.singleAttack(c.sides[0], c.sides[0].minions[0])
    expect(c.sides[0].minions[1].atk).toBe(6)
  })

  it('casts Tavern spells in combat (Mighty Dragonbreath, Shiny Ring)', () => {
    const c = new Combat(db(), mulberry32(1), board(1, v('BG36_241', 9, 7), v('WHELP', 1, 1), v('VAN', 1, 1, { divineShield: true })), board(1, v('VAN', 0, 99)))
    c.singleAttack(c.sides[0], c.sides[0].minions[0])
    const [, whelp, shielded] = c.sides[0].minions
    expect([whelp.atk, whelp.hp]).toEqual([1 + 6, 1 + 4]) // dragon: twice
    expect([shielded.atk, shielded.hp]).toEqual([1 + 6, 1 + 4]) // divine shield: twice

    const r = new Combat(db(), mulberry32(1), board(1, v('ARC', 2, 4), v('VAN', 2, 2)), board(1, v('VAN', 0, 99)))
    r.simulate({ firstAttacker: 0 })
    // Start of Combat ran: Shiny Ring twice gives everyone +2/+2.
    expect(r.sides[0].minions.find((m) => m.name === 'Vanilla')?.atk).toBe(4)
  })

  it('uses your hand for hand-based Start of Combat effects', () => {
    const input = { ...board(1, v('BG26_354', 6, 6)), hand: [v('VAN', 2, 3), v('BIG', 10, 10)] }
    const c = new Combat(db(), mulberry32(1), input, board(1, v('VAN', 0, 99)))
    c.simulate({ firstAttacker: 1 })
    expect(c.sides[0].minions[0].atk).toBe(6 + 12)
  })

  it('Duos: a wiped-out warband is replaced by its teammate’s', () => {
    // We beat their first board easily, but their teammate's board is far stronger.
    const me = board(1, v('VAN', 5, 5))
    const them = { ...board(1, v('VAN', 1, 1)), reserve: { minions: [v('BIG', 10, 10)], heroTier: 3 } }
    const r = simulateMany(db(), me, them, { iterations: 200, seed: 1 })
    expect(r.loss).toBe(1)
    expect(r.avgDamageTaken).toBe(3 + 4)
    // Without the reserve it would look like a sure win.
    expect(simulateMany(db(), me, board(1, v('VAN', 1, 1)), { iterations: 200, seed: 1 }).win).toBe(1)
  })

  it('Diremuck Forager summons from hand once there is room', () => {
    const d = db()
    d.load([
      ...['VAN', 'BIG'].map((id) => d.get(id)!),
      M('BG27_556', 'Diremuck Forager', 4, 5, { races: ['MURLOC'], text: '<b>Start of Combat:</b> When you have space, summon the highest-Attack Murloc from your hand for this combat only.' }),
      M('FISH', 'Big Fish', 40, 40, { races: ['MURLOC'] }),
    ])
    const full = [v('BG27_556', 4, 5), ...Array.from({ length: 6 }, () => v('VAN', 1, 1))]
    const c = new Combat(d, mulberry32(1), { ...board(1, ...full), hand: [v('FISH', 40, 40)] }, board(1, v('VAN', 0, 99)))
    c.simulate({ firstAttacker: 1, skipStartOfCombat: true })
    expect(c.sides[0].minions.some((m) => m.name === 'Big Fish')).toBe(false) // board stays full: no room
    c.sides[0].minions[1].hp = 0
    c.resolveDeaths(c.sides[0])
    expect(c.sides[0].minions.some((m) => m.name === 'Big Fish')).toBe(true)
  })

  it('reports effects it cannot model', () => {
    expect(compileFx(db().get('ODD'), db()).unsupported.length).toBeGreaterThan(0)
    expect(compileFx(db().get('BONE'), db()).unsupported).toEqual([])
    const r = simulateMany(db(), board(1, v('ODD', 1, 1)), board(1, v('VAN', 2, 2)), { iterations: 10, seed: 1 })
    expect(r.unsupported).toEqual(['Oddity'])
  })
})
