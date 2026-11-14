// Hero powers that act in combat. Real card text (HearthstoneJSON, 2026-11-14).
// Start of Combat ones matter where Start of Combat hasn't happened before the
// boards were captured (a Duos reserve); all-combat ones matter in every fight.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CardDb } from '../src/main/cards/cardDb'
import { Combat, mulberry32, simulateMany, type BoardInput, type MinionInput } from '../src/main/bg/sim/engine'
import { compileHeroPower } from '../src/main/bg/sim/effects'
import type { CardInfo } from '../src/shared/types'

const cards: CardInfo[] = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'cards-hero-powers.json'), 'utf8'))
const db = new CardDb()
db.load(cards)
const power = (name: string) => cards.find((c) => c.name === name)!.id

const m = (cardId: string, atk: number, health: number, extra: Partial<MinionInput> = {}): MinionInput => ({ cardId, atk, health, ...extra })
const VAN = 'VANILLA'
const vanillas = (...hp: number[]) => hp.map((h) => m(VAN, 1, h))
/** Our side with a hero power, against `enemy`, with Start of Combat run. */
function afterStart(heroPower: string, mine: MinionInput[], enemy: MinionInput[] = vanillas(1000), extra: Partial<BoardInput> = {}) {
  const c = new Combat(db, mulberry32(1), { minions: mine, heroTier: 2, heroPower: power(heroPower), ...extra }, { minions: enemy, heroTier: 2 })
  ;(c as unknown as { startOfCombat(first: 0 | 1): void }).startOfCombat(1) // enemy "goes first": nothing of theirs acts
  return c
}
const hp = (c: Combat, side: number) => c.sides[side].minions.map((x) => x.hp)

describe('every combat hero power compiles', () => {
  it.each(cards.filter((c) => c.type === 'HERO_POWER').map((c) => [c.name]))('%s', (name) => {
    expect(compileHeroPower(db.get(power(name)), db).unsupported).toEqual([])
  })
})

describe('Start of Combat hero powers', () => {
  it('Aim High/Low/Left/Right pick the right enemy', () => {
    const enemy = vanillas(5, 50, 2, 20)
    expect(hp(afterStart('Aim High!', vanillas(1), enemy), 1)).toEqual([5, 2, 20])
    expect(hp(afterStart('Aim Low!', vanillas(1), enemy), 1)).toEqual([5, 50, 20])
    expect(hp(afterStart('Aim Left!', vanillas(1), enemy), 1)).toEqual([50, 2, 20])
    expect(hp(afterStart('Aim Right!', vanillas(1), enemy), 1)).toEqual([5, 50, 2])
  })

  it('damage to random / all enemies', () => {
    expect(hp(afterStart('Nefarious Fire', vanillas(1), vanillas(10, 10, 10)), 1)).toEqual([9, 9, 9])
    expect(hp(afterStart('DIE, INSECTS!', vanillas(1), vanillas(100, 100, 100)), 1).reduce((a, b) => a + b)).toBe(300 - 16)
    expect(hp(afterStart('Lightning Invocation', vanillas(1), vanillas(10, 10, 10, 10, 10)), 1)).toEqual([9, 9, 9, 9, 9])
  })

  it('ALL Will Burn gives every minion on both sides +2 Attack', () => {
    const c = afterStart('ALL Will Burn!', vanillas(1, 1), vanillas(1000))
    expect(c.sides.flatMap((s) => s.minions.map((x) => x.atk))).toEqual([3, 3, 3])
  })

  it('Fire Invocation doubles the left-most minion’s Attack; Water / Swatting give keywords', () => {
    expect(afterStart('Fire Invocation', [m(VAN, 4, 1), m(VAN, 4, 1)]).sides[0].minions.map((x) => x.atk)).toEqual([8, 4])
    const water = afterStart('Water Invocation', vanillas(1, 1)).sides[0].minions[1]
    expect([water.divineShield, water.taunt]).toEqual([true, true])
    const swat = afterStart('Swatting Insects', vanillas(1, 1)).sides[0].minions[0]
    expect([swat.windfury, swat.divineShield, swat.taunt]).toEqual([2, true, true])
  })

  it('Earth Invocation and Fragrant Phylactery hand out Deathrattles', () => {
    const earth = afterStart('Earth Invocation', vanillas(1, 1, 1, 1, 1))
    expect(earth.sides[0].minions.filter((x) => x.grantedDeathrattles?.length)).toHaveLength(4)
    const phyl = afterStart('Fragrant Phylactery', [m(VAN, 5, 5), m(VAN, 1, 3), m(VAN, 7, 7)])
    const low = phyl.sides[0].minions[1]
    expect(low.grantedDeathrattles).toHaveLength(1)
    low.destroyed = true
    phyl.resolveDeaths(phyl.sides[0])
    expect(phyl.sides[0].minions.map((x) => `${x.atk}/${x.hp}`)).toEqual(['6/8', '8/10'])
  })

  it('Embrace Your Rage summons a minion of your Tier', () => {
    const c = afterStart('Embrace Your Rage', vanillas(1))
    expect(c.sides[0].minions.map((x) => x.tier)).toContain(2)
    expect(c.sides[0].minions).toHaveLength(2)
  })

  it('Embrace the Elements does nothing until an Element is chosen', () => {
    expect(compileHeroPower(db.get(power('Embrace the Elements')), db).startOfCombat).toBeUndefined()
  })
})

