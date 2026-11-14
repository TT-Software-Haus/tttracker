// Battlegrounds-specific view of a game: lobby, combats, odds, results.
//
// How a Battlegrounds log looks:
// - You are one player entity; the other is a "dummy" player that hosts
//   whichever opponent you're fighting this round.
// - Odd TURN values are shop phases, even ones are combats.
// - At the start of each combat the game creates copies of both warbands in
//   PLAY. Each copied hero carries the PLAYER_ID of the lobby player it belongs to.
// - A combat ends with the winning hero attacking the loser's hero.
// - In Duos, when a warband dies its teammate's warband enters mid-combat.

import type { CardDb } from '../cards/cardDb'
import type { Entity, Game, GameEvent } from '../game/game'
import type { BgMatch, BgSnapshot, BoardMinion, CombatResult, CombatRound, GameMode, LobbyPlayer, SimOdds } from '../../shared/types'
import { simulateMany, type BoardInput, type MinionInput } from './sim/engine'
import type { SimJob, Simulator } from './sim/remote'
import { randomUUID } from 'node:crypto'

const on = (e: Entity, tag: string) => e.tags[tag] !== undefined && e.tags[tag] !== '0'

export function effectiveHealth(hero: Entity | undefined): number {
  if (!hero) return 0
  const t = hero.tags
  return Number(t.HEALTH ?? 0) + Number(t.ARMOR ?? 0) - Number(t.DAMAGE ?? 0)
}

export class BgGame {
  private rounds: CombatRound[] = []
  private current?: CombatRound
  private lastBoards = new Map<number, { round: number; minions: BoardMinion[] }>()
  private lastResults = new Map<number, CombatResult>()
  private lastTeammateBoard = new Map<number, MinionInput[]>()
  // Duos combat bookkeeping
  private combatCreated: Entity[] = []
  private warbandIds = new Set<number>()
  private duoBoards = new Map<number, Entity[]>()
  /** Duos: each warband's hero power (dbfId), from the hero copies made before the fight. */
  private duoHeroPowers = new Map<number, number>()
  private duoHands = new Map<number, Entity[]>()
  private enteredPids = new Set<number>()
  private resimPending = false
  private heroHpAtAttack?: Map<number, number>
  private placement?: number
  private matchPending = false
  private pendingTimer?: NodeJS.Timeout
  simIterations = 5000
  /**
   * Runs sims elsewhere (main sets a worker thread). Without one they run here,
   * synchronously, as the tests expect.
   */
  simulate?: Simulator
  /** The newest sim started for each round: a resim's odds replace the first's. */
  private simFor = new WeakMap<CombatRound, number>()
  private simSeq = 0

  /** Called after a finished game; return value is stored as history. */
  /**
   * The lobby's tribes aren't known here: they're read off the hero-select
   * screen, so Tracker fills them in. Collecting them from the tavern's minions
   * was dropped: a dual-tribe card (Demon/Naga) added a tribe that wasn't in
   * the lobby, or even in the season.
   */
  onMatchEnd?: (m: Omit<BgMatch, 'tribes'>) => void
  /**
   * A sim answered after its match was handed to onMatchEnd. The match holds
   * the same round objects, so its odds are already filled in; this is the cue
   * to save it again and refresh History.
   */
  onMatchUpdated?: () => void
  /** Rounds already handed over in a finished match. */
  private emittedRounds = new WeakSet<CombatRound>()
  /** Called whenever odds/results change (outside of the normal line batch). */
  onChange?: () => void

  /** Lookahead (GameState) copies of entities created during each combat turn, keyed by TURN. */
  private lookCreated = new Map<number, Entity[]>()

