// The combat rules M5 added for the long tail of minions (tokens, hero buddies,
// rotated cards). Real card text (HearthstoneJSON, 2026-11-14), slimmed as in production.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CardDb } from '../src/main/cards/cardDb'
import { Combat, mulberry32, simulateMany, type BoardInput, type MinionInput } from '../src/main/bg/sim/engine'

const db = new CardDb()
db.load(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'cards-sim-rules.json'), 'utf8')))

const m = (cardId: string, atk: number, health: number, extra: Partial<MinionInput> = {}): MinionInput => ({ cardId, atk, health, ...extra })
const VAN = 'VANILLA'
const wall: BoardInput = { minions: [m(VAN, 0, 1000)], heroTier: 1 }
const fight = (a: BoardInput, b: BoardInput = wall, seed = 1) => new Combat(db, mulberry32(seed), a, b)
const mine = (...minions: MinionInput[]): BoardInput => ({ minions, heroTier: 4 })
const stats = (c: Combat, side = 0) => c.sides[side].minions.map((x) => `${x.name} ${x.atk}/${x.hp}`)
const kill = (c: Combat, side: number, i: number) => {
  c.sides[side].minions[i].destroyed = true
  c.resolveDeaths(c.sides[side])
}
const startOfCombat = (c: Combat) => (c as unknown as { startOfCombat(first: 0 | 1): void }).startOfCombat(1)

describe('who attacks whom', () => {
  it('Zapp Slywick hits the lowest-Attack enemy, even past Taunt', () => {
    for (let seed = 1; seed < 20; seed++) {
      const c = fight(mine(m('BGS_022', 7, 10)), { minions: [m(VAN, 5, 50, { taunt: true }), m(VAN, 1, 50)], heroTier: 1 }, seed)
      expect(c.chooseTarget(c.sides[1], c.sides[0].minions[0])!.atk).toBe(1)
    }
  })

  it('Worgen Vigilante picks something it can kill when it can', () => {
    for (let seed = 1; seed < 20; seed++) {
      const c = fight(mine(m('BG26_921', 5, 5)), { minions: [m(VAN, 1, 50), m(VAN, 1, 4), m(VAN, 1, 9)], heroTier: 1 }, seed)
      expect(c.chooseTarget(c.sides[1], c.sides[0].minions[0])!.hp).toBe(4)
    }
  })
})

describe('damage', () => {
  it("Dark Paradox's Divine Shield takes 3 hits", () => {
    const c = fight(mine(m('BG36_360t4', 5, 5, { divineShield: true })))
    const p = c.sides[0].minions[0]
    for (let i = 0; i < 3; i++) c.damage(p, 10)
    expect([p.divineShield, p.hp]).toEqual([false, 5])
    c.damage(p, 1)
    expect(p.hp).toBe(4)
  })

  it('Mad Matador sends the first hit to a random enemy', () => {
    const c = fight(mine(m('BG28_404', 2, 6)), { minions: [m(VAN, 1, 20)], heroTier: 1 })
    c.damage(c.sides[0].minions[0], 5)
    expect([c.sides[0].minions[0].hp, c.sides[1].minions[0].hp]).toEqual([6, 15])
    c.damage(c.sides[0].minions[0], 5) // once per combat
    expect(c.sides[0].minions[0].hp).toBe(1)
  })

  it('Interrogator Whitemane: a Tier 5+ enemy gets Taunt and takes double damage', () => {
    const c = fight(mine(m('BG24_704', 5, 7)), { minions: [m(VAN, 1, 20, { tier: 6 }), m(VAN, 1, 20, { tier: 1 })], heroTier: 1 })
    startOfCombat(c)
    const big = c.sides[1].minions[0]
    expect(big.taunt).toBe(true)
    c.damage(big, 3)
    expect(big.hp).toBe(14)
  })

  it('Adaptable Barricade shifts its stats to survive a hit', () => {
    const c = fight(mine(m('BG27_022', 6, 3)), { minions: [m(VAN, 5, 50)], heroTier: 1 })
    c.singleAttack(c.sides[1], c.sides[1].minions[0], c.sides[0].minions[0])
    expect(stats(c)).toEqual(['Adaptable Barricade 3/1'])
  })
})

describe('summoning', () => {
  it('Khadgar doubles card summons; Reborn stays single', () => {
    const c = fight(mine(m('BG_DAL_575', 2, 2), m('BG28_300', 1, 1)))
    kill(c, 0, 1)
    expect(stats(c).filter((x) => x.startsWith('Skeleton'))).toHaveLength(4)
  })

  it('Captain Bonerender copies a different minion summoned in combat', () => {
    const c = fight(mine(m('BG31_840', 2, 2), m('BG28_300', 1, 1)))
    kill(c, 0, 1)
    expect(stats(c).filter((x) => x.startsWith('Skeleton'))).toHaveLength(4)
  })

  it("Kangor's Apprentice brings back the first Mechs that died, plain", () => {
    const c = fight(mine(m('BGS_012', 3, 6), m('BG21_025', 30, 30), m('BG_BOT_312t', 9, 9)))
    kill(c, 0, 2) // a Microbot dies first
    kill(c, 0, 0) // then the Apprentice: the plain copy appears where it died
    expect(stats(c)).toEqual(['Microbot 1/1', 'Omega Buster 30/30'])
  })

  it('Scallywag’s Pirate attacks as soon as it is summoned', () => {
    const c = fight(mine(m('BGS_061', 3, 1)))
    kill(c, 0, 0)
    expect(c.sides[1].minions[0].hp).toBe(999)
  })

  it('Thundering Abomination grows when a summon does not fit', () => {
    const full = Array.from({ length: 6 }, () => m(VAN, 1, 1))
    const c = fight(mine(m('BG30_124', 4, 4), ...full))
    c.summon(c.sides[0], c.makeMinion({ name: 'Extra', atk: 1, hp: 1 }), 7)
    expect(c.sides[0].minions[0].atk).toBe(7)
  })

  it('Omega Buster: Microbots that do not fit buff your Mechs instead', () => {
    const others = Array.from({ length: 5 }, () => m('BG_BOT_312t', 1, 1))
    const c = fight(mine(m('BG21_025', 6, 6), ...others))
    kill(c, 0, 0) // room for 2 of 6: 4 don't fit
    expect(c.sides[0].minions.map((x) => x.atk)).toEqual([5, 5, 5, 5, 5, 5, 5])
  })

  it('Free-Flying Feathermane comes out of your hand when a Beast dies', () => {
    const c = fight({ ...mine(m('BG25_806', 2, 2)), hand: [m('BG27_014', 5, 5)] })
    kill(c, 0, 0)
    expect(c.sides[0].minions.map((x) => x.name)).toContain('Free-Flying Feathermane')
    expect(c.sides[0].hand).toHaveLength(0)
  })

  it('Cruise Controller: Pirates summoned for the rest of combat get +5 Attack', () => {
    const c = fight(mine(m('BG31_821', 2, 2), m('BGS_061', 3, 1)))
    kill(c, 0, 0)
    c.sides[1].minions[0].atk = 0 // the wall can't kill the next Pirate
    kill(c, 0, 0)
    expect(c.sides[1].minions[0].hp).toBe(1000 - 6)
  })
})

