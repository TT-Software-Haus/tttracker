// Parses Hearthstone's Power.log (GameState.* lines) into an entity model.
// The game is a set of entities, each a bag of tags (ZONE, CONTROLLER, ATK...).
// Listeners get fine-grained events so mode-specific logic (Battlegrounds)
// can react to tag changes and action blocks as they stream in.

export interface Entity {
  id: number
  cardId: string
  tags: Record<string, string>
}

export interface GameInfo {
  gameType?: string
  formatType?: string
  buildNumber?: string
}

export type GameEvent =
  | { type: 'gameStart' }
  | { type: 'gameEnd' }
  | { type: 'created'; entity: Entity }
  | { type: 'tag'; entity: Entity; tag: string; value: string; prev: string | undefined }
  | { type: 'blockStart'; blockType: string; entity?: Entity }
  | { type: 'blockEnd'; blockType: string; entity?: Entity }

type Phase = 'none' | 'running' | 'over'

const LINE_RE = /^[DIWE] [\d:.]+ (GameState|PowerTaskList)\.(DebugPrintPower|DebugPrintGame)\(\) - (.*)$/

/**
 * Hearthstone logs the game twice. GameState lines arrive the moment the server
 * sends them; in Battlegrounds that means a whole fight (and its result) is
 * logged at once, before it's animated. PowerTaskList lines carry the same
 * events as the client plays them, in step with what's on screen. The live
 * tracker reads PowerTaskList so it never runs ahead of (or spoils) the game.
 */
export type PowerSource = 'GameState' | 'PowerTaskList'
const TAG_LINE_RE = /^\s*tag=(\S+) value=(.*)$/
const UNKNOWN_PLAYER = 'UNKNOWN HUMAN PLAYER'

export class Game {
  entities = new Map<number, Entity>()
  /** PlayerID -> player entity id */
  playerEntityByPlayerId = new Map<number, number>()
  /** player entity id -> display name */
  playerNames = new Map<number, string>()
  /** PlayerID -> name from DebugPrintGame */
  namesByPlayerId = new Map<number, string>()
  /** PlayerID -> GameAccountId hi (0 for AI / Battlegrounds dummy players) */
  accountHi = new Map<number, string>()
  friendlyPlayerId?: number
  gameEntityId = 1
  info: GameInfo = {}
  phase: Phase = 'none'
  startedAt = 0

  private pending?: Entity
  private pendingIsNew = false
  private blocks: { blockType: string; entity?: Entity }[] = []
  private listeners: ((e: GameEvent) => void)[] = []

  constructor(private powerSource: PowerSource = 'PowerTaskList') {}

  on(fn: (e: GameEvent) => void) {
    this.listeners.push(fn)
  }

  private emit(e: GameEvent) {
    for (const l of this.listeners) l(e)
  }

  get inGame() {
    return this.phase === 'running'
  }

  get turn(): number {
    return Number(this.gameEntity()?.tags.TURN ?? 0)
  }

  gameEntity(): Entity | undefined {
    return this.entities.get(this.gameEntityId)
  }

  playerEntity(playerId: number | undefined): Entity | undefined {
    if (playerId === undefined) return undefined
    const id = this.playerEntityByPlayerId.get(playerId)
    return id === undefined ? undefined : this.entities.get(id)
  }

  playerName(playerId: number | undefined): string | undefined {
    if (playerId === undefined) return undefined
    const eid = this.playerEntityByPlayerId.get(playerId)
    const n = (eid !== undefined && this.playerNames.get(eid)) || this.namesByPlayerId.get(playerId)
    return n && n !== UNKNOWN_PLAYER ? n : undefined
  }

  controllerOf(e: Entity): number {
    return Number(e.tags.CONTROLLER ?? 0)
  }

  // ------------------------------------------------------------------ parsing

  /** Feed one raw log line. Returns true if game state changed. */
  handleLine(raw: string): boolean {
    const m = LINE_RE.exec(raw)
    if (!m) return false
    const [, source, method, body] = m
    if (method === 'DebugPrintGame') {
      // Game info (mode, player names) is only printed by GameState.
      if (source === 'GameState') this.handlePrintGame(body)
      return false
    }
    if (source !== this.powerSource) return false
    return this.handlePower(body)
  }