  /**
   * @param game     The game as the player sees it (PowerTaskList: in step with animations).
   * @param lookahead Optional GameState model of the same game. It runs ahead of `game`
   *                 but has full details of the hidden Duos warband copies, which
   *                 PowerTaskList omits. Entity ids are shared between the two.
   */
  constructor(
    private game: Game,
    private cards: CardDb,
    private lookahead?: Game,
  ) {
    game.on((e) => this.handle(e))
    const pending = new Map<number, Entity[]>()
    lookahead?.on((e) => {
      if (e.type === 'gameStart') {
        this.lookCreated.clear()
        pending.clear()
      }
      const t = lookahead.turn
      if (t <= 0 || t % 2 !== 0) return
      if (e.type === 'created') pending.set(t, [...(pending.get(t) ?? []), e.entity])
      // Freeze the copies as they are when this fight starts: by the time it's
      // on screen the lookahead will have played it out and cleaned them up.
      if (e.type === 'blockStart' && e.blockType === 'ATTACK' && !this.lookCreated.has(t)) {
        this.lookCreated.set(t, (pending.get(t) ?? []).map((x) => ({ id: x.id, cardId: x.cardId, tags: { ...x.tags } })))
        pending.delete(t)
      }
    })
  }

  get isBattlegrounds(): boolean {
    const t = this.game.info.gameType ?? ''
    if (t.includes('BATTLEGROUNDS')) return true
    // Fall back on the dummy player, in case the GameType line was missed.
    return [...this.game.playerEntityByPlayerId.values()].some((id) => this.game.entities.get(id)?.tags.BACON_DUMMY_PLAYER === '1')
  }

  get mode(): GameMode {
    return (this.game.info.gameType ?? '').includes('DUO') ? 'duos' : 'solo'
  }

  get round(): number {
    return Math.ceil(this.game.turn / 2)
  }

  get inCombat(): boolean {
    const t = this.game.turn
    return t > 0 && t % 2 === 0 && this.game.inGame
  }

  private reset() {
    this.rounds = []
    this.current = undefined
    this.lastBoards.clear()
    this.lastResults.clear()
    this.lastTeammateBoard.clear()
    this.combatCreated = []
    this.warbandIds.clear()
    this.duoBoards.clear()
    this.duoHeroPowers.clear()
    this.duoHands.clear()
    this.enteredPids.clear()
    this.resimPending = false
    this.heroHpAtAttack = undefined
    this.placement = undefined
  }

  // ------------------------------------------------------------ events

  private handle(e: GameEvent) {
    switch (e.type) {
      case 'gameStart':
        this.flushPendingMatch()
        this.reset()
        return
      case 'gameEnd':
        this.finishCombat()
        if (this.isBattlegrounds) {
          // The final leaderboard place can arrive a few lines after we're knocked
          // out, so give it a moment before saving the game.
          this.matchPending = true
          this.updatePlacement()
          if (this.pendingTimer) clearTimeout(this.pendingTimer)
          this.pendingTimer = setTimeout(() => this.flushPendingMatch(), 4000)
        }
        return
      case 'created': {
        if (!this.isBattlegrounds || !this.inCombat) return
        const ent = e.entity
        // Before the first attack: Duos snapshot copies of all four warbands.
        if (!this.current) this.combatCreated.push(ent)
        // During the fight: a teammate's warband arriving (created straight into play).
        else if (ent.tags.CARDTYPE === 'HERO' && ent.tags.ZONE === 'PLAY') this.resimPending = true
        return
      }
      case 'tag':
        return this.onTag(e.entity, e.tag, e.value, e.prev)
      case 'blockStart':
        if (e.blockType === 'ATTACK') this.onAttack(e.entity)
        return
      case 'blockEnd':
        if (e.blockType === 'ATTACK' && e.entity?.tags.CARDTYPE === 'HERO') this.onHeroAttackEnd()
        return
    }
  }

  private updatePlacement() {
    const hero = this.myLobbyHero()
    const place = hero ? Number(hero.tags.PLAYER_LEADERBOARD_PLACE ?? 0) : 0
    if (place) this.placement = place
  }

  /** Save the finished game (called after a short delay, or when the next game starts). */
  flushPendingMatch() {
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = undefined
    if (!this.matchPending) return
    this.matchPending = false
    this.updatePlacement()
    this.emitMatch()
    this.onChange?.()
  }

