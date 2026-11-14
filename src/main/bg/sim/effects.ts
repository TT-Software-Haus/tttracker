// Turns Battlegrounds card text into simulator effects.
//
// Most combat effects follow a handful of templates ("Deathrattle: Summon two
// 1/1 Skeletons", "Rally: Give your other minions +4/+1", ...). Golden cards
// have their own text with doubled numbers, so parsing the exact card's text
// handles golden versions for free. Cards that don't fit a template get a
// hand-written handler in MANUAL; anything still unknown is reported as
// "unsupported" so the UI can say the odds may be off.

import type { CardInfo } from '../../../shared/types'
import type { CardSource, Combat, Minion, Side } from './engine'
import { hasTribe } from './engine'

export interface EffectEvent {
  /** Rally / attack triggers: the minion being attacked. */
  target?: Minion
  /** The other minion involved (attacker for "whenever a friendly minion attacks", summoned minion, reborn minion). */
  other?: Minion
  /** Deathrattles: the board position the dying minion occupied. */
  pos?: number
  /** Kill triggers: whether the killer was the one attacking. */
  attacking?: boolean
  /** Stat-gain triggers: what was gained. */
  atk?: number
  hp?: number
}

export type Effect = (c: Combat, self: Minion, side: Side, ev: EffectEvent) => void

export interface FriendlyAttackTrigger {
  tribe?: string
  excludeSelf: boolean
  rallyOnly?: boolean
  effects: Effect[]
}

/** Generic triggers fired by the engine (see Combat.fire). */
export type TriggerKind = 'dies' | 'attacked' | 'damaged' | 'kill'

export interface Trigger {
  on: TriggerKind
  /** Only when the subject is the minion itself ("whenever THIS is attacked"). */
  selfOnly?: boolean
  excludeSelf?: boolean
  tribe?: string
  needTaunt?: boolean
  needDeathrattle?: boolean
  /** "(Twice per combat.)" */
  limit?: number
  effects: Effect[]
}

export interface CardFx {
  triggers?: Trigger[]
  /** "Immune while attacking." */
  immuneWhileAttacking?: boolean
  deathrattle?: Effect[]
  startOfCombat?: Effect[]
  rally?: Effect[]
  afterAttack?: Effect[]
  avenge?: { n: number; effects: Effect[] }
  friendlyAttack?: FriendlyAttackTrigger[]
  onSummon?: Effect[]
  onFriendlyReborn?: Effect[]
  onShieldLost?: Effect[]
  /** "After another friendly Demon deals damage, ..." */
  onFriendlyDamage?: FriendlyAttackTrigger[]
  /** "When you have space in combat, ...": runs once, the first time the board has room. */
  whenSpace?: Effect[]
  /** "Whenever this kills a minion" (ev.target = the victim, ev.attacking). */
  onKill?: Effect[]
  /** "Whenever this takes damage" */
  onDamaged?: Effect[]
  /** "Whenever a friendly minion gains Attack" (ev.other = it, ev.atk/hp = the gain); selfOnly: "After this gains stats". */
  onGainStats?: { selfOnly?: boolean; needAtk?: boolean; effects: Effect[] }[]
  /** "After you trigger a Deathrattle" (ev.other = the minion whose Deathrattle it was). */
  afterDeathrattle?: Effect[]
  /** Start of Combat effects that fire while the card is in hand (Flighty Scout). */
  startOfCombatFromHand?: Effect[]
  extraDeathrattles?: number
  /** Diremuck Forager: summons from hand whenever there's room (for this combat). */
  summonFromHand?: { tribe: string; left: number }
  cleave?: boolean
  overkillAdjacent?: boolean
  tauntWhileShielded?: boolean
  /** Text we couldn't turn into effects (empty = fully modelled). */
  unsupported: string[]
  /** Text modelled on a best guess, because the log doesn't give what it needs. */
  approximated?: string[]
}

const TRIBES: Record<string, string> = {
  beast: 'BEAST',
  dragon: 'DRAGON',
  demon: 'DEMON',
  murloc: 'MURLOC',
  mech: 'MECHANICAL',
  mechanical: 'MECHANICAL',
  elemental: 'ELEMENTAL',
  pirate: 'PIRATE',
  quilboar: 'QUILBOAR',
  naga: 'NAGA',
  undead: 'UNDEAD',
  aberration: 'ABERRATION',
}

const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

function num(s: string): number {
  return NUMBERS[s.toLowerCase()] ?? Number(s)
}

/** "Beasts" -> BEAST, "Undead" -> UNDEAD, "minions" -> undefined (any). */
function tribeOf(word: string): string | undefined {
  const w = word.toLowerCase().replace(/s$/, '')
  return TRIBES[w] ?? TRIBES[word.toLowerCase()]
}

export function cleanText(text: string | undefined): string {
  return (text ?? '')
    .replace(/<\/?[a-z]+>/gi, '')
    .replace(/\[x\]/g, '')
    .replace(/[\n\r]+/g, ' ')
    .replace(/\$(\d+)/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\b(left|right|highest|lowest)- (most|health|attack)\b/gi, '$1-$2') // "left-\n    most" in the raw text
    .trim()
}

// ---------------------------------------------------------------- targeting

type Selector = (c: Combat, self: Minion, side: Side, ev: EffectEvent) => Minion[]

function friendlies(c: Combat, side: Side) {
  return c.alive(side)
}

/** Parse who an effect applies to, e.g. "your other Beasts", "a random friendly Undead", "adjacent minions". */
function parseSelector(phrase: string): Selector | undefined {
  const p = phrase.trim().toLowerCase()
  let m: RegExpExecArray | null
  if (p === 'it') return (_c, _s, _side, ev) => (ev.other ? [ev.other] : [])
  if (p === 'this' || p === 'itself' || p === 'this minion') return (_c, self) => [self]
  if (p === 'this minion and its neighbors' || p === 'this and adjacent minions') {
    return (c, self, side) => {
      const i = side.minions.indexOf(self)
      return [side.minions[i - 1], self, side.minions[i + 1]].filter((x): x is Minion => !!x && !c.isDead(x))
    }
  }
  if (p === 'adjacent murlocs') {
    return (c, self, side) => {
      const i = side.minions.indexOf(self)
      return [side.minions[i - 1], side.minions[i + 1]].filter((x): x is Minion => !!x && !c.isDead(x) && hasTribe(x, 'MURLOC'))
    }
  }
  // Hand minions matter in combat only when something summons them from hand.
  if ((m = /^the (left-most|two left-most) minions? in your hand$/.exec(p))) {
    const n = m[1] === 'left-most' ? 1 : 2
    return (_c, _self, side) => side.hand.slice(0, n)
  }
  if (p === 'all minions') return (c) => c.sides.flatMap((sd) => c.alive(sd))
  if ((m = /^your (left|right)-most minion$/.exec(p))) {
    const left = m[1] === 'left'
    return (c, _self, side) => {
      const a = c.alive(side)
      const t = left ? a[0] : a[a.length - 1]
      return t ? [t] : []
    }
  }
  if ((m = /^your (lowest|highest)-attack minion$/.exec(p))) {
    const low = m[1] === 'lowest'
    return (c, _self, side) => {
      const a = [...c.alive(side)].sort((x, y) => (low ? x.atk - y.atk : y.atk - x.atk))
      return a.length ? [c.pick(a.filter((x) => x.atk === a[0].atk))!] : []
    }
  }
  if (p === 'a random minion in your hand') return (c, _self, side) => [c.pick(side.hand)].filter((x): x is Minion => !!x)
  if (p === 'the undead to the right') {
    return (c, self, side) => {
      const r = side.minions[side.minions.indexOf(self) + 1]
      return r && !c.isDead(r) && hasTribe(r, 'UNDEAD') ? [r] : []
    }
  }
  if (p === 'this and your deity' || p === 'your deity' || p === "your team's deities") return () => []
  if (p === 'adjacent minions') {
    return (c, self, side) => {
      const i = side.minions.indexOf(self)
      return [side.minions[i - 1], side.minions[i + 1]].filter((x): x is Minion => !!x && !c.isDead(x))
    }
  }
  if (p === 'the minion to the right') {
    return (c, self, side) => {
      const r = side.minions[side.minions.indexOf(self) + 1]
      return r && !c.isDead(r) ? [r] : []
    }
  }
  // your (other) minions / your (other) Beasts / all your Naga
  if ((m = /^(?:all )?your (other )?(\w+)$/.exec(p))) {
    const other = !!m[1]
    const tribe = m[2] === 'minions' ? undefined : tribeOf(m[2])
    if (m[2] !== 'minions' && !tribe) return undefined
    return (c, self, side) => friendlies(c, side).filter((x) => (!other || x !== self) && (!tribe || hasTribe(x, tribe)))
  }
  // a (random) friendly X / another friendly X / a different friendly X
  if ((m = /^(?:a random friendly|a friendly|another friendly|a different friendly|another random friendly) (\w+)$/.exec(p))) {
    const tribe = m[1] === 'minion' ? undefined : tribeOf(m[1])
    if (m[1] !== 'minion' && !tribe) return undefined
    // Never picks itself (when dying it's already gone; for Rally the text always means "another").
    return (c, self, side) => {
      const pool = friendlies(c, side).filter((x) => x !== self && (!tribe || hasTribe(x, tribe)))
      const one = c.pick(pool)
      return one ? [one] : []
    }
  }
  // two other friendly Dragons / 3 friendly Dragons
  if ((m = /^(\w+) (?:other |different )?(?:random )?friendly (\w+?)s?$/.exec(p)) && (NUMBERS[m[1]] || /^\d+$/.test(m[1]))) {
    const n = num(m[1])
    const tribe = m[2] === 'minion' ? undefined : tribeOf(m[2])
    return (c, self, side) => c.pickN(friendlies(c, side).filter((x) => x !== self && (!tribe || hasTribe(x, tribe))), n)
  }
  return undefined
}