  private handlePrintGame(body: string) {
    let m: RegExpExecArray | null
    if ((m = /^PlayerID=(\d+), PlayerName=(.+)$/.exec(body))) {
      this.namesByPlayerId.set(Number(m[1]), m[2].trim())
      const eid = this.playerEntityByPlayerId.get(Number(m[1]))
      if (eid !== undefined) this.playerNames.set(eid, m[2].trim())
    } else if ((m = /^GameType=(\S+)/.exec(body))) this.info.gameType = m[1]
    else if ((m = /^FormatType=(\S+)/.exec(body))) this.info.formatType = m[1]
    else if ((m = /^BuildNumber=(\S+)/.exec(body))) this.info.buildNumber = m[1]
  }

  private handlePower(body: string): boolean {
    // Tag lines belong to the most recent FULL_ENTITY / SHOW_ENTITY / Player / GameEntity line.
    const t = TAG_LINE_RE.exec(body)
    if (t) {
      if (this.pending) this.pending.tags[t[1]] = t[2].trim()
      return !!this.pending
    }
    this.finishPending()
    const line = body.trim()
    let m: RegExpExecArray | null

    if (line === 'CREATE_GAME') {
      this.reset()
      this.phase = 'running'
      this.startedAt = Date.now()
      this.emit({ type: 'gameStart' })
      return true
    }
    if (this.phase === 'none') return false

    if ((m = /^GameEntity EntityID=(\d+)/.exec(line))) {
      this.gameEntityId = Number(m[1])
      this.startPending(this.gameEntityId)
      return true
    }
    if ((m = /^Player EntityID=(\d+) PlayerID=(\d+) GameAccountId=\[hi=(\d+)/.exec(line))) {
      const eid = Number(m[1])
      const pid = Number(m[2])
      this.playerEntityByPlayerId.set(pid, eid)
      this.accountHi.set(pid, m[3])
      const known = this.namesByPlayerId.get(pid)
      if (known) this.playerNames.set(eid, known)
      this.startPending(eid)
      this.pending!.tags.PLAYER_ID = String(pid)
      return true
    }
    if ((m = /^FULL_ENTITY - (?:Creating ID=(\d+)|Updating (.+)) CardID=(\S*)$/.exec(line))) {
      const id = m[1] ? Number(m[1]) : this.resolveEntity(m[2])
      if (id < 0) return false
      this.startPending(id)
      if (m[3]) this.pending!.cardId = m[3]
      return true
    }
    if ((m = /^(?:SHOW_ENTITY|CHANGE_ENTITY) - Updating Entity=(.+) CardID=(\S*)$/.exec(line))) {
      const id = this.resolveEntity(m[1])
      if (id < 0) return false
      const e = this.getOrCreate(id)
      if (m[2]) e.cardId = m[2]
      this.pending = e
      this.pendingIsNew = false
      return true
    }
    if ((m = /^HIDE_ENTITY - Entity=(.+) tag=(\S+) value=(\S+)$/.exec(line))) {
      const id = this.resolveEntity(m[1])
      if (id < 0) return false
      this.setTag(this.getOrCreate(id), m[2], m[3])
      return true
    }
    if ((m = /^TAG_CHANGE Entity=(.+) tag=(\S+) value=(\S+)/.exec(line))) {
      const id = this.resolveEntity(m[1])
      if (id < 0) return false
      this.setTag(this.getOrCreate(id), m[2], m[3])
      return true
    }
    if ((m = /^BLOCK_START BlockType=(\S+) Entity=(.+?) EffectCardId=/.exec(line))) {
      const id = this.resolveEntity(m[2])
      const block = { blockType: m[1], entity: id >= 0 ? this.entities.get(id) : undefined }
      this.blocks.push(block)
      this.emit({ type: 'blockStart', ...block })
      return true
    }
    if (line === 'BLOCK_END') {
      const block = this.blocks.pop()
      if (block) this.emit({ type: 'blockEnd', ...block })
      return true
    }
    return false
  }

  private startPending(id: number) {
    this.pendingIsNew = !this.entities.has(id)
    this.pending = this.getOrCreate(id)
  }

  /** Called when the tag block following an entity line ends. */
  private finishPending() {
    const e = this.pending
    if (!e) return
    this.pending = undefined
    if (this.pendingIsNew) this.emit({ type: 'created', entity: e })
    this.pendingIsNew = false
    if (e.tags.CARDTYPE === 'PLAYER' || e.tags.PLAYER_ID) this.detectFriendly()
  }

  /**
   * Battlegrounds has exactly two player entities: you, and a "dummy" player
   * that hosts whichever opponent you're currently fighting.
   */
  private detectFriendly() {
    if (this.friendlyPlayerId !== undefined) return
    const players = [...this.playerEntityByPlayerId.entries()]
    const dummy = players.find(([, eid]) => this.entities.get(eid)?.tags.BACON_DUMMY_PLAYER === '1')
    if (dummy) {
      const real = players.find(([pid]) => pid !== dummy[0])
      if (real) this.friendlyPlayerId = real[0]
      return
    }
    // Fallback: the only player with a real account id.
    const humans = players.filter(([pid]) => this.accountHi.get(pid) !== '0')
    if (players.length >= 2 && humans.length === 1) this.friendlyPlayerId = humans[0][0]
  }

  private setTag(e: Entity, tag: string, value: string) {
    const prev = e.tags[tag]
    e.tags[tag] = value
    this.emit({ type: 'tag', entity: e, tag, value, prev })
    if (this.phase !== 'running') return
    const gameOver = e.id === this.gameEntityId && tag === 'STATE' && value === 'COMPLETE'
    // In Battlegrounds you leave as soon as you're knocked out; the match carries on
    // for others, so your own PLAYSTATE is the end of *your* game.
    const iFinished =
      tag === 'PLAYSTATE' &&
      ['WON', 'LOST', 'TIED', 'CONCEDED'].includes(value) &&
      this.friendlyPlayerId !== undefined &&
      e.id === this.playerEntityByPlayerId.get(this.friendlyPlayerId)
    if (gameOver || iFinished) {
      this.phase = 'over'
      this.emit({ type: 'gameEnd' })
    }
  }

  private getOrCreate(id: number): Entity {
    let e = this.entities.get(id)
    if (!e) {
      e = { id, cardId: '', tags: {} }
      this.entities.set(id, e)
    }
    return e
  }

  /** Entity refs look like `42`, `GameEntity`, `Name#1234` or `[entityName=.. id=42 .. cardId=X player=1]`. */
  private resolveEntity(ref: string): number {
    ref = ref.trim()
    if (ref.startsWith('[')) {
      const id = / id=(\d+)/.exec(ref)
      if (!id) return -1
      const n = Number(id[1])
      const card = / cardId=(\S+) /.exec(ref)
      if (card && card[1]) {
        const e = this.getOrCreate(n)
        if (!e.cardId) e.cardId = card[1]
      }
      return n
    }
    if (/^\d+$/.test(ref)) return Number(ref)
    if (ref === 'GameEntity') return this.gameEntityId
    return this.resolvePlayerName(ref)
  }

  private resolvePlayerName(name: string): number {
    for (const [eid, n] of this.playerNames) if (n === name) return eid
    for (const [pid, n] of this.namesByPlayerId) {
      if (n === name) {
        const eid = this.playerEntityByPlayerId.get(pid)
        if (eid !== undefined) {
          this.playerNames.set(eid, name)
          return eid
        }
      }
    }
    // In Battlegrounds the dummy player's name changes every combat (it takes
    // the current opponent's name). Any unknown name belongs to the dummy.
    const dummy = [...this.playerEntityByPlayerId.entries()].find(([pid]) => pid !== this.friendlyPlayerId && this.friendlyPlayerId !== undefined)
    if (dummy) return dummy[1]
    const candidates = [...this.playerEntityByPlayerId.values()].filter((eid) => {
      const n = this.playerNames.get(eid)
      return !n || n === UNKNOWN_PLAYER
    })
    if (candidates.length === 1) {
      this.playerNames.set(candidates[0], name)
      return candidates[0]
    }
    return -1
  }

  private reset() {
    this.entities.clear()
    this.playerEntityByPlayerId.clear()
    this.playerNames.clear()
    this.accountHi.clear()
    this.blocks = []
    // namesByPlayerId / info are printed around CREATE_GAME; they get overwritten per game.
    this.friendlyPlayerId = undefined
    this.gameEntityId = 1
    this.phase = 'none'
    this.pending = undefined
  }
}