  private onTag(e: Entity, tag: string, value: string, prev: string | undefined) {
    if (!this.isBattlegrounds) return
    if (tag === 'PLAYER_LEADERBOARD_PLACE' && this.game.phase === 'over') this.updatePlacement()
    if (e.id === this.game.gameEntityId) {
      if (tag === 'TURN' && Number(value) % 2 === 1) this.finishCombat()
      if (tag === 'TURN' && Number(value) % 2 === 0) {
        // Shop is over: remember which minions are our real warband, so its
        // combat copies can be told apart from the other players' boards.
        this.warbandIds = new Set(this.minionEntities(this.game.friendlyPlayerId).map((m) => m.id))
        this.combatCreated = []
        this.duoBoards.clear()
    this.duoHeroPowers.clear()
        this.enteredPids.clear()
      }
      return
    }
    // Duos: a new hero (and warband) entering mid-combat.
    if (tag === 'ZONE' && value === 'PLAY' && prev !== 'PLAY' && e.tags.CARDTYPE === 'HERO' && this.current && this.inCombat) {
      this.resimPending = true
    }
  }

  private onAttack(attacker: Entity | undefined) {
    if (!attacker || !this.inCombat) return
    const first = this.game.controllerOf(attacker) === this.game.friendlyPlayerId ? 0 : 1
    if (!this.current) {
      // The first attack of a combat. Start of Combat effects have already
      // resolved by now, so we simulate from exactly this position.
      this.startCombat(first)
    }
    if (!this.current) return
    if (attacker.tags.CARDTYPE === 'HERO') {
      // The winner's hero hits the loser's hero: combat is decided.
      const mine = this.game.controllerOf(attacker) === this.game.friendlyPlayerId
      this.current.result = mine ? 'WON' : 'LOST'
      this.heroHpAtAttack = new Map([...this.game.entities.values()].filter((h) => h.tags.CARDTYPE === 'HERO').map((h) => [h.id, effectiveHealth(h)]))
      this.onChange?.()
      return
    }
    if (this.resimPending) {
      // A teammate's warband has come in: re-run from the current position.
      this.resimPending = false
      this.captureBoards(this.current, false)
      this.simulateInto(this.current, { firstAttacker: first, skipStartOfCombat: true })
      this.onChange?.()
    }
  }

  private onHeroAttackEnd() {
    if (!this.current || !this.heroHpAtAttack) return
    let dmg = 0
    for (const [id, before] of this.heroHpAtAttack) {
      const now = effectiveHealth(this.game.entities.get(id))
      dmg = Math.max(dmg, before - now)
    }
    this.current.damage = dmg
    this.heroHpAtAttack = undefined
    this.onChange?.()
  }

  // ------------------------------------------------------------ combat

  private startCombat(firstAttacker: 0 | 1) {
    const round: CombatRound = { round: this.round, myBoard: [], oppBoard: [] }
    this.groupDuoBoards()
    this.captureBoards(round, true)
    this.current = round
    this.rounds.push(round)
    this.resimPending = false
    this.simulateInto(round, { firstAttacker, skipStartOfCombat: true })
    this.onChange?.()
  }

  private finishCombat() {
    const c = this.current
    if (!c) return
    if (!c.result) c.result = 'TIED'
    if (c.opponentPlayerId !== undefined) this.lastResults.set(c.opponentPlayerId, c.result)
    this.current = undefined
    this.resimPending = false
  }

  private fightingHero(controller: number | undefined): Entity | undefined {
    return [...this.game.entities.values()].find((e) => e.tags.CARDTYPE === 'HERO' && e.tags.ZONE === 'PLAY' && this.game.controllerOf(e) === controller)
  }

  private dummyPlayerId(): number | undefined {
    for (const [pid] of this.game.playerEntityByPlayerId) if (pid !== this.game.friendlyPlayerId) return pid
    return undefined
  }

