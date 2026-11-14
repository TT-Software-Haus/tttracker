// Battlegrounds combat simulator.
//
// Rules modelled:
// - The side with more minions attacks first (coin flip on a tie).
// - Sides alternate. Each side attacks with its left-most minion that hasn't
//   attacked yet this cycle, then the next one to the right, wrapping round.
// - Targets are random, but Taunt minions must be attacked first. Stealth
//   minions can't be targeted until they attack.
// - Damage is simultaneous. Divine Shield absorbs one hit; Venomous/Poisonous
//   destroys anything it damages (Venomous is used up).
// - Deaths are resolved in batches: Avenge counters, then Deathrattles (extra
//   triggers for Titus), then Reborn. This repeats until nothing else dies.
// - The fight ends when a side is empty, or neither side can attack (a tie).
//   The winner deals their tavern tier + the tiers of their surviving minions.

import type { CardInfo } from '../../../shared/types'
import { compileFx, compileHeroPower, type CardFx, type EffectEvent, type HeroPowerFx, type TriggerKind } from './effects'

export interface CardSource {
  get(cardId: string | undefined): CardInfo | undefined
  bgMinionsNamed(name: string): CardInfo[]
  bgSpellNamed(name: string): CardInfo | undefined
  pool(): CardInfo[]
}

export interface Minion {
  uid: number
  cardId: string
  name: string
  atk: number
  hp: number
  /** Maximum health (health before damage). */
  maxHp: number
  /** Card's printed attack, used by Reborn. */
  baseAtk: number
  tier: number
  tribes: string[]
  golden: boolean
  taunt: boolean
  divineShield: boolean
  venomous: boolean
  poisonous: boolean
  /** Attacks per turn: 1, 2 (Windfury) or 4 (Mega-Windfury). */
  windfury: number
  reborn: boolean
  stealth: boolean
  destroyed: boolean
  avenge: number
  attackImmediately: boolean
  killedBy?: Minion
  fx: CardFx
  /** Uses of limited triggers ("Twice per combat") so far. */
  uses?: Map<object, number>
}

export interface Side {
  idx: 0 | 1
  minions: Minion[]
  heroTier: number
  /** Index of the next minion to attack. */
  nextAttacker: number
  /** "Your Beetles have +5/+5 this game" style bonuses, keyed by minion name. */
  nameBonus: Map<string, { atk: number; hp: number }>
  /** "Your Beasts have +7/+7" style bonuses for minions summoned later, keyed by tribe. */
  tribeBonus: Map<string, { atk: number; hp: number }>
  /** Minions in hand (only known for your own side). Used by Start of Combat effects. */
  hand: Minion[]
  /** Teammate's warband in Duos (for Sandy). */
  teammate: MinionInput[]
  /** Duos: teammate's warband waiting to come in. */
  reserve?: ReserveInput
  /** The hero power fighting for this side (card id), if it acts in combat. */
  heroPower?: string
  /** "When you have space, summon ... from your hand" effects still waiting for room. */
  pendingFromHand: { tribe: string; left: number }[]
}

/** Input description of one minion on a board. */
export interface MinionInput {
  cardId: string
  atk: number
  health: number
  golden?: boolean
  taunt?: boolean
  divineShield?: boolean
  venomous?: boolean
  poisonous?: boolean
  windfury?: boolean
  megaWindfury?: boolean
  reborn?: boolean
  stealth?: boolean
  tier?: number
}

export interface BoardInput {
  minions: MinionInput[]
  heroTier: number
  hand?: MinionInput[]
  teammate?: MinionInput[]
  /** Hero power card id. Its Start of Combat effect runs unless Start of Combat is skipped. */
  heroPower?: string
  /** Duos: the teammate's warband (and hand) that takes over when this one is wiped out. */
  reserve?: ReserveInput
}

/** Duos: a warband waiting to come in. Its hero power fires as it enters. */
export interface ReserveInput {
  minions: MinionInput[]
  heroTier: number
  hand?: MinionInput[]
  heroPower?: string
}

export interface CombatOutcome {
  /** 0 = side A won, 1 = side B won, null = tie */
  winner: 0 | 1 | null
  damage: number
}