/** Single enemy targets: "the left-most enemy minion", "the highest-Health enemy minion". */
function enemyTarget(who: string): ((c: Combat, enemies: Minion[]) => Minion | undefined) | undefined {
  const m = /^the (left-most|right-most|highest-health|lowest-health) enemy minion$/.exec(who)
  if (!m) return undefined
  const how = m[1]
  return (c, enemies) => {
    if (!enemies.length) return undefined
    if (how === 'left-most') return enemies[0]
    if (how === 'right-most') return enemies[enemies.length - 1]
    const sorted = [...enemies].sort((a, b) => (how === 'highest-health' ? b.hp - a.hp : a.hp - b.hp))
    return c.pick(sorted.filter((x) => x.hp === sorted[0].hp))
  }
}

/** One minion per minion type, each a different minion ("a friendly minion of each type"). */
function oneOfEachType(c: Combat, pool: Minion[]): Minion[] {
  const out: Minion[] = []
  // Each minion is buffed at most once, so an all-type minion fills one type that nothing else has.
  const types = pool.some((x) => x.tribes.includes('ALL')) ? [...new Set(Object.values(TRIBES))] : [...new Set(pool.flatMap((x) => x.tribes))]
  // All-type minions can stand in for any type: place the single-type ones first.
  for (const t of c.pickN(types, types.length)) {
    const pick = c.pick(pool.filter((x) => !out.includes(x) && x.tribes.includes(t)))
      ?? c.pick(pool.filter((x) => !out.includes(x) && x.tribes.includes('ALL')))
    if (pick) out.push(pick)
  }
  return out
}

// ---------------------------------------------------------------- actions

const KEYWORD: Record<string, keyof Minion> = {
  'divine shield': 'divineShield',
  taunt: 'taunt',
  reborn: 'reborn',
  venomous: 'venomous',
  windfury: 'windfury',
}

function setKeyword(m: Minion, kw: string, on: boolean) {
  const k = KEYWORD[kw.toLowerCase()]
  if (!k) return
  if (k === 'windfury') m.windfury = on ? Math.max(2, m.windfury) : 1
  else (m as unknown as Record<string, boolean>)[k] = on
}

function parseKeywords(s: string | undefined): string[] | undefined {
  if (!s) return []
  const parts = s.split(/,? and |, /).map((x) => x.trim().toLowerCase())
  return parts.every((x) => KEYWORD[x]) ? parts : undefined
}

/** Things that never affect a fight: hand, tavern, gold, teammate. */
const IRRELEVANT = /^(get |add |discover|your teammate|you and your teammate|reduce|your tavern spells|after the tavern|improve|give minions in the tavern|give a random minion in it|refresh|golden ones keep|it opens|trigger the battlecries|gain .* gold|it attacks immediately|if you already have)/i

function parseAction(sentence: string, cards: CardSource, self: CardInfo | undefined): Effect | 'ignore' | undefined {
  let s = sentence.trim().replace(/\.$/, '')
  let times = 1
  s = s.replace(/ permanently(?=,? twice$|$)/i, '')
  if (/,? twice$/i.test(s)) {
    times = 2
    s = s.replace(/,? twice$/i, '')
  }
  s = s.replace(/^for the rest of this combat, /i, '').replace(/ permanently$/i, '')
  if (IRRELEVANT.test(s) || SHOP_TRIGGER.test(s) || SHOP_WORDS.test(s)) return 'ignore'
  const once = parseActionOnce(s, cards, self)
  if (!once || once === 'ignore' || times === 1) return once
  return (c, me, side, ev) => {
    for (let i = 0; i < times; i++) once(c, me, side, ev)
  }
}