  /**
   * Duos: before each fight Hearthstone creates hidden copies of all four
   * warbands: each opponent/teammate hero copy (with its PLAYER_ID) followed by
   * its minions, plus copies of our own minions (no hero). Sort them into boards.
   */
  private groupDuoBoards() {
    this.duoBoards.clear()
    this.duoHeroPowers.clear()
    this.duoHands.clear()
    const me = this.game.friendlyPlayerId!
    let cur: number | undefined
    // Once a player's board has started, later cards in their group are board minions.
    const boardStarted = new Set<number>()
    const push = (map: Map<number, Entity[]>, pid: number, e: Entity) => map.set(pid, [...(map.get(pid) ?? []), e])
    // Prefer the lookahead model's copies: PowerTaskList hides their details.
    const look = this.lookahead ? this.lookCreated.get(this.game.turn) : undefined
    if (look) for (const t of [...this.lookCreated.keys()]) if (t < this.game.turn) this.lookCreated.delete(t)
    const created = look ?? this.combatCreated
    for (const e of [...created].sort((a, b) => a.id - b.id)) {
      const zone = e.tags.ZONE
      if (e.tags.CARDTYPE === 'HERO' && e.tags.PLAYER_ID && zone === 'SETASIDE') {
        cur = Number(e.tags.PLAYER_ID)
        if (!this.duoBoards.has(cur)) this.duoBoards.set(cur, [])
        if (e.tags.HERO_POWER) this.duoHeroPowers.set(cur, Number(e.tags.HERO_POWER))
        continue
      }
      if (e.tags.CARDTYPE !== 'MINION' || (zone !== 'SETASIDE' && zone !== 'HAND')) continue
      const mine = zone === 'SETASIDE' && this.warbandIds.has(Number(e.tags.COPIED_FROM_ENTITY_ID ?? 0))
      const pid = mine ? me : cur
      if (pid === undefined) continue
      // Each group lists the hand first, then the board. Hand copies are either
      // marked ZONE=HAND, or (for a teammate waiting to fight) have tag 3085 that
      // differs from their health. The first card that looks like a board copy
      // starts the board; everything after it is on the board.
      const looksLikeHand = zone === 'HAND' || Number(e.tags['3085'] ?? -1) !== Number(e.tags.HEALTH ?? 0)
      const isHand = !mine && !boardStarted.has(pid) && looksLikeHand
      if (!isHand && zone !== 'HAND') boardStarted.add(pid)
      push(isHand ? this.duoHands : this.duoBoards, pid, e)
    }
    // A board can't have more than 7 minions: anything extra (earliest first) was an
    // untouched hand card that looked like a board copy.
    for (const [pid, list] of this.duoBoards) {
      if (list.length <= 7) continue
      const extra = list.splice(0, list.length - 7)
      this.duoHands.set(pid, [...extra, ...(this.duoHands.get(pid) ?? [])])
    }
  }

  /** Known hand of a player: your real hand, or the copies Hearthstone made for this fight. */
  private handFor(pid: number | undefined): MinionInput[] {
    const me = this.game.friendlyPlayerId
    if (pid !== undefined && pid !== me) {
      // Drop hand cards that have already been summoned (e.g. by Diremuck Forager).
      const summoned = new Set([...this.game.entities.values()].filter((e) => e.tags.ZONE === 'PLAY').map((e) => Number(e.tags.COPIED_FROM_ENTITY_ID ?? 0)))
      return (this.duoHands.get(pid) ?? []).filter((e) => !summoned.has(e.id)).map((e) => this.toInput(e))
    }
    return this.myHand().map((e) => this.toInput(e))
  }

  /**
   * A copy Hearthstone made for a fight (e.g. your teammate's hand), whose
   * original is still in play or in a hand. A golden from a triple is also
   * logged as a copy, of one of the three, but those have been set aside;
   * dropping every copy lost goldens from your hand (seen live, after a restart:
   * the tag arrives just after the card does).
   */
  private isFightCopy(e: Entity) {
    const from = Number(e.tags.COPIED_FROM_ENTITY_ID ?? 0)
    if (!from) return false
    const zone = this.game.entities.get(from)?.tags.ZONE
    return zone === 'HAND' || zone === 'PLAY'
  }

  /** The minions in your own hand. */
  private myHand(): Entity[] {
    const me = this.game.friendlyPlayerId
    return [...this.game.entities.values()]
      .filter((e) => e.tags.CARDTYPE === 'MINION' && e.tags.ZONE === 'HAND' && this.game.controllerOf(e) === me && e.cardId && !this.isFightCopy(e) && !this.combatCreated.includes(e))
  }

  private pidOf(hero: Entity | undefined): number | undefined {
    return hero ? Number(hero.tags.PLAYER_ID ?? 0) || undefined : undefined
  }

