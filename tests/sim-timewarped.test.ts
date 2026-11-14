// Timewarped minions, and the engine hooks they needed. Real card text
// (HearthstoneJSON, 2026-11-14), slimmed as in production.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CardDb } from '../src/main/cards/cardDb'
import { Combat, mulberry32, simulateMany, type BoardInput, type MinionInput } from '../src/main/bg/sim/engine'
import { compileFx } from '../src/main/bg/sim/effects'

const db = new CardDb()
db.load(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'cards-timewarped.json'), 'utf8')))

const m = (cardId: string, atk: number, health: number, extra: Partial<MinionInput> = {}): MinionInput => ({ cardId, atk, health, ...extra })
const VAN = 'VANILLA' // not in the fixture: a minion with no text and no type
const wall = { minions: [m(VAN, 0, 1000)], heroTier: 1 }
const fight = (a: BoardInput, b: BoardInput = wall, seed = 1) => new Combat(db, mulberry32(seed), a, b)
const startOfCombat = (c: Combat) => (c as unknown as { startOfCombat(first: 0 | 1): void }).startOfCombat(0)
const stats = (c: Combat, side = 0) => c.sides[side].minions.map((x) => `${x.name} ${x.atk}/${x.hp}`)
const kill = (c: Combat, side: number, i: number) => {
  c.sides[side].minions[i].destroyed = true
  c.resolveDeaths(c.sides[side])
}

describe('every Timewarped minion compiles', () => {
  it.each(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'cards-timewarped.json'), 'utf8')).map((c: { id: string; name: string }) => [c.name, c.id]))('%s (%s)', (_name, id) => {
    expect(compileFx(db.get(id as string), db).unsupported).toEqual([])
  })
})