const MAX_BOARD = 7
const MAX_ATTACKS = 300

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hasTribe(m: { tribes: string[] }, tribe: string) {
  return m.tribes.includes(tribe) || m.tribes.includes('ALL')
}

export class Combat {
  readonly sides: [Side, Side]
  private uid = 1
  private fxCache: Map<string, CardFx>
  private heroPowerCache = new Map<string, HeroPowerFx>()

  constructor(
    readonly cards: CardSource,
    readonly rng: () => number,
    a: BoardInput,
    b: BoardInput,
    fxCache = new Map<string, CardFx>(),
  ) {
    this.fxCache = fxCache
    this.sides = [this.makeSide(0, a), this.makeSide(1, b)]
  }

  // ------------------------------------------------------------ setup

  private makeSide(idx: 0 | 1, input: BoardInput): Side {
    const side: Side = {
      idx,
      minions: [],
      heroTier: input.heroTier,
      nextAttacker: 0,
      nameBonus: new Map(),
      tribeBonus: new Map(),
      hand: (input.hand ?? []).map((m) => this.fromInput(m)),
      teammate: input.teammate ?? [],
      reserve: input.reserve?.minions.length ? input.reserve : undefined,
      heroPower: input.heroPower,
      pendingFromHand: [],
    }
    for (const m of input.minions.slice(0, MAX_BOARD)) side.minions.push(this.fromInput(m))
    return side
  }

  /** Build a live minion from an input description (also used for copies from hand / teammate). */
  minionFrom(m: MinionInput): Minion {
    return this.fromInput(m)
  }

  newUid() {
    return this.uid++
  }

  /** Summon from hand for any "when you have space" effects that are waiting. */
  fillFromHand(side: Side) {
    for (const p of side.pendingFromHand) {
      while (p.left > 0 && this.alive(side).length < MAX_BOARD) {
        const best = side.hand.filter((x) => hasTribe(x, p.tribe)).sort((a, b) => b.atk - a.atk)[0]
        if (!best) {
          p.left = 0
          break
        }
        side.hand.splice(side.hand.indexOf(best), 1)
        p.left--
        this.summon(side, { ...best, uid: this.newUid() }, side.minions.length)
      }
    }
    side.pendingFromHand = side.pendingFromHand.filter((p) => p.left > 0)
  }

  fx(cardId: string): CardFx {
    let fx = this.fxCache.get(cardId)
    if (!fx) {
      fx = compileFx(this.cards.get(cardId), this.cards)
      this.fxCache.set(cardId, fx)
    }
    return fx
  }

  private fromInput(m: MinionInput): Minion {
    const card = this.cards.get(m.cardId)
    return {
      uid: this.uid++,
      cardId: m.cardId,
      name: card?.name ?? m.cardId,
      atk: m.atk,
      hp: m.health,
      maxHp: m.health,
      baseAtk: card?.attack ?? m.atk,
      tier: m.tier ?? card?.techLevel ?? 1,
      tribes: card?.races ?? [],
      golden: !!m.golden || !!card?.normalId,
      taunt: !!m.taunt,
      divineShield: !!m.divineShield,
      venomous: !!m.venomous,
      poisonous: !!m.poisonous,
      windfury: m.megaWindfury ? 4 : m.windfury ? 2 : 1,
      reborn: !!m.reborn,
      stealth: !!m.stealth,
      destroyed: false,
      avenge: 0,
      attackImmediately: false,
      fx: this.fx(m.cardId),
    }
  }