  /** Duos: the warband (player id) that will come in when this side's current one dies. */
  private reservePid(side: 'me' | 'opp'): number | undefined {
    if (this.mode !== 'duos' || !this.duoBoards.size) return undefined
    const me = this.game.friendlyPlayerId!
    const mate = Number(this.game.playerEntity(me)?.tags.BACON_DUO_TEAMMATE_PLAYER_ID ?? 0) || undefined
    const myTeam = [me, mate].filter((p): p is number => p !== undefined)
    const team = side === 'me' ? myTeam : [...this.duoBoards.keys()].filter((p) => !myTeam.includes(p))
    return team.find((p) => !this.enteredPids.has(p) && this.duoBoards.has(p))
  }

  /** Duos: is a warband still to come in on this side, without us knowing its board? */
  private reserveUnknown(side: 'me' | 'opp'): boolean {
    if (this.mode !== 'duos') return false
    const me = this.game.friendlyPlayerId!
    const mate = Number(this.game.playerEntity(me)?.tags.BACON_DUO_TEAMMATE_PLAYER_ID ?? 0) || undefined
    const myTeam = [me, mate].filter((p): p is number => p !== undefined)
    if (side === 'opp' && !this.duoBoards.size) return true // no copies seen at all
    const team = side === 'me' ? myTeam : [...this.duoBoards.keys()].filter((p) => !myTeam.includes(p))
    return team.filter((p) => !this.enteredPids.has(p)).some((p) => !this.duoBoards.get(p)?.length)
  }

  private reserveInput(side: 'me' | 'opp'): BoardInput['reserve'] {
    const pid = this.reservePid(side)
    const ents = pid === undefined ? undefined : this.duoBoards.get(pid)
    if (!ents?.length) return undefined
    const power = this.cards.byDbfId(this.duoHeroPowers.get(pid!) ?? 0)?.id
    return { minions: ents.map((e) => this.toInput(e)), heroTier: Number(this.lobbyHero(pid)?.tags.PLAYER_TECH_LEVEL ?? 1), hand: this.handFor(pid), heroPower: power }
  }

  private captureBoards(round: CombatRound, initial: boolean) {
    const me = this.game.friendlyPlayerId
    const dummy = this.dummyPlayerId()
    const oppHero = this.fightingHero(dummy)
    const myHero = this.fightingHero(me)
    const pid = this.pidOf(oppHero)
    const myPid = this.pidOf(myHero)
    if (pid !== undefined) this.enteredPids.add(pid)
    if (myPid !== undefined) this.enteredPids.add(myPid)
    const oppBoard = this.boardOf(dummy)
    if (initial) {
      round.myBoard = this.boardOf(me)
      round.oppBoard = oppBoard
      if (pid !== undefined) {
        round.opponentPlayerId = pid
        round.opponentHeroCardId = this.lobbyHero(pid)?.cardId ?? oppHero?.cardId
        round.opponentHeroName = this.cards.get(round.opponentHeroCardId)?.name
      }
      // Duos: show the teammates' warbands that are waiting to come in.
      const rOpp = this.reservePid('opp')
      const rMe = this.reservePid('me')
      if (rOpp !== undefined) {
        round.oppReserve = this.duoBoards.get(rOpp)!.map((e) => this.toBoardMinion(e))
        round.oppReserveHeroCardId = this.lobbyHero(rOpp)?.cardId
        this.lastBoards.set(rOpp, { round: round.round, minions: round.oppReserve })
      }
      if (rMe !== undefined) {
        round.myReserve = this.duoBoards.get(rMe)!.map((e) => this.toBoardMinion(e))
        round.myReserveHeroCardId = this.lobbyHero(rMe)?.cardId
      }
    }
    if (pid !== undefined) this.lastBoards.set(pid, { round: round.round, minions: oppBoard })
    // Duos: remember the teammate's warband when it's the one fighting on our side.
    if (myPid && myPid !== me) this.lastTeammateBoard.set(myPid, this.minionEntities(me).map((e) => this.toInput(e)))
  }

  private minionEntities(controller: number | undefined): Entity[] {
    if (controller === undefined) return []
    return [...this.game.entities.values()]
      .filter((e) => e.tags.CARDTYPE === 'MINION' && e.tags.ZONE === 'PLAY' && this.game.controllerOf(e) === controller)
      .sort((a, b) => Number(a.tags.ZONE_POSITION ?? 0) - Number(b.tags.ZONE_POSITION ?? 0))
  }