function parseActionOnce(s: string, cards: CardSource, self: CardInfo | undefined): Effect | 'ignore' | undefined {
  let m: RegExpExecArray | null

  // Summon N A/H Name(s) [with Keywords]
  // (Falls through when the "with ..." part isn't keywords: "with this minion's maximum stats" has its own template.)
  if ((m = /^summon (a|an|one|two|three|four|five|six|seven|\d+) (?:(\d+)\/(\d+) )?(.+?)(?: that .+)?(?: with (.+))?$/i.exec(s)) && parseKeywords(m[5])) {
    const count = num(m[1])
    const atk = m[2] !== undefined ? Number(m[2]) : undefined
    const hp = m[3] !== undefined ? Number(m[3]) : undefined
    const rawName = m[4].trim()
    const kws = parseKeywords(m[5])!
    const random = /^random (\w+) minions?$/i.exec(rawName)
    if (random) {
      const what = random[1].toLowerCase()
      const tribe = tribeOf(what)
      const pool = cards.pool().filter((c) => (what === 'deathrattle' ? c.mechanics?.includes('DEATHRATTLE') : tribe ? c.races?.includes(tribe) : false))
      if (!pool.length) return undefined
      return (c, _me, side, ev) => {
        for (let i = 0; i < count; i++) {
          const card = c.pick(pool)
          if (card) c.summon(side, c.makeMinion({ card }), (ev.pos ?? side.minions.length) + i)
        }
      }
    }
    const golden = /^golden /i.test(rawName)
    const baseName = rawName.replace(/^golden /i, '')
    const singular = baseName.replace(/(es|s)$/, '')
    const tokenCard = [baseName, singular, baseName.replace(/s$/, '')]
      .map((n) => {
        const found = cards.bgMinionsNamed(n)
        return (golden ? found.find((c) => c.normalId) : found.find((c) => !c.normalId)) ?? found[0]
      })
      .find(Boolean)
    const tribe = tribeOf(rawName)
    if (!tokenCard && (atk === undefined || hp === undefined)) return undefined
    return (c, _me, side, ev) => {
      for (let i = 0; i < count; i++) {
        const tok = c.makeMinion({ card: tokenCard, name: singular, atk, hp, tribes: tokenCard ? undefined : tribe ? [tribe] : [], keywords: kws.map((k) => k.toUpperCase().replace(' ', '_')) })
        c.summon(side, tok, (ev.pos ?? side.minions.indexOf(_me) + 1) + i)
      }
    }
  }

  // Give <who> +A/+H [and Keyword...]  |  Give <who> +A Attack  |  Give <who> Keyword
  if ((m = /^give (.+?) \+(\d+)\/\+(\d+)(?: and (.+))?$/i.exec(s)) || (m = /^give (.+?) \+(\d+) (attack|health)(?: and (.+))?$/i.exec(s))) {
    // Falls through when the target or the tail isn't one of these ("... and summon it", "... of each type").
    const sel = parseSelector(m[1])
    let atk: number
    let hp: number
    let kwText: string | undefined
    if (m[3] === undefined || /attack|health/i.test(m[3])) {
      const isHealth = /health/i.test(m[3] ?? '')
      atk = isHealth ? 0 : Number(m[2])
      hp = isHealth ? Number(m[2]) : 0
      kwText = m[4]
    } else {
      atk = Number(m[2])
      hp = Number(m[3])
      kwText = m[4]
    }
    const kws = parseKeywords(kwText)
    if (sel && kws)
      return (c, me, side, ev) => {
        for (const t of sel(c, me, side, ev)) {
          c.buff(t, atk, hp)
          for (const k of kws) setKeyword(t, k, true)
        }
      }
  }
  if ((m = /^give (.+?) ((?:(?:divine shield|reborn|taunt|venomous|windfury)(?:,? and |, )?)+)$/i.exec(s))) {
    const sel = parseSelector(m[1])
    const kws = parseKeywords(m[2])
    if (!sel || !kws) return undefined
    return (c, me, side, ev) => {
      for (const t of sel(c, me, side, ev)) for (const k of kws) setKeyword(t, k, true)
    }
  }

  // Give <who> stats equal to (twice) your Tier | Gain stats equal to (double) your Tier
  if ((m = /^(?:give (.+?)|gain) stats equal to (?:(double|twice) )?your tier$/i.exec(s))) {
    const sel = parseSelector(m[1] ?? 'this')
    if (!sel) return undefined
    const k = m[2] ? 2 : 1
    return (c, me, side, ev) => {
      for (const t of sel(c, me, side, ev)) c.buff(t, side.heroTier * k, side.heroTier * k)
    }
  }
  // Give this minion's maximum stats to <who>
  if ((m = /^give this minion's maximum stats to (.+)$/i.exec(s))) {
    const sel = parseSelector(m[1])
    if (!sel) return undefined
    return (c, me, side, ev) => {
      for (const t of sel(c, me, side, ev)) c.buff(t, me.atk, me.maxHp)
    }
  }
  // Give a friendly minion of each type +A/+H: one minion per type, a different one each time.
  if ((m = /^give a friendly minion of each type \+(\d+)\/\+(\d+)$/i.exec(s))) {
    const atk = Number(m[1])
    const hp = Number(m[2])
    return (c, _me, side) => {
      for (const t of oneOfEachType(c, c.alive(side))) c.buff(t, atk, hp)
    }
  }
  // Give <who> the stats of all the minions in your hand
  if ((m = /^give (.+?) the stats of all the minions in your hand$/i.exec(s))) {
    const sel = parseSelector(m[1])
    if (!sel) return undefined
    return (c, me, side, ev) => {
      const atk = side.hand.reduce((n, h) => n + h.atk, 0)
      const hp = side.hand.reduce((n, h) => n + h.hp, 0)
      for (const t of sel(c, me, side, ev)) c.buff(t, atk, hp)
    }
  }
  // Gain the stats of adjacent minions
  if ((m = /^gain (?:(double|twice) )?the stats of adjacent minions$/i.exec(s))) {
    const k = m[1] ? 2 : 1
    return (c, me, side) => {
      const i = side.minions.indexOf(me)
      for (const n of [side.minions[i - 1], side.minions[i + 1]]) if (n && !c.isDead(n)) c.buff(me, n.atk * k, n.hp * k)
    }
  }
  // Gain the stats of N friendly minions of different types (except ...)
  if ((m = /^gain (?:(double|twice) )?the stats of (\d+|two|three) friendly minions of different types(?: \(except (.+)\))?$/i.exec(s))) {
    const k = m[1] ? 2 : 1
    const n = num(m[2])
    const except = m[3]
    return (c, me, side) => {
      const pool = c.alive(side).filter((x) => x !== me && x.name !== except && x.tribes.length)
      for (const t of oneOfEachType(c, pool).slice(0, n)) c.buff(me, t.atk * k, t.hp * k)
    }
  }
  // Double / triple this minion's stats | its stats
  if ((m = /^(double|triple) (this minion's|its) stats$/i.exec(s))) {
    const k = m[1].toLowerCase() === 'double' ? 2 : 3
    const other = m[2].toLowerCase() === 'its'
    return (c, me, _side, ev) => {
      const t = other ? ev.other : me
      if (t) c.buff(t, t.atk * (k - 1), t.hp * (k - 1))
    }
  }
  // Deal (double) this minion's Attack to the highest-Health enemy minion
  if ((m = /^deal (double )?this minion's attack to the highest-health enemy minion$/i.exec(s))) {
    const k = m[1] ? 2 : 1
    return (c, me, side) => {
      const top = c.alive(c.other(side)).sort((a, b) => b.hp - a.hp)[0]
      if (top) c.damage(top, me.atk * k, me)
    }
  }
  // Trigger an adjacent minion's Deathrattle (except ...)
  if ((m = /^trigger an adjacent minion's deathrattle(?: \(except (.+)\))?$/i.exec(s))) {
    const except = m[1]
    return (c, me, side, ev) => {
      // When dying, `pos` is where this was: its neighbours are now at pos-1 and pos.
      const i = side.minions.indexOf(me)
      const at = i >= 0 ? [i - 1, i + 1] : [(ev.pos ?? 0) - 1, ev.pos ?? 0]
      const pick = c.pick(at.map((j) => side.minions[j]).filter((x): x is Minion => !!x && !c.isDead(x) && c.hasDeathrattle(x) && x.name !== except))
      if (pick) c.triggerDeathrattle(pick, side, side.minions.indexOf(pick) + 1)
    }
  }
  if (/^trigger adjacent minions' deathrattles$/i.test(s)) {
    return (c, me, side, ev) => {
      const i = side.minions.indexOf(me)
      const at = i >= 0 ? [i - 1, i + 1] : [(ev.pos ?? 0) - 1, ev.pos ?? 0]
      for (const t of at.map((j) => side.minions[j])) if (t && !c.isDead(t) && c.hasDeathrattle(t)) c.triggerDeathrattle(t, side, side.minions.indexOf(t) + 1)
    }
  }
  if (/^trigger all friendly deathrattles$/i.test(s)) {
    return (c, me, side) => {
      for (const t of c.alive(side)) if (t !== me && c.hasDeathrattle(t)) c.triggerDeathrattle(t, side, side.minions.indexOf(t) + 1)
    }
  }
  // Copy your two left-most Deathrattles | Copy all friendly Rallies (except other ...s)
  if ((m = /^copy (?:your (two|\d+) left-most deathrattles|all friendly rallies)(?: \(except (?:other )?(.+?)s?\))?$/i.exec(s))) {
    const n = m[1] ? num(m[1]) : undefined
    const except = m[2]
    return (c, me, side) => {
      const others = c.alive(side).filter((x) => x !== me && !(except && x.name.startsWith(except)))
      if (n !== undefined) {
        for (const t of others.filter((x) => x.fx.deathrattle?.length).slice(0, n)) (me.grantedDeathrattles ??= []).push(t.fx.deathrattle!)
      } else {
        for (const t of others) if (t.fx.rally?.length) (me.grantedRallies ??= []).push(t.fx.rally)
      }
    }
  }
  // Give <who> +A/+H and this Deathrattle
  if ((m = /^give (.+?) \+(\d+)\/\+(\d+) and this deathrattle$/i.exec(s))) {
    const sel = parseSelector(m[1])
    if (!sel) return undefined
    const atk = Number(m[2])
    const hp = Number(m[3])
    return (c, me, side, ev) => {
      for (const t of sel(c, me, side, ev)) {
        c.buff(t, atk, hp)
        if (me.fx.deathrattle) (t.grantedDeathrattles ??= []).push(me.fx.deathrattle)
      }
    }
  }
  // Give a random minion in your hand +A/+H and summon it for this combat only
  if ((m = /^give a random minion in your hand \+(\d+)\/\+(\d+) and summon it for this combat only$/i.exec(s))) {
    const atk = Number(m[1])
    const hp = Number(m[2])
    return (c, me, side, ev) => {
      const pick = c.pick(side.hand)
      if (!pick) return
      c.buff(pick, atk, hp)
      c.summon(side, c.minionCopy(pick), ev.pos ?? side.minions.indexOf(me) + 1)
    }
  }
  // Summon the (N) highest-Health minion(s) from your hand (and give it/them Divine Shield) (for this combat only)
  if ((m = /^summon the (?:(\d+|two) )?highest-health minions? from your hand(?: and give (?:it|them) divine shield)?(?: for this combat(?: only)?)?$/i.exec(s))) {
    const n = m[1] ? num(m[1]) : 1
    const shield = /divine shield/i.test(s)
    return (c, me, side, ev) => {
      const best = [...side.hand].sort((a, b) => b.hp - a.hp).slice(0, n)
      let pos = ev.pos ?? side.minions.indexOf(me) + 1
      for (const h of best) {
        const placed = c.summon(side, c.minionCopy(h), pos++)
        if (placed && shield) placed.divineShield = true
      }
    }
  }
  // Summon N <token>s with this minion's maximum stats
  if ((m = /^summon (a|an|one|two|three|\d+) (.+?) with this minion's maximum stats$/i.exec(s))) {
    const count = num(m[1])
    const name = m[2].replace(/s$/, '')
    const card = cards.bgMinionsNamed(name).find((x) => !x.normalId)
    return (c, me, side, ev) => {
      for (let i = 0; i < count; i++) c.summon(side, c.makeMinion({ card, name, atk: me.atk, hp: me.maxHp }), (ev.pos ?? side.minions.indexOf(me) + 1) + i)
    }
  }
  // Summon and get N random <Tribe>s: the copy you get goes to hand, the summoned one fights.
  if ((m = /^summon and get (a|an|one|two|three|four|\d+) random (\w+?)s?$/i.exec(s))) {
    const count = num(m[1])
    const tribe = tribeOf(m[2])
    const pool = tribe ? cards.pool().filter((x) => x.races?.includes(tribe) || x.races?.includes('ALL')) : []
    if (!pool.length) return undefined
    return (c, me, side, ev) => {
      for (let i = 0; i < count; i++) {
        const card = c.pick(pool)
        if (card) c.summon(side, c.makeMinion({ card }), (ev.pos ?? side.minions.indexOf(me) + 1) + i)
      }
    }
  }
  // If you control N Golden minions, <action>
  if ((m = /^if you control (\d+) golden minions, (.+)$/i.exec(s))) {
    const n = Number(m[1])
    const inner = parseActionOnce(m[2], cards, self)
    if (!inner || inner === 'ignore') return inner
    return (c, me, side, ev) => {
      if (c.alive(side).filter((x) => x.golden).length >= n) inner(c, me, side, ev)
    }
  }

  // Gain +A/+H | Gain +A Attack | Gain Keyword [and +A/+H]
  if ((m = /^gain \+(\d+)\/\+(\d+)(?: and (.+))?$/i.exec(s))) {
    const atk = Number(m[1])
    const hp = Number(m[2])
    const kws = parseKeywords(m[3])
    if (!kws) return undefined
    return (c, me) => {
      c.buff(me, atk, hp)
      for (const k of kws) setKeyword(me, k, true)
    }
  }
  if ((m = /^gain \+(\d+) attack$/i.exec(s))) {
    const atk = Number(m[1])
    return (c, me) => c.buff(me, atk, 0)
  }
  if ((m = /^gain (divine shield|taunt|reborn|venomous|windfury)(?: and \+(\d+)\/\+(\d+))?$/i.exec(s))) {
    const kw = m[1]
    const atk = Number(m[2] ?? 0)
    const hp = Number(m[3] ?? 0)
    return (c, me) => {
      setKeyword(me, kw, true)
      if (kw.toLowerCase() === 'divine shield' && me.fx.tauntWhileShielded) me.taunt = true
      c.buff(me, atk, hp)
    }
  }
  if ((m = /^gain (double )?the target's attack$/i.exec(s))) {
    const k = m[1] ? 2 : 1
    return (c, me, _side, ev) => ev.target && c.buff(me, ev.target.atk * k, 0)
  }

  // Deal N damage to ...
  if ((m = /^deal (\d+) damage to (.+)$/i.exec(s))) {
    const n = Number(m[1])
    const who = m[2].toLowerCase()
    if (who === 'all other minions' || who === 'all minions')
      return (c, me) => {
        for (const sd of c.sides) for (const t of c.alive(sd)) if (who === 'all minions' || t !== me) c.damage(t, n, me)
      }
    if (who === 'all enemy minions') return (c, me, side) => c.alive(c.other(side)).forEach((t) => c.damage(t, n, me))
    const r = /^(a|an|one|two|three|four|five|six|seven|\d+) random enemy minions?$/.exec(who)
    if (r) return (c, me, side) => c.pickN(c.alive(c.other(side)), num(r[1])).forEach((t) => c.damage(t, n, me))
    if (who === 'the target') return (c, me, _side, ev) => ev.target && c.damage(ev.target, n, me)
    const pickEnemy = enemyTarget(who)
    if (pickEnemy)
      return (c, me, side) => {
        const t = pickEnemy(c, c.alive(c.other(side)))
        if (t) c.damage(t, n, me)
      }
    return undefined
  }

  // Blood Gems: +1/+1 each (ignores game-long Blood Gem upgrades we can't see).
  if ((m = /^(?:this )?plays? (a|\d+) (?:permanent )?blood gems? on (itself|it|all your other minions|all your (?!other)(\w+)|a different friendly minion)$/i.exec(s))) {
    const n = num(m[1])
    const who = m[2].toLowerCase()
    const tribe = m[3] ? tribeOf(m[3]) : undefined
    if (m[3] && !tribe) return undefined
    return (c, me, side, ev) => {
      const targets =
        who === 'itself'
          ? [me]
          : who === 'it'
            ? ev.other
              ? [ev.other]
              : []
            : who === 'all your other minions'
              ? c.alive(side).filter((x) => x !== me)
              : tribe
                ? c.alive(side).filter((x) => hasTribe(x, tribe))
                : [c.pick(c.alive(side).filter((x) => x !== me))].filter((x): x is Minion => !!x)
      for (const t of targets) c.buff(t, n * side.bloodGem.atk, n * side.bloodGem.hp)
    }
  }

  // Your Beasts have +7/+7 (this game / until next turn) | Your Beetles have +5/+5 this game | Your Undead have +2 Attack
  if ((m = /^your (\w+?) have \+(\d+)(?:\/\+(\d+)| attack)(?:,? (?:this game|until next turn|wherever they are|this combat).*)?$/i.exec(s))) {
    const word = m[1]
    const atk = Number(m[2])
    const hp = Number(m[3] ?? 0)
    const tribe = tribeOf(word)
    const name = tribe ? undefined : cards.bgMinionsNamed(word.replace(/s$/, ''))[0]?.name
    if (!tribe && !name) return undefined
    return (c, _me, side) => {
      if (tribe) {
        const b = side.tribeBonus.get(tribe) ?? { atk: 0, hp: 0 }
        side.tribeBonus.set(tribe, { atk: b.atk + atk, hp: b.hp + hp })
        for (const t of c.alive(side)) if (hasTribe(t, tribe)) c.buff(t, atk, hp)
      } else if (name) {
        const b = side.nameBonus.get(name) ?? { atk: 0, hp: 0 }
        side.nameBonus.set(name, { atk: b.atk + atk, hp: b.hp + hp })
        for (const t of c.alive(side)) if (t.name === name) c.buff(t, atk, hp)
      }
    }
  }

  // Double <who>'s Attack ("Double your left-most minion's Attack")
  if ((m = /^double (.+?)'s? attack$/i.exec(s))) {
    const sel = parseSelector(m[1])
    if (sel)
      return (c, me, side, ev) => {
        for (const t of sel(c, me, side, ev)) c.buff(t, t.atk, 0)
      }
  }
  // Give <who> "Deathrattle: ..." — a Deathrattle written out in quotes.
  if ((m = /^give (.+?) "deathrattle: (.+?)\.?"$/i.exec(s))) {
    const sel = parseSelector(m[1])
    const problems: string[] = []
    const dr = parseBody(m[2] + '.', cards, self, problems)
    if (sel && !problems.length)
      return (c, me, side, ev) => {
        for (const t of sel(c, me, side, ev)) (t.grantedDeathrattles ??= []).push(dr)
      }
  }
  // Give <who> this minion's stats
  if ((m = /^give (.+?) this minion's stats$/i.exec(s))) {
    const sel = parseSelector(m[1])
    if (sel)
      return (c, me, side, ev) => {
        for (const t of sel(c, me, side, ev)) c.buff(t, me.atk, me.maxHp)
      }
  }
  // Summon and get a minion of your Tier
  if (/^summon and get a minion of your tier$/i.test(s)) {
    return (c, me, side, ev) => {
      const card = c.pick(c.cards.pool().filter((x) => !x.normalId && x.type === 'MINION' && x.techLevel === side.heroTier))
      if (card) c.summon(side, c.makeMinion({ card }), ev.pos ?? side.minions.indexOf(me) + 1)
    }
  }

  // Your Blood Gems give an extra +A Attack / +A/+H (this game)
  if ((m = /^your blood gems give an extra \+(\d+)(?:\/\+(\d+)| (attack|health))(?: this game)?$/i.exec(s))) {
    const health = m[3]?.toLowerCase() === 'health'
    const atk = health ? 0 : Number(m[1])
    const hp = health ? Number(m[1]) : Number(m[2] ?? 0)
    return (_c, _me, side) => {
      side.bloodGem.atk += atk
      side.bloodGem.hp += hp
    }
  }

  if ((m = /^remove (.+) from the target$/i.exec(s))) {
    const kws = parseKeywords(m[1])
    if (!kws) return undefined
    return (_c, _me, _side, ev) => {
      if (ev.target) for (const k of kws) setKeyword(ev.target, k, false)
    }
  }
  if (/^attack immediately$/i.test(s)) return (_c, me) => void (me.attackImmediately = true)

  // Cast <Tavern spell> [on the minion to the right] [twice | N times]
  if ((m = /^cast (.+?)(?: on (.+?))?(?: (\d+) times)?$/i.exec(s))) {
    const spell = castSpell(m[1], cards)
    if (!spell) return undefined
    const times = m[3] ? Number(m[3]) : 1
    return (c, me, side, ev) => {
      for (let i = 0; i < times; i++) spell(c, me, side, ev)
    }
  }
  if ((m = /^(double|triple) its attack$/i.exec(s))) {
    const k = m[1].toLowerCase() === 'double' ? 2 : 3
    return (_c, _me, _side, ev) => ev.other && (ev.other.atk *= k)
  }

  void self
  return undefined
}

// ---------------------------------------------------------------- tavern spells cast in combat

/** Spells whose text doesn't fit the normal templates. */
const SPELL_MANUAL: Record<string, Effect | 'ignore'> = {
  // Give your minions +3/+2. Repeat for your Dragons. Repeat for your minions with Divine Shield.
  'mighty dragonbreath': (c, _me, side) => {
    for (const t of c.alive(side)) {
      let n = 1
      if (hasTribe(t, 'DRAGON')) n++
      if (t.divineShield) n++
      c.buff(t, 3 * n, 2 * n)
    }
  },
  // Choose a minion. Get a different minion of the same type. (Goes to hand: no effect on the fight.)
  "chef's choice": 'ignore',
}

function castSpell(name: string, cards: CardSource): Effect | undefined {
  const key = name.trim().toLowerCase()
  const manual = SPELL_MANUAL[key]
  if (manual === 'ignore') return () => {}
  if (manual) return manual
  const spell = cards.bgSpellNamed(name)
  if (!spell) return undefined
  const problems: string[] = []
  const effects = parseBody(cleanText(spell.text), cards, spell, problems)
  if (problems.length) return undefined
  return (c, me, side, ev) => effects.forEach((e) => e(c, me, side, ev))
}

function parseBody(body: string, cards: CardSource, self: CardInfo | undefined, problems: string[]): Effect[] {
  const effects: Effect[] = []
  const sentences = body
    .replace(/\([^)]*\)/g, '')
    .split(/(?<=\.)\s+/)
    .map((x) => x.trim().replace(/\.$/, ''))
    .filter(Boolean)
  for (const sentence of sentences) {
    const r = parseAction(sentence, cards, self)
    if (r === 'ignore') continue
    if (!r) problems.push(sentence)
    else effects.push(r)
  }
  return effects
}

// ---------------------------------------------------------------- compile

const HEADER_RE = /((?:Battlecry, |Battlecry and )?(?:Deathrattle, and Rally|Deathrattle|Start of Combat|Rally)|Battlecry|(?:Deathrattle and )?Avenge \((\d+)\)|Activate \(\d+\)|Spellcraft)\s*:|(Choose One) -/g

/** Wrap effects so they run at most `limit` times per minion per combat ("Rally: ... (2 times per combat.)"). */
function limited(effects: Effect[], limit: number | undefined): Effect[] {
  if (limit === undefined || !effects.length) return effects
  const key = {}
  return [
    (c, me, side, ev) => {
      const used = me.uses?.get(key) ?? 0
      if (used >= limit) return
      ;(me.uses ??= new Map()).set(key, used + 1)
      for (const e of effects) e(c, me, side, ev)
    },
  ]
}

/** "(Twice per combat.)" style limits, anywhere in the card text. */
function perCombatLimit(text: string): number | undefined {
  const m = /\((once|twice|(\d+) times) per combat\.?\)/i.exec(text)
  if (!m) return undefined
  return m[1].toLowerCase() === 'once' ? 1 : m[1].toLowerCase() === 'twice' ? 2 : Number(m[2])
}

/** Subject phrases for friendly triggers: "a friendly Beast", "another friendly Taunt minion", "a friendly Deathrattle minion"... */
function parseSubject(phrase: string): Pick<Trigger, 'tribe' | 'needTaunt' | 'needDeathrattle' | 'excludeSelf'> | undefined {
  const m = /^(a|another|a different) friendly (taunt minion|deathrattle minion|minion with taunt|minion|\w+)$/i.exec(phrase.trim())
  if (!m) return undefined
  const what = m[2].toLowerCase()
  const out: Pick<Trigger, 'tribe' | 'needTaunt' | 'needDeathrattle' | 'excludeSelf'> = { excludeSelf: m[1].toLowerCase() !== 'a' }
  if (what === 'taunt minion' || what === 'minion with taunt') out.needTaunt = true
  else if (what === 'deathrattle minion') out.needDeathrattle = true
  else if (what !== 'minion') {
    const tribe = tribeOf(what)
    if (!tribe) return undefined
    out.tribe = tribe
  }
  return out
}

/** Generic trigger sentences: "<when> <subject> <event>, <actions>". */
function parseGenericTrigger(t: string, cards: CardSource, self: CardInfo | undefined, fx: CardFx, problems: string[], limit: number | undefined): boolean {
  let m: RegExpExecArray | null
  let trig: Omit<Trigger, 'effects'> | undefined
  let body = ''
  if ((m = /^(?:Whenever|After) this(?: minion)? (?:is attacked|takes damage), (.+)$/i.exec(t))) {
    trig = { on: /attacked/i.test(t.slice(0, 40)) ? 'attacked' : 'damaged', selfOnly: true }
    body = m[1]
  } else if ((m = /^(?:Whenever|After) (.+?) (dies|is attacked|takes damage|kills an enemy|kills a minion)(?: in combat)?, (.+)$/i.exec(t))) {
    const subject = parseSubject(m[1])
    if (!subject) return false
    const ev = m[2].toLowerCase()
    trig = { ...subject, on: ev === 'dies' ? 'dies' : ev === 'is attacked' ? 'attacked' : ev === 'takes damage' ? 'damaged' : 'kill' }
    body = m[3]
  }
  if (!trig) return false
  const effects = parseBody(body + '.', cards, self, problems)
  ;(fx.triggers ??= []).push({ ...trig, limit, effects })
  return true
}

/** Combat-relevant trigger sentences that aren't introduced by a "Keyword:" header. */
function parseTriggerSentence(s: string, cards: CardSource, self: CardInfo | undefined, fx: CardFx, problems: string[], limit?: number): boolean {
  let m: RegExpExecArray | null
  const t = s.trim().replace(/\.$/, '')
  if (/^(Once|Twice|\d+ times) per combat\.?$/i.test(t.replace(/[()]/g, ''))) return true
  if (/^Immune while attacking$/i.test(t)) {
    fx.immuneWhileAttacking = true
    return true
  }
  if (/^Also damages (adjacent minions|the (minions|enemies) next to whomever this attacks)$/i.test(t)) {
    fx.cleave = true
    return true
  }
  // Auras: the stats they give are already in the log, so nothing to simulate.
  if (/^Your other \w+ have (\+\d+ Attack|extra Attack equal to your Tier)$/i.test(t)) return true
  if ((m = /^Your Deathrattles trigger (an|\d+) extra times?$/i.exec(t))) {
    fx.extraDeathrattles = num(m[1])
    return true
  }
  if (/^Has Taunt while this has Divine Shield$/i.test(t)) {
    fx.tauntWhileShielded = true
    return true
  }
  if (/^Also damages the enemies next to whomever this attacks$/i.test(t)) {
    fx.cleave = true
    return true
  }
  if ((m = /^(?:Whenever|After) (another|a) friendly (\w+?) attacks, (.+)$/i.exec(t))) {
    const tribe = m[2].toLowerCase() === 'minion' ? undefined : tribeOf(m[2])
    const rallyOnly = /^rally minion$/i.test(m[2])
    const effects = parseBody(m[3] + '.', cards, self, problems)
    ;(fx.friendlyAttack ??= []).push({ tribe, excludeSelf: m[1].toLowerCase() === 'another', rallyOnly, effects })
    return true
  }
  if ((m = /^After (another|a) friendly (\w+?) deals damage, (.+)$/i.exec(t))) {
    const tribe = m[2].toLowerCase() === 'minion' ? undefined : tribeOf(m[2])
    const effects = parseBody(m[3] + '.', cards, self, problems)
    ;(fx.onFriendlyDamage ??= []).push({ tribe, excludeSelf: m[1].toLowerCase() === 'another', effects })
    return true
  }
  if ((m = /^Whenever a friendly minion gains Attack, (.+)$/i.exec(t))) {
    ;(fx.onGainStats ??= []).push({ needAtk: true, effects: parseBody(m[1] + '.', cards, self, problems) })
    return true
  }
  if ((m = /^After this gains stats, also give (twice )?the stats to the (left-most|two left-most) minions? in your hand$/i.exec(t))) {
    const k = m[1] ? 2 : 1
    const n = m[2].toLowerCase() === 'left-most' ? 1 : 2
    ;(fx.onGainStats ??= []).push({
      selfOnly: true,
      effects: [(c, _me, side, ev) => side.hand.slice(0, n).forEach((h) => c.buff(h, (ev.atk ?? 0) * k, (ev.hp ?? 0) * k))],
    })
    return true
  }
  if ((m = /^After you trigger a Deathrattle, (.+)$/i.exec(t))) {
    ;(fx.afterDeathrattle ??= []).push(...parseBody(m[1] + '.', cards, self, problems))
    return true
  }
  if ((m = /^After a friendly minion loses Divine Shield, (.+)$/i.exec(t))) {
    ;(fx.onShieldLost ??= []).push(...parseBody(m[1] + '.', cards, self, problems))
    return true
  }
  if ((m = /^Whenever this kills a minion, (.+)$/i.exec(t))) {
    ;(fx.onKill ??= []).push(...parseBody(m[1] + '.', cards, self, problems))
    return true
  }
  if ((m = /^After a friendly minion is Reborn, (.+)$/i.exec(t))) {
    fx.onFriendlyReborn = parseBody(m[1] + '.', cards, self, problems)
    return true
  }
  if (parseGenericTrigger(t, cards, self, fx, problems, limit)) return true
  if ((m = /^(?:After|Whenever) you summon an? (\w+)(?: in combat)?, (.+)$/i.exec(t))) {
    const tribe = tribeOf(m[1])
    const inner = parseBody(m[2].replace(/ and improve this permanently$/i, '') + '.', cards, self, problems)
    fx.onSummon = [(c, me, side, ev) => ev.other && (!tribe || hasTribe(ev.other, tribe)) && inner.forEach((e) => e(c, me, side, ev))]
    return true
  }
  return false
}

/** Sentences that only matter outside combat (shop phase, hand, gold...). */
const SHOP_TRIGGER = new RegExp(
  '^(' +
    [
      'At the (end|start) of your turn',
      '(Whenever|After|When) you (play|cast|sell|buy|spend|discard|Magnetize|gain|refresh)',
      'After your (hero takes|team)',
      'Whenever a card is added',
      'After this is (Passed|sold|bought)',
      'This minion (is always|can triple)',
      'Once this (reaches|deals)',
      '(This|Adjacent \\w+) permanently keeps?',
      'The first time this',
      'If you lost',
      'Your Tavern spells',
      'Your left-most Beast attacks it',
      'Whenever this (kills a minion|takes damage), give a minion in your hand',
      'This has all minion types', // already in the card's races
      "This (minion )?(sells|costs|can't gain)",
      '(One|Two|Four|The first|The next) .* each turn',
      'While this is in your hand',
      'If you have any unspent Gold',
      'Once you buy',
      'Upgrading the Tavern',
      'Minions in the Tavern',
      'The Tavern offers',
      'Your Refreshes',
      'If this is Golden when you sell',
      'After the first time this is sold',
      'After you (call upon|use your Hero Power|trigger a Battlecry|summon a minion of your Tier|kill a second minion)',
      'After (a|the) (Blood Gem|Tavern)',
      'Whenever a (Blood Gem|Dragon enters)',
      'Whenever your hero takes damage',
      'Your other \\w+ have', // auras: the log already shows the buffed stats
      '.*, get (a|an|\\d+|two|three) ', // "..., get a Triple Reward": goes to hand
      'Whenever a minion is consumed', // consuming happens in the shop
      'All your \\w+ keep', // what carries over after combat
      'In \\w+ turns',
      'Your \\w+ give an extra', // tavern buffs
      'Improves after', // the improved stats are already in the log; see approximated
    ].join('|') +
    ')',
  'i',
)

/** Text that can only matter outside combat, wherever it appears in a sentence. */
const SHOP_WORDS = /\b(Tavern|Refresh(es|ed)?|Gold|sells?|sold|buy|bought|Pass(es|ed)?|Discover|Spellcraft|Hero Power|each turn|per turn|next turn|your turn|until next turn|Battlecries|end of turn effects|Blood Gems played from your hand|Bounties|discarded)\b/i

export function compileFx(card: CardInfo | undefined, cards: CardSource): CardFx {
  const fx: CardFx = { unsupported: [] }
  if (!card) return fx
  const base = card.normalId ?? card.id
  const manual: Manual | undefined = MANUAL[base]
  if (manual) {
    manual(fx, card, cards)
    return fx
  }
  const text = cleanText(card.text)
  if (!text) return fx

  // Split into "Header: body" sections; anything before the first header is keyword/trigger text.
  const sections: { header: string; avenge?: number; body: string }[] = []
  const heads = [...text.matchAll(HEADER_RE)]
  const leading = heads.length ? text.slice(0, heads[0].index) : text
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length
    sections.push({ header: h[1] ?? h[3], avenge: h[2] ? Number(h[2]) : undefined, body: text.slice(h.index! + h[0].length, end).trim() })
  }

  const problems: string[] = []
  // Leading text: keyword list ("Taunt Reborn") and/or trigger sentences.
  const KEYWORDS = /^((Taunt|Reborn|Divine Shield|Windfury|Venomous|Poisonous|Stealth|Magnetic|Mega-Windfury|Cleave)[,.]?(\s+|$))+/i
  let inShopText = false
  // Parenthesised notes are counters and reminders ("(3 left!)", "(Improves each turn!)"); limits are read separately.
  for (const raw of leading.replace(/\([^)]*\)/g, ' ').split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean)) {
    const sentence = raw.replace(KEYWORDS, '').trim()
    if (!sentence) continue
    if (parseTriggerSentence(sentence, cards, card, fx, problems, perCombatLimit(text))) {
      inShopText = false
      continue
    }
    if (SHOP_TRIGGER.test(sentence) || SHOP_WORDS.test(sentence) || /Can Magnetize|Has \+\d|^This has a different/.test(sentence)) {
      inShopText = true
      continue
    }
    // A sentence we can't read that follows shop-only text continues it ("When you sell this, ... Improve your future Ballers.").
    if (inShopText) continue
    problems.push(sentence)
  }

  for (const sec of sections) {
    const h = sec.header
    if (/^(Battlecry|Activate|Spellcraft|Choose One)/.test(h) && !/Deathrattle|Start of Combat|Rally/.test(h)) {
      // Shop-only header; but the body may continue with trigger text after the first sentence.
      continue
    }
    // The body may contain a trailing trigger sentence ("... Whenever X attacks, ...").
    const effects = parseBody(sec.body, cards, card, problems)
    if (/Deathrattle/.test(h)) (fx.deathrattle ??= []).push(...effects)
    if (/Start of Combat/.test(h)) (fx.startOfCombat ??= []).push(...effects)
    if (/Rally/.test(h)) (fx.rally ??= []).push(...limited(effects, perCombatLimit(text)))
    if (sec.avenge) fx.avenge = { n: sec.avenge, effects }
  }

  fx.unsupported = problems
  // Best guesses the text forces on us (the user's choice: model them, but say so).
  if (!problems.length) {
    if (/Blood Gem/i.test(text) && /plays? .*Blood Gem|Blood Gems give/i.test(text)) (fx.approximated ??= []).push('Blood Gems count as +1/+1')
    if (/Improves after/i.test(text)) (fx.approximated ??= []).push('uses its printed numbers')
  }
  return fx
}

// ---------------------------------------------------------------- hand-written cards

type Manual = (fx: CardFx, card: CardInfo, cards: CardSource) => void
const g = (card: CardInfo) => (card.normalId ? 2 : 1)

function buffRandomInHand(c: Combat, side: Side, atk: number, hp: number) {
  const pick = c.pick(side.hand)
  if (pick) {
    pick.atk += atk
    pick.hp += hp
    pick.maxHp += hp
  }
}

const MANUAL: Record<string, Manual> = {
  // Leeroy the Reckless – Deathrattle: Destroy the minion that killed this.
  BG23_318: (fx) => {
    fx.deathrattle = [
      (c, me) => {
        if (me.killedBy && !c.isDead(me.killedBy)) me.killedBy.destroyed = true
      },
    ]
  },
  // Wildfire Elemental – excess damage to an adjacent enemy.
  BGS_126: (fx) => {
    fx.overkillAdjacent = true
  },
  // De-volition-ist – After this attacks, deal damage equal to its Attack to the highest-Health enemy.
  BG36_102: (fx) => {
    fx.afterAttack = [
      (c, me, side) => {
        const enemies = c.alive(c.other(side))
        const top = enemies.sort((a, b) => b.hp - a.hp)[0]
        if (top) c.damage(top, me.atk, me)
      },
    ]
  },
  // Obsidian Ravager – Rally: deal damage equal to this minion's Attack to the target and an adjacent minion.
  BG27_017: (fx, card) => {
    fx.rally = [
      (c, me, side, ev) => {
        if (!ev.target) return
        const enemy = c.other(side)
        for (let k = 0; k < g(card); k++) {
          const i = enemy.minions.indexOf(ev.target)
          const adj = c.pick([enemy.minions[i - 1], enemy.minions[i + 1]].filter((x): x is Minion => !!x && !c.isDead(x)))
          c.damage(ev.target, me.atk, me)
          if (adj) c.damage(adj, me.atk, me)
        }
      },
    ]
  },
  // Jailbird Juggernaut – Rally: Summon a Golem with this minion's stats to attack the target first.
  BG36_333: (fx, card) => {
    fx.rally = [
      (c, me, side, ev) => {
        for (let k = 0; k < g(card); k++) {
          if (!ev.target || c.isDead(ev.target)) return
          const golem = c.makeMinion({ name: 'Golem', atk: me.atk, hp: me.hp })
          const placed = c.summon(side, golem, side.minions.indexOf(me) + 1)
          if (placed) c.singleAttack(side, placed, ev.target)
        }
      },
    ]
  },
  // Stalwart Kodo – After you summon a different minion in combat, give it double this minion's max stats (3x per combat).
  BG34_322: (fx, card) => {
    fx.onSummon = [
      (c, me, _side, ev) => {
        const used = (me as Minion & { kodo?: number }).kodo ?? 0
        if (!ev.other || used >= 3 * g(card)) return
        ;(me as Minion & { kodo?: number }).kodo = used + 1
        c.buff(ev.other, me.atk * 2, me.hp * 2)
      },
    ]
  },
  // Barrier Banshee – After a friendly minion is Reborn, gain Divine Shield and +8/+8.
  BG36_514: (fx, card) => {
    fx.onFriendlyReborn = [
      (c, me) => {
        me.divineShield = true
        c.buff(me, 8 * g(card), 8 * g(card))
      },
    ]
  },
  // Snazzy Phantom – After a friendly minion is Reborn, give stats equal to its Attack to your right-most Undead.
  BG36_515: (fx, card) => {
    fx.onFriendlyReborn = [
      (c, _me, side, ev) => {
        const undead = c.alive(side).filter((x) => x.tribes.includes('UNDEAD') || x.tribes.includes('ALL'))
        const target = undead[undead.length - 1]
        if (target && ev.other) c.buff(target, ev.other.atk * g(card), ev.other.atk * g(card))
      },
    ]
  },
  // Deathstrider – After a friendly Rally minion attacks, trigger your left-most Deathrattle.
  BG36_208: (fx, card) => {
    fx.friendlyAttack = [
      {
        excludeSelf: false,
        rallyOnly: true,
        effects: [
          (c, me, side) => {
            const dr = c.alive(side).find((x) => x.fx.deathrattle?.length)
            if (!dr) return
            for (let k = 0; k < g(card); k++) c.run(dr.fx.deathrattle, dr, side, { pos: side.minions.indexOf(dr) + 1 })
            void me
          },
        ],
      },
    ]
  },
  // Stitched Salvager – Start of Combat: Destroy the minion to the left. Deathrattle: Summon an exact copy of it.
  BG31_999: (fx) => {
    fx.startOfCombat = [
      (c, me, side) => {
        const i = side.minions.indexOf(me)
        const left = side.minions[i - 1]
        if (!left || c.isDead(left) || left.name === me.name) return
        ;(me as Minion & { eaten?: Minion }).eaten = { ...left }
        left.destroyed = true
      },
    ]
    fx.deathrattle = [
      (c, me, side, ev) => {
        const eaten = (me as Minion & { eaten?: Minion }).eaten
        if (!eaten) return
        const copy = c.makeMinion({ card: c.cards.get(eaten.cardId) })
        Object.assign(copy, { atk: eaten.atk, hp: Math.max(1, eaten.hp), taunt: eaten.taunt, divineShield: eaten.divineShield, reborn: eaten.reborn, venomous: eaten.venomous })
        c.summon(side, copy, ev.pos ?? side.minions.length)
      },
    ]
  },
  // Sewer Lord – Deathrattle: Summon two Sewer Rats (which themselves summon Turtles).
  BG35_604: (fx, _card, cards) => {
    const rat = cards.bgMinionsNamed('Sewer Rat').find((x) => !x.normalId)
    fx.deathrattle = [
      (c, _me, side, ev) => {
        for (let i = 0; i < 2 * (_card.normalId ? 2 : 1); i++) c.summon(side, c.makeMinion({ card: rat, name: 'Sewer Rat', atk: 3, hp: 2, tribes: ['BEAST'] }), (ev.pos ?? side.minions.length) + i)
      },
    ]
  },
  // The Last One Standing – Rally: Give a friendly minion of each type +10/+10 (golden: twice).
  BG34_320: (fx, card) => {
    fx.rally = [
      (c, me, side) => {
        for (let k = 0; k < g(card); k++) {
          const friends = c.alive(side).filter((x) => x !== me)
          const tribes = new Set(friends.flatMap((x) => x.tribes).filter((t) => t !== 'ALL'))
          for (const t of tribes) {
            const pick = c.pick(friends.filter((x) => x.tribes.includes(t) || x.tribes.includes('ALL')))
            if (pick) c.buff(pick, 10, 10)
          }
        }
      },
    ]
  },
  // Deathly Striker – Avenge (4): Get a random Undead (golden: 2). Deathrattle: Summon them for this combat.
  BG31_835: (fx, card, cards) => {
    const undead = cards.pool().filter((x) => x.races?.includes('UNDEAD') && x.id !== card.id && x.id !== card.normalId)
    type Striker = Minion & { stash?: CardInfo[] }
    fx.avenge = {
      n: 4,
      effects: [
        (c, me) => {
          const s = me as Striker
          for (let k = 0; k < g(card); k++) {
            const pick = c.pick(undead)
            if (pick) (s.stash ??= []).push(pick)
          }
        },
      ],
    }
    fx.deathrattle = [
      (c, me, side, ev) => {
        const stash = (me as Striker).stash ?? []
        stash.forEach((u, i) => c.summon(side, c.makeMinion({ card: u }), (ev.pos ?? side.minions.length) + i))
        ;(me as Striker).stash = []
      },
    ]
  },
  // Flighty Scout – Start of Combat: If this minion is in your hand, summon a copy of it (golden: with double stats).
  BG32_330: (fx, card) => {
    fx.startOfCombatFromHand = [
      (c, me, side) => {
        const copy = c.makeMinion({ card: c.cards.get(me.cardId), atk: me.atk * g(card), hp: me.hp * g(card) })
        c.summon(side, copy, side.minions.length)
      },
    ]
  },
  // Diremuck Forager – Start of Combat: When you have space, summon the highest-Attack Murloc(s)
  // from your hand for this combat only. "When you have space" means it waits for room mid-fight.
  BG27_556: (fx, card) => {
    fx.summonFromHand = { tribe: 'MURLOC', left: g(card) }
    fx.startOfCombat = [
      (c, _me, side) => {
        side.pendingFromHand.push({ tribe: 'MURLOC', left: g(card) })
        c.fillFromHand(side)
      },
    ]
  },
  // Costume Enthusiast – Start of Combat: Gain the Attack of the highest-Attack minion in your hand (golden: double).
  BG34_142: (fx, card) => {
    fx.startOfCombat = [
      (c, me, side) => {
        const top = Math.max(0, ...side.hand.map((x) => x.atk))
        c.buff(me, top * g(card), 0)
      },
    ]
  },
  // Choral Mrrrglr – Start of Combat: Gain the stats of all the minions in your hand (golden: twice).
  BG26_354: (fx, card) => {
    fx.startOfCombat = [
      (c, me, side) => {
        const atk = side.hand.reduce((n, x) => n + x.atk, 0)
        const hp = side.hand.reduce((n, x) => n + x.hp, 0)
        c.buff(me, atk * g(card), hp * g(card))
      },
    ]
  },
  // Sandy – Start of Combat: Transform into a copy of your teammate's highest-Health minion (golden: a golden copy).
  BGDUO_125: (fx, card) => {
    fx.startOfCombat = [
      (c, me, side) => {
        const best = [...side.teammate].sort((a, b) => b.health - a.health)[0]
        if (!best) return
        const copy = c.minionFrom(best)
        const k = card.normalId && !best.golden ? 2 : 1
        Object.assign(me, { ...copy, uid: me.uid, atk: copy.atk * k, hp: copy.hp * k })
      },
    ]
  },
  // Cards that feed stats to minions in hand mid-fight. These matter in combat
  // because Diremuck Forager can pull that minion out of hand later in the fight.
  // Murcules – Whenever this kills a minion, give a minion in your hand +3/+3.
  BG27_023: (fx, card) => {
    fx.onKill = [(c, _me, side) => buffRandomInHand(c, side, 3 * g(card), 3 * g(card))]
  },
  // Very Hungry Winterfinner – Taunt. Whenever this takes damage, give a minion in your hand +2/+1.
  BG29_300: (fx, card) => {
    fx.onDamaged = [(c, _me, side) => buffRandomInHand(c, side, 2 * g(card), 1 * g(card))]
  },
  // Tide Oracle Morgl – Poisonous. When this attacks and kills a minion, give its maximum stats to a minion in your hand.
  BG27_513: (fx, card) => {
    fx.onKill = [(c, _me, side, ev) => ev.attacking && ev.target && buffRandomInHand(c, side, ev.target.atk * g(card), ev.target.maxHp * g(card))]
  },
  // Immortal – Start of Combat: Gain the stats of adjacent minions (golden: double).
  BG31_HERO_802pt4: (fx, card) => {
    fx.startOfCombat = [
      (c, me, side) => {
        const i = side.minions.indexOf(me)
        for (const n of [side.minions[i - 1], side.minions[i + 1]]) if (n && !c.isDead(n)) c.buff(me, n.atk * g(card), n.hp * g(card))
      },
    ]
  },
  // Devout Hellcaller – After another friendly Demon deals damage, gain +2/+2 (golden: +4/+4).
  BG33_155: (fx, card) => {
    fx.onFriendlyDamage = [{ tribe: 'DEMON', excludeSelf: true, effects: [(c, me) => c.buff(me, 2 * g(card), 2 * g(card))] }]
  },
  // Humming Bird – Start of Combat: your Beasts have +1 Attack for the rest of combat.
  BG26_805: (fx, card) => {
    fx.startOfCombat = [
      (c, _me, side) => {
        const b = side.tribeBonus.get('BEAST') ?? { atk: 0, hp: 0 }
        side.tribeBonus.set('BEAST', { atk: b.atk + g(card), hp: b.hp })
        for (const t of c.alive(side)) if (t.tribes.includes('BEAST') || t.tribes.includes('ALL')) c.buff(t, g(card), 0)
      },
    ]
  },
  // Timewarped Greenskeeper – Rally: Trigger your right-most Battlecry and Deathrattle (golden: twice).
  // Battlecries are shop effects we don't simulate, so only the Deathrattle half is modelled.
  BG34_Giant_041: (fx, card) => {
    fx.rally = [
      (c, me, side) => {
        for (let k = 0; k < g(card); k++) {
          const dr = c.alive(side).filter((x) => c.hasDeathrattle(x)).pop()
          if (dr) c.triggerDeathrattle(dr, side, side.minions.indexOf(dr) + 1)
        }
        void me
      },
    ]
    fx.approximated = ['the Battlecry half isn’t simulated']
  },
  // Timewarped Nellie's Ship – Deathrattle: Summon and get that Pirate (golden: those Pirates).
  // Which Pirate was Discovered isn't logged until it appears: a random one.
  BG34_Giant_074t: (fx, card) => {
    fx.deathrattle = [(c, me, side, ev) => summonRandom(c, me, side, ev, 'PIRATE', g(card))]
    fx.approximated = ['the crew is a random Pirate']
  },
  // Timewarped Festergut – Deathrattle: Summon and get a random Undead Creation (golden: 2).
  // A Creation is stitched from random parts: stood in for by a random Undead.
  BG34_Giant_590: (fx, card) => {
    fx.deathrattle = [(c, me, side, ev) => summonRandom(c, me, side, ev, 'UNDEAD', g(card))]
    fx.approximated = ['the Creation is a random Undead']
  },
  // Timewarped Chameleon – Start of Combat: Transform into a (Golden) copy of the minion to the left of this.
  BG34_Giant_042: (fx, card) => {
    fx.startOfCombat = [
      (c, me, side) => {
        const i = side.minions.indexOf(me)
        const left = side.minions[i - 1]
        if (!left || c.isDead(left)) return
        const copy = c.minionCopy(left)
        if (card.normalId && !left.golden) {
          // A golden copy: the golden card's doubled base stats, with the same enchantments on top.
          const base = c.cards.get(left.cardId)
          copy.atk += base?.attack ?? 0
          copy.hp += base?.health ?? 0
          copy.maxHp += base?.health ?? 0
          copy.golden = true
          const goldenId = base?.goldenId
          if (goldenId) copy.fx = c.fx(goldenId)
        }
        side.minions[i] = copy
      },
    ]
  },
  // Timewarped Bristler – Deathrattle: Give this minion's Blood Gems to 2 different friendly Quilboar (golden: twice).
  // The log doesn't count Blood Gems: its stats above the printed ones stand in for them.
  BG34_Giant_104: (fx, card) => {
    fx.deathrattle = [
      (c, me, side) => {
        const printed = c.cards.get(me.cardId)
        const atk = Math.max(0, me.atk - (printed?.attack ?? me.atk))
        const hp = Math.max(0, me.maxHp - (printed?.health ?? me.maxHp))
        for (let k = 0; k < g(card); k++) for (const t of c.pickN(c.alive(side).filter((x) => hasTribe(x, 'QUILBOAR')), 2)) c.buff(t, atk, hp)
      },
    ]
    fx.approximated = ['Blood Gems counted from its bonus stats']
  },
  // Timewarped Hag – Start of Combat: Give the Undead to the right (golden: adjacent Undead) Reborn and
  // "This is Reborn with full Health and enchantments".
  BG34_Giant_342: (fx, card) => {
    fx.startOfCombat = [
      (c, me, side) => {
        const i = side.minions.indexOf(me)
        const near = card.normalId ? [side.minions[i - 1], side.minions[i + 1]] : [side.minions[i + 1]]
        for (const t of near) {
          if (!t || c.isDead(t) || !hasTribe(t, 'UNDEAD')) continue
          t.reborn = true
          t.rebornFull = true
        }
      },
    ]
  },
  // Timewarped Caretaker – Deathrattle: Summon five (golden: ten) 1/1 Skeletons. Any that don't fit give
  // your Undead +1 Attack this game.
  BG34_Giant_618: (fx, card) => {
    fx.deathrattle = [
      (c, me, side, ev) => {
        const skeleton = c.cards.bgMinionsNamed('Skeleton').find((x) => !x.normalId)
        let pos = ev.pos ?? side.minions.indexOf(me) + 1
        let spare = 0
        for (let k = 0; k < 5 * g(card); k++) {
          if (!c.summon(side, c.makeMinion({ card: skeleton, name: 'Skeleton', atk: 1, hp: 1, tribes: ['UNDEAD'] }), pos++)) spare++
        }
        if (!spare) return
        const b = side.tribeBonus.get('UNDEAD') ?? { atk: 0, hp: 0 }
        side.tribeBonus.set('UNDEAD', { atk: b.atk + spare, hp: b.hp })
        for (const t of c.alive(side)) if (hasTribe(t, 'UNDEAD')) c.buff(t, spare, 0)
      },
    ]
  },
  // Timewarped Magnanimoose – Deathrattle: Summon and get a minion from a random opponent's warband (golden: twice).
  // The sim only knows this fight's opponent: a copy of one of their minions as the fight began.
  BG34_Giant_619: (fx, card) => {
    fx.deathrattle = [
      (c, me, side, ev) => {
        for (let k = 0; k < g(card); k++) {
          const pick = c.pick(c.startingBoard(c.other(side)))
          if (pick) c.summon(side, c.minionFrom(pick), (ev.pos ?? side.minions.indexOf(me) + 1) + k)
        }
      },
    ]
    fx.approximated = ['uses this opponent’s warband']
  },
}

/** Summon N random pool minions of a tribe where `me` is (or died). */
function summonRandom(c: Combat, me: Minion, side: Side, ev: EffectEvent, tribe: string, count: number) {
  const pool = c.cards.pool().filter((x) => x.races?.includes(tribe) || x.races?.includes('ALL'))
  for (let k = 0; k < count; k++) {
    const card = c.pick(pool)
    if (card) c.summon(side, c.makeMinion({ card }), (ev.pos ?? side.minions.indexOf(me) + 1) + k)
  }
}

// ---------------------------------------------------------------- hero powers

/** A hero power's combat effect. It acts for the whole side, so there's no minion behind it. */
export type HeroPowerEffect = (c: Combat, side: Side) => void

export interface HeroPowerFx {
  startOfCombat?: HeroPowerEffect
  /**
   * Effects that last all combat ("minions you summon during combat", "Avenge"), as a
   * minion's would. The engine gives them to a stand-in for the hero that never fights.
   */
  passive?: CardFx
  /** "(Unlocks on Turn 7.)": inactive before that turn. */
  unlockTurn?: number
  /** Combat text we don't model yet (empty = fully modelled, or no combat effect). */
  unsupported: string[]
  /** Modelled on a best guess (e.g. a choice the player made that the log doesn't carry). */
  approximated?: string[]
}

/**
 * Hero powers that act in combat. Keyed by name rather than id, so skins and
 * alternate versions share a handler.
 *
 * Only matters where Start of Combat hasn't already happened by the time the
 * boards are captured, which on the live path means a Duos reserve: its board
 * is copied before the fight, and the hero power fires as it comes in.
 */
const HERO_POWERS: Record<string, (fx: HeroPowerFx) => void> = {
  // "Give +1/+2 and Taunt to minions you summon during combat."
  'Sprout It Out!': (fx) => {
    fx.passive = {
      unsupported: [],
      onSummon: [
        (c, _hero, _side, ev) => {
          if (!ev.other) return
          c.buff(ev.other, 1, 2)
          ev.other.taunt = true
        },
      ],
    }
  },
  // "Avenge (4): Summon a 1/1 Whelp that attacks immediately. Improve this by +1/+1." How far it has
  // improved isn't in the log: the printed 1/1.
  Broodmother: (fx) => {
    fx.passive = {
      unsupported: [],
      approximated: ['uses its printed numbers'],
      avenge: {
        n: 4,
        effects: [
          (c, _hero, side) => {
            const whelp = c.summon(side, c.makeMinion({ name: 'Whelp', atk: 1, hp: 1, tribes: ['DRAGON'] }), side.minions.length)
            if (whelp && c.alive(c.other(side)).length) c.singleAttack(side, whelp)
          },
        ],
      },
    }
  },
  // "When you have space in combat, summon a copy of your highest-Attack / highest-Health minion. (Unlocks on Turn 7.)"
  'Frostwolf Fervor': (fx) => copyWhenSpace(fx, 'atk'),
  'Stormpike Strength': (fx) => copyWhenSpace(fx, 'hp'),
  // Sylvanas – "Take aim! Start of Combat: Deal 99 damage to your target." The target isn't known: a random enemy.
  Deadeye: (fx) => {
    fx.startOfCombat = (c, side) => {
      const t = c.pick(c.alive(c.other(side)))
      if (t) c.damage(t, 99)
    }
    fx.approximated = [CHOSEN.Deadeye]
  },
  // Duos – "Choose a friendly minion. Start of Combat: Transform it into your teammate's highest-Tier minion."
  'Glorious Gloop': (fx) => {
    fx.startOfCombat = (c, side) => {
      const best = [...side.teammate].sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0))[0]
      const alive = c.alive(side)
      const chosen = c.pick(alive)
      if (!best || !chosen) return
      side.minions[side.minions.indexOf(chosen)] = c.minionFrom(best)
    }
    fx.approximated = [CHOSEN['Glorious Gloop']]
  },
  // "Choose a friendly minion. Start of Combat: Destroy it. When you have space, resummon an exact copy."
  'Rapid Reanimation': (fx) => {
    fx.startOfCombat = (c, side) => {
      const chosen = c.pick(c.alive(side))
      if (!chosen) return
      const copy = c.minionCopy(chosen)
      chosen.destroyed = true
      c.resolveDeaths(side)
      c.summon(side, copy, side.minions.length)
    }
    fx.approximated = [CHOSEN['Rapid Reanimation']]
  },
  // Illidan Stormrage – Start of Combat: your left- and right-most minions gain +2/+1 and attack immediately.
  Wingmen: (fx) => {
    fx.startOfCombat = (c, side) => {
      const alive = c.alive(side)
      for (const m of new Set([alive[0], alive[alive.length - 1]])) {
        if (!m) continue
        c.buff(m, 2, 1)
        m.attackImmediately = true
      }
    }
  },
}

/** Hero powers whose effect depends on a choice the player made, which the sim doesn't get. */
const CHOSEN: Record<string, string> = {
  Deadeye: 'the target is random',
  'Glorious Gloop': 'the chosen minion is random',
  'Rapid Reanimation': 'the chosen minion is random',
  'Wax Warband': 'uses its printed numbers', // improves through the game
}

function copyWhenSpace(fx: HeroPowerFx, stat: 'atk' | 'hp') {
  fx.unlockTurn = 7
  fx.passive = {
    unsupported: [],
    whenSpace: [
      (c, _hero, side) => {
        const best = [...c.alive(side)].sort((a, b) => b[stat] - a[stat])[0]
        if (best) c.summon(side, c.minionCopy(best), side.minions.indexOf(best) + 1)
      },
    ],
  }
}

export function compileHeroPower(card: CardInfo | undefined, cards: CardSource): HeroPowerFx {
  const fx: HeroPowerFx = { unsupported: [] }
  if (!card) return fx
  const manual = HERO_POWERS[card.name]
  if (manual) {
    manual(fx)
    return fx
  }
  const text = cleanText(card.text)
  // Murloc King: what it gives lands on minions as enchantments, which the sim isn't told about yet.
  if (/^At the start of next combat/i.test(text)) {
    fx.unsupported.push(text)
    return fx
  }
  const at = text.search(/Start of Combat:/i)
  if (at < 0) return fx
  // "Choose an Element. Start of Combat: Call upon that Element." does nothing until chosen,
  // and choosing swaps in one of the Invocations, which have their own text.
  if (/^Choose an Element/i.test(text)) return fx
  const body = text.slice(at + 'Start of Combat:'.length).replace(/\([^)]*\)/g, '').trim()
  const problems: string[] = []
  const effects = parseBody(body, cards, card, problems)
  if (problems.length) {
    fx.unsupported.push(...problems)
    return fx
  }
  // A hero power has no minion behind it: effects act through a stand-in that never joins the board.
  fx.startOfCombat = (c, side) => {
    const me = c.makeMinion({ name: card.name, atk: 0, hp: 1 })
    for (const e of effects) e(c, me, side, {})
  }
  if (CHOSEN[card.name]) fx.approximated = [CHOSEN[card.name]]
  return fx
}