  /** Create a fresh minion from a card (or a plain token when no card is known). */
  makeMinion(opts: { card?: CardInfo; name?: string; atk?: number; hp?: number; tribes?: string[]; keywords?: string[]; tier?: number }): Minion {
    const card = opts.card
    const mech = new Set([...(card?.mechanics ?? []), ...(opts.keywords ?? [])])
    return {
      uid: this.uid++,
      cardId: card?.id ?? '',
      name: card?.name ?? opts.name ?? 'Token',
      atk: opts.atk ?? card?.attack ?? 1,
      hp: opts.hp ?? card?.health ?? 1,
      maxHp: opts.hp ?? card?.health ?? 1,
      baseAtk: card?.attack ?? opts.atk ?? 1,
      tier: opts.tier ?? card?.techLevel ?? 1,
      tribes: opts.tribes ?? card?.races ?? [],
      golden: !!card?.normalId,
      taunt: mech.has('TAUNT'),
      divineShield: mech.has('DIVINE_SHIELD'),
      venomous: mech.has('VENOMOUS'),
      poisonous: mech.has('POISONOUS'),
      windfury: mech.has('MEGA_WINDFURY') ? 4 : mech.has('WINDFURY') ? 2 : 1,
      reborn: mech.has('REBORN'),
      stealth: mech.has('STEALTH'),
      destroyed: false,
      avenge: 0,
      attackImmediately: false,
      fx: card ? this.fx(card.id) : { unsupported: [] },
    }
  }

  // ------------------------------------------------------------ queries

  other(side: Side): Side {
    return this.sides[1 - side.idx]
  }

  sideOf(m: Minion): Side | undefined {
    return this.sides.find((s) => s.minions.includes(m))
  }

  alive(side: Side): Minion[] {
    return side.minions.filter((m) => !this.isDead(m))
  }

  isDead(m: Minion) {
    return m.hp <= 0 || m.destroyed
  }

  /** The most recently summoned minion ("Summon a random Beast. Set its stats to 6/6."). */
  lastSummoned?: Minion

  /**
   * Fire generic triggers ("whenever a friendly Beast dies", "whenever this is
   * attacked", ...) on `side`. `subject` is the minion the event is about.
   */
  fire(side: Side, kind: TriggerKind, subject: Minion, ev: EffectEvent = {}) {
    for (const f of [...side.minions]) {
      if (this.isDead(f) || !f.fx.triggers) continue
      for (const t of f.fx.triggers) {
        if (t.on !== kind) continue
        if (t.selfOnly ? f !== subject : t.excludeSelf && f === subject) continue
        if (t.tribe && !hasTribe(subject, t.tribe)) continue
        if (t.needTaunt && !subject.taunt) continue
        if (t.needDeathrattle && !subject.fx.deathrattle?.length) continue
        if (t.limit !== undefined) {
          const used = f.uses?.get(t) ?? 0
          if (used >= t.limit) continue
          ;(f.uses ??= new Map()).set(t, used + 1)
        }
        this.run(t.effects, f, side, { ...ev, other: subject })
      }
    }
  }

  pick<T>(list: T[]): T | undefined {
    return list.length ? list[Math.floor(this.rng() * list.length)] : undefined
  }

  pickN<T>(list: T[], n: number): T[] {
    const copy = [...list]
    const out: T[] = []
    while (copy.length && out.length < n) out.push(copy.splice(Math.floor(this.rng() * copy.length), 1)[0])
    return out
  }

  // ------------------------------------------------------------ actions

  buff(m: Minion, atk: number, hp: number) {
    if (this.isDead(m)) return
    m.atk = Math.max(0, m.atk + atk)
    m.hp += hp
    m.maxHp += hp
  }

  /** Deal damage from `source` (may be undefined for effects). Returns damage actually taken. */
  damage(target: Minion, amount: number, source?: Minion): number {
    if (amount <= 0 || this.isDead(target)) return 0
    if (target.divineShield) {
      target.divineShield = false
      this.onShieldLost(target)
      return 0
    }
    target.hp -= amount
    if (source && (source.venomous || source.poisonous) && target.hp > 0) {
      target.destroyed = true
      if (source.venomous) source.venomous = false
    }
    if (this.isDead(target) && !target.killedBy) target.killedBy = source
    if (source) this.onDamageDealt(source)
    // "Whenever this takes damage, ..." / "Whenever a friendly Beast takes damage, ..."
    const side = this.sideOf(target)
    if (side) {
      if (target.fx.onDamaged) this.run(target.fx.onDamaged, target, side, { other: source })
      this.fire(side, 'damaged', target, { target: source })
    }
    return amount
  }