  private toBoardMinion(e: Entity): BoardMinion {
    const t = e.tags
    const card = this.cards.get(e.cardId)
    return {
      cardId: e.cardId,
      name: card?.name ?? e.cardId,
      atk: Number(t.ATK ?? 0),
      health: Number(t.HEALTH ?? 0) - Number(t.DAMAGE ?? 0),
      tier: Number(t.TECH_LEVEL ?? card?.techLevel ?? 1),
      golden: on(e, 'PREMIUM') || !!card?.normalId,
      ...(card?.normalId && { normalId: card.normalId }),
      taunt: on(e, 'TAUNT'),
      divineShield: on(e, 'DIVINE_SHIELD'),
      reborn: on(e, 'REBORN'),
      venomous: on(e, 'VENOMOUS') || on(e, 'POISONOUS'),
      windfury: on(e, 'WINDFURY') || on(e, 'MEGA_WINDFURY'),
      stealth: on(e, 'STEALTH'),
    }
  }

  private boardOf(controller: number | undefined): BoardMinion[] {
    return this.minionEntities(controller).map((e) => this.toBoardMinion(e))
  }

  /**
   * How many cards are on offer in the tavern, spells included. Checked
   * against a live log: tavern spells (CARDTYPE BATTLEGROUND_SPELL) sit in the
   * same PLAY zone as the offered minions, each with its own ZONE_POSITION.
   * The highlight boxes use this to check the screen agrees before drawing.
   */
  tavernSize(): number {
    const dummy = this.dummyPlayerId()
    if (dummy === undefined) return 0
    return [...this.game.entities.values()].filter(
      (e) =>
        e.tags.ZONE === 'PLAY' &&
        (e.tags.CARDTYPE === 'MINION' || e.tags.CARDTYPE === 'BATTLEGROUND_SPELL') &&
        Number(e.tags.ZONE_POSITION ?? 0) > 0 &&
        this.game.controllerOf(e) === dummy,
    ).length
  }

  /**
   * What's on offer in the tavern right now.
   *
   * During a shop phase the offerings sit in the *other* player's PLAY zone —
   * the same slot that holds the opponent's warband during a fight. Verified
   * against a real log: four pool minions early in the shop, two by the end
   * (the missing pair having been bought and appeared on my own board), and
   * none at all once combat starts. Only ever call this during 'shop'.
   *
   * Not only pool minions (IS_BACON_POOL_MINION): seen live, a token created
   * into the tavern (Dark Paradox, BG36_360t3) is on offer without that tag,
   * and got no box. Same rule as tavernSize(): a minion with a slot.
   */
  private shopMinions(): BoardMinion[] {
    return this.minionEntities(this.dummyPlayerId())
      .filter((e) => Number(e.tags.ZONE_POSITION ?? 0) > 0)
      // The slot a card sits in on screen. Kept because the tavern can also
      // hold spells, which take a slot without being minions — so counting
      // minions left-to-right would point at the wrong card.
      .map((e) => ({ ...this.toBoardMinion(e), pos: Number(e.tags.ZONE_POSITION ?? 0) }))
  }

  private simInput(controller: number | undefined): BoardInput {
    const hero = this.fightingHero(controller)
    const pid = hero ? Number(hero.tags.PLAYER_ID ?? 0) : 0
    const tier = Number(this.lobbyHero(pid)?.tags.PLAYER_TECH_LEVEL ?? hero?.tags.PLAYER_TECH_LEVEL ?? 1)
    const minions = this.minionEntities(controller).map((e) => this.toInput(e))
    // Hands: yours is always visible; for others Hearthstone copies the cards a
    // fight needs (e.g. for Diremuck Forager / Flighty Scout) into the log.
    const heroPower = this.cards.byDbfId(Number(hero?.tags.HERO_POWER ?? 0))?.id
    const input: BoardInput = { minions, heroTier: tier, hand: this.handFor(pid || undefined), heroPower, turn: this.round }
    if (controller === this.game.friendlyPlayerId) {
      const mate = Number(this.game.playerEntity(controller)?.tags.BACON_DUO_TEAMMATE_PLAYER_ID ?? 0)
      const mateBoard = mate ? this.lastTeammateBoard.get(mate) : undefined
      if (mateBoard) input.teammate = mateBoard
    }
    return input
  }