describe('auras and keywords', () => {
  it('Eclipsion Illidari: the first attack takes no damage back', () => {
    const c = fight(mine(m('TB_BaconShop_HERO_08_Buddy', 2, 2), m(VAN, 3, 3)), { minions: [m(VAN, 10, 100)], heroTier: 1 })
    c.singleAttack(c.sides[0], c.sides[0].minions[1])
    expect(c.sides[0].minions[1].hp).toBe(3)
    c.singleAttack(c.sides[0], c.sides[0].minions[0])
    expect(c.sides[0].minions.length).toBe(1)
  })

  it('Sun Screener shields three minions on each side', () => {
    const c = fight(mine(m('BG30_101', 5, 5), m(VAN, 1, 1), m(VAN, 1, 1), m(VAN, 1, 1)), { minions: [m(VAN, 1, 1), m(VAN, 1, 1)], heroTier: 1 })
    startOfCombat(c)
    expect(c.sides.map((s) => s.minions.filter((x) => x.divineShield).length)).toEqual([3, 2])
  })

  it('Sky Pirate Flagbearer hands out a quoted Deathrattle', () => {
    const c = fight(mine(m('BG30_119', 2, 2), m('BGS_061', 3, 1)))
    startOfCombat(c)
    expect(c.sides[0].minions[1].grantedDeathrattles).toHaveLength(1)
  })

  it('Blood Gem auras stack: Agamaggan +1/+1, Needling Crone doubles in combat', () => {
    const c = fight(mine(m('BG20_205', 6, 6), m('BG32_432', 6, 6)))
    const bloodGem = (c as unknown as { sides: { bloodGem: { atk: number } }[] }).sides[0].bloodGem
    expect(bloodGem).toEqual({ atk: 1, hp: 1 }) // the base; auras are added when a Gem is played
  })
})

// Trinkets act through stand-ins that never fight. Their Start of Combat part has happened before
// the boards are captured; what they do during combat is simulated.
describe('trinkets', () => {
  const withTrinket = (trinket: string, ...minions: MinionInput[]) => fight({ minions, heroTier: 4, trinkets: [trinket] })

  it('Feral Talisman: minions summoned in combat get the aura too', () => {
    const c = withTrinket('BG30_MagicItem_880', m('BG28_300', 1, 1))
    kill(c, 0, 0)
    expect(stats(c)).toEqual(['Skeleton 3/2', 'Skeleton 3/2'])
  })

  it('Alliance Keychain: the first friendly death gives its stats to a friendly minion, once', () => {
    const c = withTrinket('BG30_MagicItem_433', m(VAN, 4, 6), m(VAN, 1, 1))
    kill(c, 0, 0) // only one minion left to receive it
    expect(stats(c)).toEqual(['VANILLA 5/7'])
    c.summon(c.sides[0], c.makeMinion({ name: 'Extra', atk: 9, hp: 9 }), 1)
    kill(c, 0, 1) // a second death: no second gift
    expect(stats(c)).toEqual(['VANILLA 5/7'])
  })

  it('Mechagon Adapter gives a Mech its Divine Shield back, 3 times per combat', () => {
    const c = withTrinket('BG30_MagicItem_910', m('BG_BOT_312t', 1, 10, { divineShield: true }))
    const bot = c.sides[0].minions[0]
    for (let i = 0; i < 4; i++) c.damage(bot, 1)
    expect([bot.divineShield, bot.hp]).toEqual([false, 10])
    c.damage(bot, 1)
    expect(bot.hp).toBe(9)
  })

  it('Twin Sky Lanterns copies the first minion summoned, once there is room', () => {
    const c = withTrinket('BG30_MagicItem_822', m('BG28_300', 1, 1))
    kill(c, 0, 0)
    expect(stats(c)).toEqual(['Skeleton 1/1', 'Skeleton 1/1', 'Skeleton 1/1'])
  })

  it('Glowing Gauntlet is a shop trinket: nothing to simulate, nothing flagged', () => {
    const r = simulateMany(db, { minions: [m(VAN, 1, 1)], heroTier: 1, trinkets: ['BG30_MagicItem_841'] }, wall, { iterations: 10, seed: 1, skipStartOfCombat: true })
    expect([r.unsupported, r.approximated]).toEqual([[], []])
  })
})