  /** "Whenever this kills a minion, ..." / "After a friendly minion kills an enemy, ..." */
  private onKilled(killer: Minion, victim: Minion, attacking: boolean) {
    const side = this.sideOf(killer)
    if (!side) return
    if (killer.fx.onKill) this.run(killer.fx.onKill, killer, side, { target: victim, attacking })
    this.fire(side, 'kill', killer, { target: victim, attacking })
  }

  /** "After another friendly Demon deals damage, ..." */
  private onDamageDealt(source: Minion) {
    const side = this.sideOf(source)
    if (!side) return
    for (const f of side.minions) {
      if (this.isDead(f) || !f.fx.onFriendlyDamage) continue
      for (const t of f.fx.onFriendlyDamage) {
        if (t.excludeSelf && f === source) continue
        if (t.tribe && !hasTribe(source, t.tribe)) continue
        this.run(t.effects, f, side, { other: source })
      }
    }
  }

  summon(side: Side, m: Minion, pos: number): Minion | undefined {
    if (this.alive(side).length >= MAX_BOARD) return undefined
    const nb = side.nameBonus.get(m.name)
    if (nb) this.buff(m, nb.atk, nb.hp)
    for (const [tribe, b] of side.tribeBonus) if (hasTribe(m, tribe)) this.buff(m, b.atk, b.hp)
    pos = Math.max(0, Math.min(pos, side.minions.length))
    side.minions.splice(pos, 0, m)
    this.lastSummoned = m
    if (pos < side.nextAttacker) side.nextAttacker++
    for (const f of [...side.minions]) {
      if (f !== m && !this.isDead(f) && f.fx.onSummon) this.run(f.fx.onSummon, f, side, { other: m })
    }
    return m
  }

  run(effects: ((c: Combat, self: Minion, side: Side, ev: EffectEvent) => void)[] | undefined, self: Minion, side: Side, ev: EffectEvent = {}) {
    if (!effects) return
    for (const e of effects) e(this, self, side, ev)
  }

  private onShieldLost(m: Minion) {
    const side = this.sideOf(m)
    if (!side) return
    if (m.fx.tauntWhileShielded) m.taunt = false
    for (const f of side.minions) if (!this.isDead(f) && f.fx.onShieldLost) this.run(f.fx.onShieldLost, f, side, { other: m })
  }

  // ------------------------------------------------------------ combat flow

  simulate(opts: { firstAttacker?: 0 | 1; skipStartOfCombat?: boolean } = {}): CombatOutcome {
    for (const s of this.sides) for (const m of s.minions) if (m.fx.tauntWhileShielded && m.divineShield) m.taunt = true

    let turn: 0 | 1
    if (opts.firstAttacker !== undefined) turn = opts.firstAttacker
    else {
      const [a, b] = this.sides.map((s) => s.minions.length)
      turn = a > b ? 0 : b > a ? 1 : this.rng() < 0.5 ? 0 : 1
    }

    if (!opts.skipStartOfCombat) this.startOfCombat(turn)
    else {
      // Start of Combat already happened. A "summon from hand when you have
      // space" effect is still waiting if its board was full at the time.
      for (const side of this.sides)
        if (this.alive(side).length >= MAX_BOARD)
          for (const m of side.minions) if (m.fx.summonFromHand) side.pendingFromHand.push({ ...m.fx.summonFromHand })
    }

    for (let i = 0; i < MAX_ATTACKS; i++) {
      // Duos: a wiped-out warband is replaced by its teammate's.
      if (this.bringInReserves()) {
        const [a, b] = this.sides.map((s) => this.alive(s).length)
        turn = a > b ? 0 : b > a ? 1 : this.rng() < 0.5 ? 0 : 1
      }
      if (!this.alive(this.sides[0]).length || !this.alive(this.sides[1]).length) break
      const side = this.sides[turn]
      const attacker = this.nextAttacker(side)
      if (!attacker) {
        if (!this.nextAttacker(this.other(side))) break // nobody can attack: tie
      } else {
        this.attackWith(side, attacker)
      }
      turn = (1 - turn) as 0 | 1
    }
    return this.outcome()
  }