  private toInput(e: Entity): MinionInput {
    const t = e.tags
    return {
      cardId: e.cardId,
      atk: Number(t.ATK ?? 0),
      health: Number(t.HEALTH ?? 0) - Number(t.DAMAGE ?? 0),
      golden: on(e, 'PREMIUM'),
      taunt: on(e, 'TAUNT'),
      divineShield: on(e, 'DIVINE_SHIELD'),
      venomous: on(e, 'VENOMOUS'),
      poisonous: on(e, 'POISONOUS'),
      windfury: on(e, 'WINDFURY'),
      megaWindfury: on(e, 'MEGA_WINDFURY') || t.WINDFURY === '3',
      reborn: on(e, 'REBORN'),
      stealth: on(e, 'STEALTH'),
      tier: Number(t.TECH_LEVEL ?? 0) || undefined,
    }
  }

  /** Fill in the round's odds: now, or when the sim worker answers. */
  private simulateInto(round: CombatRound, opts: { firstAttacker?: 0 | 1; skipStartOfCombat?: boolean }) {
    const job = this.simJob(round, opts)
    if (!job) return
    const { partial, ...sim } = job
    if (!this.simulate) {
      round.odds = this.runSim(sim, partial)
      return
    }
    const seq = ++this.simSeq
    this.simFor.set(round, seq)
    this.simulate(sim).then(
      (odds) => {
        if (this.simFor.get(round) !== seq) return // a resim replaced it
        round.odds = partial ? { ...odds, partial: true } : odds
        this.onChange?.()
        if (this.emittedRounds.has(round)) this.onMatchUpdated?.()
      },
      (err) => console.error('Simulation failed', err),
    )
  }

  private runSim(job: SimJob, partial: boolean): SimOdds | undefined {
    try {
      const odds: SimOdds = simulateMany(this.cards, job.a, job.b, job.opts)
      if (partial) odds.partial = true
      return odds
    } catch (err) {
      console.error('Simulation failed', err)
      return undefined
    }
  }

  private simJob(round: CombatRound, opts: { firstAttacker?: 0 | 1; skipStartOfCombat?: boolean }): (SimJob & { partial: boolean }) | undefined {
    const me = this.game.friendlyPlayerId
    const dummy = this.dummyPlayerId()
    const a = this.simInput(me)
    const b = this.simInput(dummy)
    a.reserve = this.reserveInput('me')
    b.reserve = this.reserveInput('opp')
    if (!a.minions.length && !b.minions.length) return undefined
    // Duos: a teammate's warband that hasn't fought yet but whose board we don't know
    // means only the current boards were simulated.
    const partialDuos = this.reserveUnknown('me') || this.reserveUnknown('opp')
    const myHp = effectiveHealth(this.myLobbyHero())
    const oppHp = effectiveHealth(this.lobbyHero(round.opponentPlayerId))
    return {
      a,
      b,
      opts: {
        iterations: this.simIterations,
        timeBudgetMs: 400,
        firstAttacker: opts.firstAttacker,
        skipStartOfCombat: opts.skipStartOfCombat,
        myHealth: myHp || undefined,
        oppHealth: oppHp || undefined,
      },
      partial: partialDuos,
    }
  }

  // ------------------------------------------------------------ lobby

  /** Lobby heroes keyed by PLAYER_ID (the real ones, not combat copies). */
  private lobbyHeroes(): Map<number, Entity> {
    const out = new Map<number, Entity>()
    for (const e of this.game.entities.values()) {
      const t = e.tags
      // Opponents' lobby heroes are themselves copies (COPIED_FROM_ENTITY_ID), so
      // the leaderboard place is what identifies them; combat copies don't have one.
      if (t.CARDTYPE !== 'HERO' || !t.PLAYER_LEADERBOARD_PLACE || !t.PLAYER_ID) continue
      if (e.cardId === 'TB_BaconShop_HERO_PH') continue
      const pid = Number(t.PLAYER_ID)
      const prev = out.get(pid)
      if (!prev || e.id > prev.id) out.set(pid, e)
    }
    return out
  }