describe('hero powers that last all combat', () => {
  it('Sprout It Out gives summoned minions +1/+2 and Taunt, even when Start of Combat is skipped', () => {
    const c = new Combat(db, mulberry32(1), { minions: [m('BG28_300', 1, 1)], heroTier: 2, heroPower: power('Sprout It Out!') }, { minions: vanillas(1000), heroTier: 2 })
    c.sides[0].minions[0].destroyed = true
    c.resolveDeaths(c.sides[0])
    expect(c.sides[0].minions.map((x) => `${x.atk}/${x.hp} ${x.taunt}`)).toEqual(['2/3 true', '2/3 true'])
  })

  it('Broodmother: every fourth friendly death summons a Whelp that attacks', () => {
    const c = new Combat(db, mulberry32(1), { minions: vanillas(1, 1, 1, 1, 50), heroTier: 2, heroPower: power('Broodmother') }, { minions: [m(VAN, 0, 1000)], heroTier: 2 })
    for (let i = 0; i < 4; i++) c.sides[0].minions[0].destroyed = true, c.resolveDeaths(c.sides[0])
    expect(c.sides[0].minions.map((x) => x.name)).toEqual(['VANILLA', 'Whelp'])
    expect(c.sides[1].minions[0].hp).toBe(999)
  })

  it('Frostwolf Fervor copies the highest-Attack minion once there is space, from Turn 7', () => {
    const run = (turn: number) => {
      const c = new Combat(db, mulberry32(1), { minions: [m(VAN, 9, 9), m(VAN, 1, 1)], heroTier: 2, heroPower: power('Frostwolf Fervor'), turn }, { minions: vanillas(1000), heroTier: 2 })
      c.resolveDeaths(c.sides[0])
      return c.sides[0].minions.map((x) => x.atk)
    }
    expect(run(6)).toEqual([9, 1])
    expect(run(7)).toEqual([9, 9, 1])
  })

  it('Murloc King on a reserve is assumed to have been used', () => {
    const c = afterStart('Murloc King', vanillas(1, 1))
    expect(c.sides[0].minions.every((x) => x.grantedDeathrattles?.length === 1)).toBe(true)
  })

  it('lists choice-based hero powers as approximated', () => {
    const r = simulateMany(db, { minions: vanillas(1), heroTier: 2, reserve: { minions: vanillas(1), heroTier: 2, heroPower: power('Deadeye') } }, { minions: vanillas(1), heroTier: 2 }, { iterations: 10, seed: 1, skipStartOfCombat: true })
    expect(r.approximated).toEqual(['Deadeye'])
    expect(r.unsupported).toEqual([])
  })
})

// What a minion was given before the boards were captured arrives as enchantments (log entities
// ATTACHED to it), passed by card id. Only their combat text matters; stats are in the numbers.
describe('combat enchantments', () => {
  const fightWith = (mine: MinionInput[]) => new Combat(db, mulberry32(1), { minions: mine, heroTier: 2 }, { minions: [m(VAN, 0, 1000)], heroTier: 2 })
  const kill = (c: Combat, i: number) => {
    c.sides[0].minions[i].destroyed = true
    c.resolveDeaths(c.sides[0])
  }

  it('a Deathrattle given by Murloc King fires', () => {
    const c = fightWith([m(VAN, 2, 2, { enchantments: ['TB_BaconShop_HP_017e'] })])
    kill(c, 0)
    expect(c.sides[0].minions.map((x) => `${x.atk}/${x.hp} ${x.tribes}`)).toEqual(['1/1 MURLOC'])
  })

  it('Leapfroggin’ passes itself on to a friendly Beast', () => {
    const c = fightWith([m(VAN, 2, 2, { enchantments: ['BG21_000e'] }), m('BG21_000', 3, 3)])
    kill(c, 0)
    expect(c.sides[0].minions[0].grantedDeathrattles?.length).toBeGreaterThan(0)
  })

  it('counts an enchantment’s gaps and guesses against its minion', () => {
    const r = simulateMany(db, { minions: [m(VAN, 1, 1, { enchantments: ['BG22_HERO_001p_t1e'] })], heroTier: 2 }, { minions: vanillas(1), heroTier: 2 }, { iterations: 10, seed: 1 })
    expect(r.unsupported).toEqual([])
  })
})

describe('Dark Gifts (enchantments seen in real logs)', () => {
  const one = (ench: string, extra: MinionInput[] = []) =>
    new Combat(db, mulberry32(1), { minions: [m(VAN, 4, 6, { enchantments: [ench] }), ...extra], heroTier: 2 }, { minions: [m(VAN, 0, 1000)], heroTier: 2 })

  it('Golemancy: Deathrattle summons a Golem with its stats', () => {
    const c = one('BG36_MidGameEffect_000t61e')
    c.sides[0].minions[0].destroyed = true
    c.resolveDeaths(c.sides[0])
    expect(c.sides[0].minions.map((x) => `${x.name} ${x.atk}/${x.hp}`)).toEqual(['Golem 4/6'])
  })

  it('Offensive Sacrifice: Deathrattle gives its Attack to another friendly minion', () => {
    const c = one('BG36_MidGameEffect_000te2', vanillas(1))
    c.sides[0].minions[0].destroyed = true
    c.resolveDeaths(c.sides[0])
    expect(c.sides[0].minions[0].atk).toBe(5)
  })

  it('Doppelganger: Start of Combat summons a copy (on a reserve, or when Start of Combat runs)', () => {
    const c = one('BG36_MidGameEffect_000t90e')
    ;(c as unknown as { startOfCombat(first: 0 | 1): void }).startOfCombat(1)
    expect(c.sides[0].minions.map((x) => `${x.atk}/${x.hp}`)).toEqual(['4/6', '4/6'])
  })
})