  private outcome(): CombatOutcome {
    const [a, b] = this.sides.map((s) => this.alive(s))
    if (a.length && !b.length) return { winner: 0, damage: this.sides[0].heroTier + a.reduce((n, m) => n + m.tier, 0) }
    if (b.length && !a.length) return { winner: 1, damage: this.sides[1].heroTier + b.reduce((n, m) => n + m.tier, 0) }
    return { winner: null, damage: 0 }
  }

  private startOfCombat(first: 0 | 1) {
    // Minions with Start of Combat effects, first attacker's side first, left to right.
    for (const idx of [first, 1 - first]) {
      const side = this.sides[idx]
      // Hero powers go first, then effects that trigger from hand (e.g. Flighty Scout).
      this.heroPowerFx(side.heroPower).startOfCombat?.(this, side)
      for (const m of [...side.hand]) if (m.fx.startOfCombatFromHand) this.run(m.fx.startOfCombatFromHand, m, side)
      for (const m of [...side.minions]) {
        if (this.isDead(m)) continue
        if (m.fx.startOfCombat) this.run(m.fx.startOfCombat, m, side)
      }
      this.resolveDeaths(side)
    }
    for (const idx of [first, 1 - first]) this.attackImmediately(this.sides[idx])
  }

  /** "Attack immediately" minions (Start of Combat effects, Wingmen) take their attack now. */
  private attackImmediately(side: Side) {
    for (const m of [...side.minions]) {
      if (m.attackImmediately && !this.isDead(m) && this.alive(this.other(side)).length) {
        m.attackImmediately = false
        this.singleAttack(side, m)
      }
    }
  }

  private heroPowerFx(cardId: string | undefined): HeroPowerFx {
    if (!cardId) return { unsupported: [] }
    let fx = this.heroPowerCache.get(cardId)
    if (!fx) {
      fx = compileHeroPower(this.cards.get(cardId))
      this.heroPowerCache.set(cardId, fx)
    }
    return fx
  }

  /** Swap in the teammate's warband for any side that has been wiped out. */
  private bringInReserves(): boolean {
    let swapped = false
    for (const side of this.sides) {
      if (this.alive(side).length || !side.reserve) continue
      const r = side.reserve
      side.reserve = undefined
      side.minions = r.minions.slice(0, MAX_BOARD).map((m) => this.fromInput(m))
      side.heroTier = r.heroTier
      side.nextAttacker = 0
      side.hand = (r.hand ?? []).map((m) => this.fromInput(m))
      side.nameBonus = new Map()
      side.tribeBonus = new Map()
      side.pendingFromHand = []
      side.heroPower = r.heroPower
      // The incoming warband's Start of Combat effects fire as it enters: hero power first
      // (seen live: Illidan's Wingmen buffed the reserve before anything else happened).
      this.heroPowerFx(side.heroPower).startOfCombat?.(this, side)
      for (const m of [...side.hand]) if (m.fx.startOfCombatFromHand) this.run(m.fx.startOfCombatFromHand, m, side)
      for (const m of [...side.minions]) if (!this.isDead(m) && m.fx.startOfCombat) this.run(m.fx.startOfCombat, m, side)
      this.resolveDeaths(side)
      this.attackImmediately(side)
      swapped = true
    }
    return swapped
  }

  private nextAttacker(side: Side): Minion | undefined {
    const list = side.minions
    if (!list.length) return undefined
    const n = list.length
    const start = side.nextAttacker % n
    for (let k = 0; k < n; k++) {
      const m = list[(start + k) % n]
      if (!this.isDead(m) && m.atk > 0) return m
    }
    return undefined
  }

  private attackWith(side: Side, attacker: Minion) {
    const idx = side.minions.indexOf(attacker)
    for (let t = 0; t < attacker.windfury; t++) {
      if (this.isDead(attacker) || !this.alive(this.other(side)).length) break
      this.singleAttack(side, attacker)
    }
    const now = side.minions.indexOf(attacker)
    side.nextAttacker = now >= 0 ? now + 1 : idx
  }