  private lobbyHero(pid: number | undefined): Entity | undefined {
    return pid === undefined ? undefined : this.lobbyHeroes().get(pid)
  }

  private myLobbyHero(): Entity | undefined {
    return this.lobbyHero(this.game.friendlyPlayerId)
  }

  lobby(): LobbyPlayer[] {
    const me = this.game.friendlyPlayerId
    const player = this.game.playerEntity(me)
    const mate = Number(player?.tags.BACON_DUO_TEAMMATE_PLAYER_ID ?? 0) || undefined
    const nextOpp = Number(player?.tags.NEXT_OPPONENT_PLAYER_ID ?? 0) || undefined
    const nextOppMate = Number(player?.tags.NEXT_OPPONENT_TEAMMATE_PLAYER_ID ?? 0) || undefined
    const out: LobbyPlayer[] = []
    for (const [pid, h] of this.lobbyHeroes()) {
      const t = h.tags
      const card = this.cards.get(h.cardId)
      const hp = effectiveHealth(h)
      out.push({
        playerId: pid,
        heroCardId: h.cardId,
        heroName: card?.name ?? h.cardId,
        health: Number(t.HEALTH ?? 0) - Number(t.DAMAGE ?? 0),
        armor: Number(t.ARMOR ?? 0),
        tier: Number(t.PLAYER_TECH_LEVEL ?? 1),
        triples: Number(t.PLAYER_TRIPLES ?? 0),
        place: Number(t.PLAYER_LEADERBOARD_PLACE ?? 0),
        team: t.BACON_DUO_TEAM_ID ? Number(t.BACON_DUO_TEAM_ID) : undefined,
        isMe: pid === me,
        isTeammate: pid === mate,
        isNextOpponent: pid === nextOpp || pid === nextOppMate,
        dead: hp <= 0,
        lastBoard: this.lastBoards.get(pid),
        lastResult: this.lastResults.get(pid),
      })
    }
    // Your own hero doesn't carry a team id; you share your teammate's.
    const mine = out.find((p) => p.isMe)
    const mateRow = out.find((p) => p.isTeammate)
    if (mine && mine.team === undefined && mateRow) mine.team = mateRow.team
    return out.sort((a, b) => a.place - b.place || (a.team ?? 0) - (b.team ?? 0) || a.playerId - b.playerId)
  }

  // ------------------------------------------------------------ output

  /** Everything the log can tell us. Screen-derived fields are the Tracker's. */
  snapshot(): Omit<BgSnapshot, 'status' | 'statusDetail' | 'shopHighlights' | 'tribes'> {
    const lobby = this.lobby()
    const me = lobby.find((p) => p.isMe)
    const phase: BgSnapshot['phase'] = this.game.phase === 'over' ? 'over' : !this.game.inGame ? 'none' : this.inCombat ? 'combat' : 'shop'
    return {
      mode: this.mode,
      round: this.round,
      phase,
      me,
      lobby,
      board: this.boardOf(this.game.friendlyPlayerId),
      hand: this.myHand().map((e) => this.toBoardMinion(e)),
      shop: phase === 'shop' ? this.shopMinions() : [],
      combat: this.current ?? this.rounds[this.rounds.length - 1],
      rounds: this.rounds,
      placement: this.placement,
    }
  }

  private emitMatch() {
    const me = this.myLobbyHero()
    if (!me || !this.onMatchEnd) return
    const player = this.game.playerEntity(this.game.friendlyPlayerId)
    const mate = this.lobbyHero(Number(player?.tags.BACON_DUO_TEAMMATE_PLAYER_ID ?? 0) || undefined)
    const lastMine = [...this.rounds].reverse().find((r) => r.myBoard.length)
    for (const r of this.rounds) this.emittedRounds.add(r)
    this.onMatchEnd({
      id: randomUUID(),
      startedAt: this.game.startedAt,
      endedAt: Date.now(),
      mode: this.mode,
      heroCardId: me.cardId,
      heroName: this.cards.get(me.cardId)?.name ?? me.cardId,
      placement: this.placement ?? 0,
      rounds: this.round,
      finalBoard: lastMine?.myBoard ?? this.boardOf(this.game.friendlyPlayerId),
      teammateHeroCardId: mate?.cardId,
      combats: this.rounds,
    })
  }
}