describe('Timewarped effects', () => {
  it('Whelp Smuggler: a friendly minion that gains Attack also gets +3 Health', () => {
    const c = fight({ minions: [m('BG34_Giant_064', 3, 8), m(VAN, 1, 1)], heroTier: 3 })
    c.buff(c.sides[0].minions[1], 2, 0)
    expect(c.sides[0].minions[1].hp).toBe(4)
    c.buff(c.sides[0].minions[1], 0, 2) // Health only: no trigger
    expect(c.sides[0].minions[1].hp).toBe(6)
  })

  it('Saurolisk grows after a friendly Deathrattle triggers', () => {
    const c = fight({ minions: [m('BG34_Giant_202', 4, 4), m('BG28_300', 1, 1)], heroTier: 3 })
    kill(c, 0, 1)
    expect(c.sides[0].minions[0].atk).toBe(7)
    expect(c.sides[0].minions[0].hp).toBe(6)
  })

  it('Leapfrogger passes on its Deathrattle, which then fires again', () => {
    const beast = m('BG34_Giant_064', 3, 8) // no Beast in the fixture besides Leapfroggers: give one the Beast job
    const c = fight({ minions: [m('BG34_Giant_031', 3, 3), m('BG34_Giant_031', 3, 3), beast], heroTier: 3 })
    const second = c.sides[0].minions[1]
    kill(c, 0, 0)
    expect(second.grantedDeathrattles).toHaveLength(1)
    expect(second.atk).toBe(4)
    // When it dies it runs its own Deathrattle and the one it was given: two Beasts' worth of buffs.
    kill(c, 0, 0)
    expect(c.sides[0].minions).toHaveLength(1) // the Smuggler isn't a Beast: no one left to receive them
  })

  it('Hag: the Undead to the right is Reborn with its full stats', () => {
    const c = fight({ minions: [m('BG34_Giant_342', 6, 8), m('BG34_Giant_618', 9, 9)], heroTier: 5 })
    startOfCombat(c)
    const caretaker = c.sides[0].minions[1]
    expect(caretaker.reborn && caretaker.rebornFull).toBe(true)
    kill(c, 0, 1)
    expect(c.sides[0].minions.some((x) => x.name === 'Timewarped Caretaker' && x.atk === 9 && x.hp === 9)).toBe(true)
  })

  it('Hawkstrider triggers all friendly Deathrattles at Start of Combat', () => {
    const c = fight({ minions: [m('BG34_Giant_370', 8, 4), m('BG28_300', 1, 1)], heroTier: 5 })
    startOfCombat(c)
    expect(c.sides[0].minions.filter((x) => x.name === 'Skeleton')).toHaveLength(2)
  })

  it('Ragnaros hits the highest-Health enemy for its Attack', () => {
    const c = fight({ minions: [m('BG34_Giant_580', 8, 8)], heroTier: 3 }, { minions: [m(VAN, 1, 5), m(VAN, 1, 20)], heroTier: 1 })
    startOfCombat(c)
    expect(c.sides[1].minions.map((x) => x.hp)).toEqual([5, 12])
  })

  it('Dragonling gives itself and its neighbours stats equal to your Tier', () => {
    const c = fight({ minions: [m(VAN, 1, 1), m('BG34_Giant_029', 3, 3), m(VAN, 1, 1), m(VAN, 1, 1)], heroTier: 4 })
    startOfCombat(c)
    expect(c.sides[0].minions.map((x) => x.atk)).toEqual([5, 7, 5, 1])
  })

  it('Caretaker: Skeletons that do not fit give your Undead Attack instead', () => {
    const others = Array.from({ length: 5 }, () => m('BG28_300', 1, 1))
    const c = fight({ minions: [m('BG34_Giant_618', 5, 5), ...others, m('BG34_Giant_342', 6, 8)], heroTier: 5 })
    kill(c, 0, 0) // 6 left: one Skeleton fits, four don't
    const side = c.sides[0]
    expect(side.minions).toHaveLength(7)
    expect(side.tribeBonus.get('UNDEAD')?.atk).toBe(4)
    expect(side.minions.find((x) => x.name === 'Timewarped Hag')!.atk).toBe(10)
  })

  it('Chameleon becomes a copy of its left neighbour (golden: a golden copy)', () => {
    const c = fight({ minions: [m('BG34_Giant_064', 5, 10), m('BG34_Giant_042', 6, 15), m('BG34_Giant_042_G', 12, 30)], heroTier: 5 })
    startOfCombat(c)
    expect(stats(c)).toEqual(['Timewarped Whelp Smuggler 5/10', 'Timewarped Whelp Smuggler 5/10', 'Timewarped Whelp Smuggler 8/18'])
  })

  it('Bassgill summons the highest-Health minion from hand with Divine Shield', () => {
    const a: BoardInput = { minions: [m('BG34_Giant_071', 7, 4)], heroTier: 3, hand: [m(VAN, 1, 3), m(VAN, 2, 9)] }
    const c = fight(a)
    kill(c, 0, 0)
    expect(stats(c)).toEqual(['VANILLA 2/9'])
    expect(c.sides[0].minions[0].divineShield).toBe(true)
  })

  it('Grease Bot buffs your minions after one loses Divine Shield', () => {
    const c = fight({ minions: [m('BG34_Giant_656', 6, 12, { divineShield: true }), m(VAN, 1, 1)], heroTier: 5 })
    c.damage(c.sides[0].minions[0], 3)
    expect(stats(c)).toEqual(['Timewarped Grease Bot 9/15', 'VANILLA 4/4'])
  })

  it('Sea Glass doubles its stats on Rally, only twice per combat', () => {
    const c = fight({ minions: [m('BG34_Giant_110', 10, 8)], heroTier: 5 }, { minions: [m(VAN, 0, 10000)], heroTier: 1 })
    for (let i = 0; i < 4; i++) c.singleAttack(c.sides[0], c.sides[0].minions[0])
    expect(c.sides[0].minions[0].atk).toBe(40)
  })

  it('golden ", twice": Chimera buffs one minion of each type, twice', () => {
    const fx = compileFx(db.get('BG34_Giant_679_G'), db)
    expect(fx.unsupported).toEqual([])
    const c = fight({ minions: [m('BG34_Giant_679_G', 2, 16), m('BG34_Giant_064', 3, 8), m('BG28_300', 1, 1)], heroTier: 5 })
    c.damage(c.sides[0].minions[0], 1)
    // Each pass: Bonehead for Undead, Chimera (every type) for one other type; the type-less Smuggler gets
    // nothing, but adds +3 Health to every minion that gains Attack. 2 passes x (+2/+1, then +3 Health).
    expect(stats(c)).toEqual(['Timewarped Chimera 6/23', 'Timewarped Whelp Smuggler 3/8', 'Harmless Bonehead 5/9'])
  })

  it('Expeditioner passes the stats it gains to the left-most minion in hand', () => {
    const c = fight({ minions: [m('BG34_Giant_317', 6, 12)], heroTier: 5, hand: [m(VAN, 1, 1), m(VAN, 1, 1), m(VAN, 1, 1)] })
    c.buff(c.sides[0].minions[0], 2, 3)
    expect(c.sides[0].hand.map((x) => `${x.atk}/${x.hp}`)).toEqual(['3/4', '3/4', '1/1'])
  })

  it('Whirl-O-Tron copies Deathrattles, Stoneshell copies Rallies', () => {
    const c = fight({ minions: [m('BG28_300', 1, 1), m('BG34_Giant_599', 7, 5), m('BG34_Giant_110', 10, 8), m('BG34_Giant_601', 4, 8)], heroTier: 5 })
    startOfCombat(c)
    expect(c.sides[0].minions[1].grantedDeathrattles).toHaveLength(1)
    expect(c.sides[0].minions[3].grantedRallies).toHaveLength(1)
  })

  it('Warghoul triggers an adjacent Deathrattle when it dies', () => {
    const c = fight({ minions: [m('BG34_Giant_331', 9, 3), m('BG28_300', 1, 1)], heroTier: 5 })
    kill(c, 0, 0)
    expect(c.sides[0].minions.filter((x) => x.name === 'Skeleton')).toHaveLength(2)
  })

  it('Icky Imp summons Imps with its maximum stats', () => {
    const c = fight({ minions: [m('BG34_Giant_674', 12, 12)], heroTier: 5 })
    kill(c, 0, 0)
    expect(stats(c)).toEqual(['Imp 12/12', 'Imp 12/12'])
  })

  it('Gemsplitter upgrades the Blood Gems that Lil’ Quilboar plays later in the fight', () => {
    const c = fight({ minions: [m('BG34_Giant_644', 5, 10, { divineShield: true }), m('BG34_Giant_608', 5, 5)], heroTier: 5 })
    c.damage(c.sides[0].minions[0], 1)
    expect(c.sides[0].bloodGem).toEqual({ atk: 2, hp: 1 })
    kill(c, 0, 1)
    // 3 Gems at +2/+1 on every Quilboar (Gemsplitter; Lil' Quilboar is gone)
    expect(c.sides[0].minions[0].atk).toBe(5 + 6)
  })

  it('flags best guesses as approximated', () => {
    const r = simulateMany(db, { minions: [m('BG34_Giant_608', 5, 5)], heroTier: 5 }, wall, { iterations: 10, seed: 1 })
    expect(r.approximated).toEqual(["Timewarped Lil' Quilboar"])
    expect(r.unsupported).toEqual([])
  })
})