  chooseTarget(side: Side): Minion | undefined {
    const enemies = this.alive(side)
    const visible = enemies.filter((m) => !m.stealth)
    const pool = visible.length ? visible : enemies
    const taunts = pool.filter((m) => m.taunt)
    return this.pick(taunts.length ? taunts : pool)
  }

  /** One attack, including Rally and "whenever a friendly minion attacks" triggers. */
  singleAttack(side: Side, attacker: Minion, forcedTarget?: Minion) {
    const enemy = this.other(side)
    const target = forcedTarget && !this.isDead(forcedTarget) ? forcedTarget : this.chooseTarget(enemy)
    if (!target) return
    attacker.stealth = false

    this.run(attacker.fx.rally, attacker, side, { target })
    for (const f of [...side.minions]) {
      if (this.isDead(f) || !f.fx.friendlyAttack) continue
      for (const t of f.fx.friendlyAttack) {
        if (t.excludeSelf && f === attacker) continue
        if (t.tribe && !hasTribe(attacker, t.tribe)) continue
        if (t.rallyOnly && !attacker.fx.rally) continue
        this.run(t.effects, f, side, { other: attacker, target })
      }
    }
    if (this.isDead(attacker) || this.isDead(target)) {
      this.resolveDeaths(side)
      return
    }

    const targetHpBefore = target.hp
    const targetIdx = enemy.minions.indexOf(target)
    const hits: Minion[] = [target]
    if (attacker.fx.cleave) {
      const l = enemy.minions[targetIdx - 1]
      const r = enemy.minions[targetIdx + 1]
      if (l && !this.isDead(l)) hits.push(l)
      if (r && !this.isDead(r)) hits.push(r)
    }
    // "Whenever this is attacked" / "Whenever a friendly Taunt minion is attacked" fire before damage.
    this.fire(enemy, 'attacked', target, { target: attacker })
    if (this.isDead(target) || this.isDead(attacker)) {
      this.resolveDeaths(side)
      return
    }
    const atk = attacker.atk
    const back = target.atk
    for (const h of hits) this.damage(h, atk, attacker)
    if (!attacker.fx.immuneWhileAttacking) this.damage(attacker, back, target)
    for (const h of hits) if (this.isDead(h)) this.onKilled(attacker, h, true)
    if (this.isDead(attacker)) this.onKilled(target, attacker, false)

    if (this.isDead(target) && attacker.fx.overkillAdjacent && !target.divineShield) {
      const excess = atk - Math.max(0, targetHpBefore)
      const adj = [enemy.minions[targetIdx - 1], enemy.minions[targetIdx + 1]].filter((m) => m && !this.isDead(m))
      const pickAdj = this.pick(adj)
      if (pickAdj && excess > 0) this.damage(pickAdj, excess, attacker)
    }
    if (!this.isDead(attacker)) this.run(attacker.fx.afterAttack, attacker, side, { target })
    this.resolveDeaths(side)
  }

  /** Remove dead minions and fire their triggers until the board is stable. */
  resolveDeaths(activeSide: Side) {
    for (let guard = 0; guard < 50; guard++) {
      const batch: { m: Minion; side: Side; pos: number }[] = []
      for (const side of [activeSide, this.other(activeSide)]) {
        for (let i = 0; i < side.minions.length; i++) {
          const m = side.minions[i]
          if (this.isDead(m)) batch.push({ m, side, pos: i })
        }
      }
      if (!batch.length) {
        // Board stable: room may have opened up for "summon from hand when you have space".
        for (const side of this.sides) if (side.pendingFromHand.length) this.fillFromHand(side)
        return
      }
      // Remove all first (right to left so indexes stay valid), remembering positions.
      for (const side of this.sides) {
        for (let i = side.minions.length - 1; i >= 0; i--) {
          if (this.isDead(side.minions[i])) {
            side.minions.splice(i, 1)
            if (i < side.nextAttacker) side.nextAttacker--
          }
        }
      }
      // Positions shift as earlier deaths are removed; account for that.
      for (const d of batch) {
        const before = batch.filter((o) => o.side === d.side && o.pos < d.pos).length
        d.pos -= before
      }
      for (const { m, side, pos } of batch) {
        // "After a friendly Beast dies", "After a friendly Deathrattle minion dies", ...
        this.fire(side, 'dies', m, { pos })
        // Avenge
        for (const f of side.minions) {
          if (this.isDead(f) || !f.fx.avenge) continue
          f.avenge++
          if (f.avenge >= f.fx.avenge.n) {
            f.avenge = 0
            this.run(f.fx.avenge.effects, f, side)
          }
        }
        // Deathrattles (Titus and friends add extra triggers)
        if (m.fx.deathrattle) {
          const extra = side.minions.reduce((n, f) => n + (!this.isDead(f) ? f.fx.extraDeathrattles ?? 0 : 0), 0)
          for (let k = 0; k <= extra; k++) this.run(m.fx.deathrattle, m, side, { pos })
        }
        // Reborn
        if (m.reborn) {
          const card = this.cards.get(m.cardId)
          const copy = this.makeMinion({ card, hp: 1 })
          copy.reborn = false
          copy.atk = card?.attack ?? m.baseAtk
          if (this.summon(side, copy, pos)) {
            for (const f of side.minions) if (f !== copy && !this.isDead(f) && f.fx.onFriendlyReborn) this.run(f.fx.onFriendlyReborn, f, side, { other: copy })
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ runner

export interface SimSummary {
  win: number
  tie: number
  loss: number
  avgDamageDealt: number
  avgDamageTaken: number
  lethalWin: number
  lethalLoss: number
  iterations: number
  ms: number
  unsupported: string[]
}

export function simulateMany(
  cards: CardSource,
  a: BoardInput,
  b: BoardInput,
  opts: { iterations?: number; seed?: number; firstAttacker?: 0 | 1; skipStartOfCombat?: boolean; myHealth?: number; oppHealth?: number; timeBudgetMs?: number } = {},
): SimSummary {
  const iterations = opts.iterations ?? 5000
  const rng = mulberry32(opts.seed ?? (Math.random() * 2 ** 32) >>> 0)
  const fxCache = new Map<string, CardFx>()
  const t0 = Date.now()
  let win = 0
  let tie = 0
  let loss = 0
  let dealt = 0
  let taken = 0
  let lethalWin = 0
  let lethalLoss = 0
  let n = 0
  for (; n < iterations; n++) {
    if (opts.timeBudgetMs && n % 100 === 0 && Date.now() - t0 > opts.timeBudgetMs) break
    const c = new Combat(cards, rng, a, b, fxCache)
    const r = c.simulate({ firstAttacker: opts.firstAttacker, skipStartOfCombat: opts.skipStartOfCombat })
    if (r.winner === 0) {
      win++
      dealt += r.damage
      if (opts.oppHealth !== undefined && r.damage >= opts.oppHealth) lethalWin++
    } else if (r.winner === 1) {
      loss++
      taken += r.damage
      if (opts.myHealth !== undefined && r.damage >= opts.myHealth) lethalLoss++
    } else tie++
  }
  const unsupported = new Set<string>()
  for (const board of [a, b])
    for (const m of [...board.minions, ...(board.reserve?.minions ?? [])]) {
      const fx = fxCache.get(m.cardId) ?? compileFx(cards.get(m.cardId), cards)
      if (fx.unsupported.length) unsupported.add(cards.get(m.cardId)?.name ?? m.cardId)
    }
  // Hero powers only act at Start of Combat: a reserve's always does, the first warbands' only if it hasn't happened yet.
  const powers = [a, b].flatMap((board) => [opts.skipStartOfCombat ? undefined : board.heroPower, board.reserve?.heroPower])
  for (const id of powers) {
    const card = id ? cards.get(id) : undefined
    if (card && compileHeroPower(card).unsupported.length) unsupported.add(card.name)
  }
  return {
    win: win / n,
    tie: tie / n,
    loss: loss / n,
    avgDamageDealt: win ? dealt / win : 0,
    avgDamageTaken: loss ? taken / loss : 0,
    lethalWin: lethalWin / n,
    lethalLoss: lethalLoss / n,
    iterations: n,
    ms: Date.now() - t0,
    unsupported: [...unsupported],
  }
}
