import { existsSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { CardDb } from './cards/cardDb'
import { Game } from './game/game'
import { BgGame } from './bg/bgGame'
import { checkLogConfig, ensureLogConfig, findActiveLogDir, findInstallPath, installLooksValid, logConfigPath } from './logs/hsPaths'
import { LogTail, lastGameOffset } from './logs/logTail'
import { readLobbyTribes, readShopSlots, stopVision } from './vision/heroSelect'
import { stopCapture } from './vision/stream'
import { mark, profiling } from './stallWatch'
import type { Simulator } from './bg/sim/remote'
import { getGameWindowRect } from './vision/gameWindow'
import type { Store } from './store'
import type { BgSnapshot, BoardMinion, Build, SetupStatus } from '../shared/types'

/**
 * Which builds to put in front of the player, or `undefined` for "don't ask".
 *
 * This runs on every snapshot — up to ~17 times a second — so every condition
 * here is about *not* interrupting: ask only once the hero is locked in, only
 * for tribes actually in this lobby, and never again once answered. Getting it
 * wrong means either nagging mid-fight or never offering at all.
 */
export function buildsToOffer(
  builds: Build[],
  tribes: string[],
  state: { heroPicked: boolean; answered: boolean; hasSelection: boolean; inGame: boolean; inCombat: boolean },
): Build[] | undefined {
  // Still unanswered when a fight starts means the player played on without
  // it: that's "not this game", and the caller records it so it stays answered.
  if (!state.heroPicked || state.answered || state.hasSelection || !state.inGame || state.inCombat) return undefined
  // A build with no tribe (a Menagerie board) fits any lobby.
  const matching = builds.filter((b) => !b.tribe || tribes.includes(b.tribe))
  return matching.length ? matching : undefined
}

/**
 * Whether the lobby overlay should offer "Pick a build": after the prompt was
 * dismissed, or when nothing matched the lobby so it never appeared. Not while
 * the prompt is still up, since that's the same question asked twice.
 */
export function canPickBuild(
  builds: Build[],
  prompt: Build[] | undefined,
  state: { heroPicked: boolean; hasSelection: boolean; inGame: boolean },
): boolean {
  return state.heroPicked && state.inGame && !state.hasSelection && !prompt && builds.length > 0
}

/**
 * Finds the logs, tails Power.log, feeds the game model and publishes
 * snapshots. Emits 'snapshot' (BgSnapshot) and 'data' (match history changed).
 */
const GAME_OVER_LINGER_MS = 30_000
/** The longest a slice of log lines may hold the main thread (see feed()). */
const SLICE_MS = 8
const SLICE_LINES = 200
/** Hero select lasts ~70s; retry the banner read across it, then give up. */
const TRIBE_READ_ATTEMPTS = 70
const TRIBE_READ_INTERVAL_MS = 1000
/** Let the tavern's cards slide into place before the first read. */
const HIGHLIGHT_SETTLE_MS = 250
/** How often to re-read the tavern while there's something to box. Reads take ~2.5ms. */
const HIGHLIGHT_POLL_MS = 250
const STALL_MS = 3 * 60_000

function isHearthstoneRunning(): Promise<boolean> {
  return new Promise((res) =>
    execFile('tasklist', ['/FI', 'IMAGENAME eq Hearthstone.exe', '/NH'], (err, stdout) => res(!err && /Hearthstone\.exe/i.test(stdout))),
  )
}

export class Tracker extends EventEmitter {
  readonly cards = new CardDb()
  private game!: Game
  private lookahead!: Game
  private bg!: BgGame
  private overSince?: number
  private lingerTimer?: NodeJS.Timeout
  private powerTail?: LogTail
  /** Lines waiting for drain(), oldest first. */
  private lineQueue: { lines: string[]; catchingUp: boolean; at: number }[] = []
  /** The tail is part-way through one read: more lines are on their way. */
  private moreComing = false
  private cardsLoaded = false
  private logDir?: string
  /**
   * We were watching this log folder before Power.log existed, so its first
   * lines are a game starting now, not history to replay. Missing this skipped
   * the tribe read in the first game of every Hearthstone session.
   */
  private powerLogIsNew = false
  private dirTimer?: NodeJS.Timeout
  private emitTimer?: NodeJS.Timeout
  private catchingUp = false
  /** The raw log line being parsed, so a game can be identified by its CREATE_GAME line. */
  private currentLine = ''
  /** Identifies the current game across tracker restarts; see beginGame. */
  private gameKey = ''
  /** The current game ended in the log before we started watching. */
  private endedDuringReplay = false
  private lastLineAt = Date.now()
  private wasStalled = false

  /**
   * Mid-game, Hearthstone writes to Power.log constantly. Minutes of silence
   * means it has stopped logging (e.g. it hit its log size limit).
   */
  private get logStalled() {
    return this.game.inGame && Date.now() - this.lastLineAt > STALL_MS
  }
  private logConfigOk = false
  private lastSnapshot?: BgSnapshot
  /**
   * The lobby's tribes, read off the hero-select screen: the only source. The
   * tavern's minions were dropped as one (a Demon/Naga card added Naga, which
   * isn't even in the season), so a tracker started after hero select knows none.
   */
  private screenTribes: string[] = []
  /**
   * In Battlegrounds the mulligan *is* the hero choice, so MULLIGAN_STATE=DONE
   * means the hero is locked in, which is when a build becomes worth offering.
   * Read from state rather than waiting for the tag to change: a log replayed
   * after a tracker restart, or one that opens on a state dump (the fixture
   * logs do), has the player DONE from their first line, with no change at all.
   */
  private get heroPicked() {
    return this.game.playerEntity(this.game.friendlyPlayerId)?.tags.MULLIGAN_STATE === 'DONE'
  }
  /** The same, asked of GameState: PowerTaskList may still be on the last game, where the hero was picked long ago. */
  private get lookaheadHeroPicked() {
    return this.lookahead.playerEntity(this.lookahead.friendlyPlayerId)?.tags.MULLIGAN_STATE === 'DONE'
  }
  private selectedBuildId?: string
  /** Set once the prompt has been answered or dismissed, so it doesn't come back. */
  private buildPromptAnswered = false
  private tribeTimer?: NodeJS.Timeout
  private tribeReading = false
  private tribeGen = 0
  /** Boxes to draw over the tavern, in Hearthstone client coordinates. */
  private highlights: BgSnapshot['shopHighlights'] = []
  /** The tavern's contents when the current boxes were wanted; a change clears them. */
  private highlightKey = ''
  /** Where the last read put the boxes; they move only when two reads agree. */
  private highlightPending = ''
  /** Wanted minions on offer right now, for the polling loop to box. */
  private highlightTargets: (BoardMinion & { debug: boolean })[] = []
  /** True while the loop is running, including mid-capture when no timer is set. */
  private highlightLoop = false
  private highlightTimer?: NodeJS.Timeout

  constructor(
    private store: Store,
    private cacheDir: string,
    /** Where combat sims run; main passes a worker thread. Without one, they run inline. */
    private simulate?: Simulator,
  ) {
    super()
    this.freshModel()
  }

  /** Throw away all game state (new Hearthstone session, or Hearthstone closed). */
  private freshModel() {
    // What you see (in step with animations) + a lookahead copy with full details.
    this.game = new Game('PowerTaskList')
    this.lookahead = new Game('GameState')
    this.bg = new BgGame(this.game, this.cards, this.lookahead)
    this.bg.simIterations = this.store.settings.simIterations
    this.bg.simulate = this.simulate
    this.bg.onChange = () => this.schedulePublish()
    this.bg.onMatchEnd = (m) => {
      if (this.endedDuringReplay) return // finished before we started watching; avoid duplicates
      // Saved 4s after the game ends, long before the next hero select resets
      // the screen tribes.
      this.store.addMatch({ ...m, tribes: this.screenTribes })
      this.emit('data')
    }
    this.bg.onMatchUpdated = () => {
      this.store.saveMatches()
      this.emit('data')
    }
    this.game.on((e) => {
      if (e.type === 'gameStart') {
        this.overSince = undefined
        this.endedDuringReplay = false
        this.stopHighlights()
        this.selectedBuildId = undefined
        this.buildPromptAnswered = false
        this.beginGame(`${this.logDir}|${this.currentLine}`)
      }
      if (e.type === 'gameEnd') {
        this.endedDuringReplay = this.catchingUp
        this.overSince = this.catchingUp ? 0 : Date.now()
        if (this.lingerTimer) clearTimeout(this.lingerTimer)
        this.lingerTimer = setTimeout(() => this.publish(), GAME_OVER_LINGER_MS + 100)
      }
    })
    // The minion-type banner is only on screen while you're choosing, so the
    // read starts when the heroes are offered — not at MULLIGAN_STATE=DONE,
    // which is the moment the screen is dismissed (measured on a real game:
    // heroes offered 11:19:59, DONE 11:21:08, first shop 0.4s after that).
    //
    // Watched on the GameState stream: PowerTaskList logs the offered heroes as
    // "FULL_ENTITY - Updating" of entities it already knows, so they never count
    // as created there. And GameState can run thousands of lines ahead of
    // PowerTaskList's CREATE_GAME, so the per-game reset lives here too, or the
    // late gameStart would cancel the read it just started.
    this.lookahead.on((e) => {
      if (e.type === 'gameStart') {
        this.stopTribeRead()
        this.screenTribes = []
      }
      // Heroes created later in the game (seen live) carry the tag too; the
      // banner is long gone by then.
      if (e.type === 'created' && e.entity.tags.BACON_HERO_CAN_BE_DRAFTED === '1' && !this.catchingUp && !this.lookaheadHeroPicked) this.startTribeRead()
    })
    this.overSince = undefined
  }

  /**
   * Load the card data. Main calls this before creating any window: parsing
   * the ~5MB cache blocks for ~40ms, and once an overlay is up its mouse hook
   * makes that a frozen cursor (seen with --profile).
   */
  async loadCards() {
    if (this.cardsLoaded) return
    this.cardsLoaded = true
    try {
      await this.cards.init(this.cacheDir)
      mark('cards loaded')
    } catch (err) {
      console.error('Could not load card data', err)
    }
  }

  async start() {
    if (!this.store.settings.hearthstonePath) {
      this.store.updateSettings({ hearthstonePath: await findInstallPath() })
    }
    await this.loadCards()
    this.logConfigOk = await checkLogConfig(this.store.settings.hearthstonePath)
    // Logging already switched on but the size-limit fix missing (older versions of this app
    // wrote it to the wrong file): repair it, since the user has already opted in.
    if (!this.logConfigOk && existsSync(logConfigPath())) {
      await ensureLogConfig(this.store.settings.hearthstonePath).catch((err) => console.warn('log config repair failed', err))
      this.logConfigOk = await checkLogConfig(this.store.settings.hearthstonePath)
    }
    mark('log config checked')
    await this.attachToLogs()
    mark('attached to logs')
    // Hearthstone creates a new log folder each launch; keep checking.
    this.dirTimer = setInterval(() => void this.attachToLogs(), 5000)
    this.publish()
  }

  stop() {
    if (this.dirTimer) clearInterval(this.dirTimer)
    this.powerTail?.stop()
    this.stopTribeRead()
    this.stopHighlights()
    void stopVision()
  }

  setSimIterations(n: number) {
    this.bg.simIterations = n
  }

  /** Choose a build for this game, or `null` to dismiss the prompt without one. */
  selectBuild(id: string | null) {
    this.selectedBuildId = id ?? undefined
    this.buildPromptAnswered = true
    this.rememberChoice()
    this.publish()
  }

  /**
   * A game has started, or is being replayed after a restart. Restarting the
   * tracker mid-game used to lose the build being followed; the answer is now
   * kept per game, keyed by the log folder (one per Hearthstone launch) and
   * the timestamped CREATE_GAME line, which a replay sees again unchanged.
   */
  private beginGame(key: string) {
    this.gameKey = key
    const c = this.store.buildChoice
    if (c.game !== key) {
      // GameState runs ahead of PowerTaskList, so the tribes may have been
      // read already, and saved under the last game's key; save them under
      // this one.
      if (this.screenTribes.length) this.rememberChoice()
      return
    }
    this.selectedBuildId = c.buildId
    this.buildPromptAnswered = c.answered
    // A restart mid-game: the banner's long gone, so this is the only copy.
    if (c.tribes?.length) this.screenTribes = c.tribes
  }

  private rememberChoice() {
    if (this.gameKey) this.store.setBuildChoice({ game: this.gameKey, buildId: this.selectedBuildId, answered: this.buildPromptAnswered, tribes: this.screenTribes })
  }

  // ------------------------------------------------------------- log plumbing

  /**
   * Re-read the logging config and republish if the answer moved. The config can
   * change under us at any time — our own repair during start(), the Setup page,
   * a new install path, or the user editing log.config by hand — and a stale
   * `setup-needed` snapshot leaves the banner up for good, since nothing else
   * recomputes it.
   */
  private async refreshLogConfig() {
    const ok = await checkLogConfig(this.store.settings.hearthstonePath)
    if (ok === this.logConfigOk) return
    this.logConfigOk = ok
    this.publish()
  }

  private async attachToLogs() {
    await this.refreshLogConfig()
    const dir = await findActiveLogDir(this.store.settings.hearthstonePath)
    if (dir !== this.logDir) {
      // New Hearthstone session: everything from the old log is stale.
      this.powerTail?.stop()
      this.powerTail = undefined
      this.lineQueue = [] // the old log's; never feed them to the new model
      this.moreComing = false
      this.logDir = dir
      this.powerLogIsNew = false
      this.freshModel()
      this.publish()
    }
    if (this.logStalled !== this.wasStalled) {
      this.wasStalled = this.logStalled
      this.publish()
    }
    // Hearthstone closed mid-game: don't leave the overlay stuck on that game.
    if (this.game.inGame && !(await isHearthstoneRunning())) {
      this.bg.flushPendingMatch()
      this.freshModel()
      this.publish()
    }
    if (!dir || this.powerTail) return
    // Power.log is only created when the first match of the session starts.
    const powerPath = join(dir, 'Power.log')
    if (!existsSync(powerPath)) {
      this.powerLogIsNew = true
      return
    }

    // Replay only the latest game, then follow live.
    const offset = await lastGameOffset(powerPath)
    mark('found the last game in Power.log')
    let first = !this.powerLogIsNew
    // The replayed history is old: judge staleness by when the file was last written.
    this.lastLineAt = statSync(powerPath).mtimeMs
    // The catch-up is the whole first read, which arrives a chunk at a time.
    this.powerTail = new LogTail(powerPath, (lines, more) => {
      if (!first) this.lastLineAt = Date.now()
      this.feed(lines, first, more)
      if (!more) first = false
    })
    this.powerTail.start(offset)
    this.publish()
  }

  /** Feed log lines to both models. `catchingUp` marks the replay of a game already under way. */
  /**
   * Hand lines to ingest() a slice at a time, yielding to the event loop
   * between slices. The replay of a game in progress is ~170k lines, ~0.7s in
   * one go, and the main thread carries a system-wide mouse hook (CLAUDE.md):
   * the user's cursor froze for all of it. Lines that arrive meanwhile queue
   * behind, so order is kept, and nothing is published until the queue is empty,
   * so a half-replayed game never reaches the overlays.
   */
  private feed(lines: string[], catchingUp: boolean, more = false) {
    this.moreComing = more
    this.lineQueue.push({ lines, catchingUp, at: 0 })
    if (this.lineQueue.length === 1) this.drain()
  }

  private drain() {
    const end = performance.now() + SLICE_MS
    let replayed = false
    while (this.lineQueue.length && performance.now() < end) {
      const job = this.lineQueue[0]
      replayed ||= job.catchingUp
      this.ingest(job.lines.slice(job.at, job.at + SLICE_LINES), job.catchingUp)
      job.at += SLICE_LINES
      if (job.at >= job.lines.length) this.lineQueue.shift()
    }
    if (this.lineQueue.length) setImmediate(() => this.drain())
    else if (replayed && !this.moreComing) mark('log caught up')
  }

  private ingest(lines: string[], catchingUp: boolean) {
    this.catchingUp = catchingUp
    let changed = false
    for (const l of lines) {
      this.currentLine = l
      this.lookahead.handleLine(l)
      changed = this.game.handleLine(l) || changed
    }
    this.catchingUp = false
    if (changed) this.schedulePublish()
  }

  /**
   * Poll the hero-select screen until the banner reads, starting the moment the
   * heroes are offered. One shot isn't enough: the plate slides in, so an early
   * capture finds a half-drawn banner (or none yet; that costs a capture and a
   * colour scan, ~15ms, with no OCR). Done once a read adds nothing new, i.e.
   * two reads agree, so OCR runs only a few times.
   *
   * Fire-and-forget throughout — a slow or failed read must never hold up log
   * parsing, and giving up just leaves the lobby's tribes unknown.
   */
  private startTribeRead() {
    if (this.tribeReading) return
    this.tribeReading = true
    // Bumped by stopTribeRead, so a read still in flight from a cancelled
    // loop (a new game started) is thrown away.
    const gen = ++this.tribeGen
    let attempts = 0
    const tick = async () => {
      this.tribeTimer = undefined
      attempts++
      const tribes = await readLobbyTribes(this.cacheDir).catch((err) => {
        console.warn('could not read tribes from the hero-select screen', err)
        return [] as string[]
      })
      if (gen !== this.tribeGen) return
      let settled = false
      if (tribes.length) {
        // Accumulate rather than take the first answer. A capture during the
        // plate's slide-in, or one the OCR only half-read, gives a partial
        // list; a later pass fills it in. Tribes never leave a lobby, so
        // growing the set is always right.
        const merged = [...new Set([...this.screenTribes, ...tribes])].sort()
        if (merged.length !== this.screenTribes.length) {
          this.screenTribes = merged
          this.rememberChoice()
          this.publish()
        } else settled = true
      }
      // Stop once the hero is locked in, too: the banner has gone, and anything
      // read after that is some other screen.
      if (settled || attempts >= TRIBE_READ_ATTEMPTS || this.lookaheadHeroPicked) {
        this.tribeReading = false
        stopCapture()
        return
      }
      this.tribeTimer = setTimeout(() => void tick(), TRIBE_READ_INTERVAL_MS)
    }
    void tick()
  }

  private stopTribeRead() {
    this.tribeGen++
    if (!this.tribeReading) return
    this.tribeReading = false
    clearTimeout(this.tribeTimer)
    this.tribeTimer = undefined
    stopCapture()
  }



  /**
   * Work out where to draw boxes over the tavern, when there's anything worth
   * pointing at.
   *
   * While a wanted minion is on offer, the screen is re-read about once a
   * second rather than once per change. The log can't say where cards *are*:
   * buying a card or a spell re-centres the tavern without the wanted card's
   * slot number changing, and log updates land while cards are still sliding.
   * Polling also retries a capture that found nothing. Any change to what's on
   * offer clears the boxes at once, so a stale box never sits on the wrong
   * card while the next read is pending.
   */
  private refreshHighlights(base: Omit<BgSnapshot, 'status' | 'statusDetail' | 'shopHighlights' | 'tribes'>, build: Build | undefined) {
    // Counted, not sets: a stage can want two copies of a minion, so the second
    // stays worth boxing after you've bought the first. Wanted is the most
    // copies any one stage (or the addons) asks for.
    const baseId = (m: BoardMinion) => m.normalId ?? m.cardId.replace(/_G$/, '')
    const wanted = new Map<string, number>()
    for (const ids of build ? [...build.targets.map((t) => t.cardIds), build.addons ?? []] : []) {
      const n = new Map<string, number>()
      for (const id of ids) n.set(id.replace(/_G$/, ''), (n.get(id.replace(/_G$/, '')) ?? 0) + 1)
      for (const [id, k] of n) wanted.set(id, Math.max(k, wanted.get(id) ?? 0))
    }
    // In hand counts: it's bought, just not played yet.
    const owned = new Map<string, number>()
    for (const m of [...base.board, ...base.hand]) owned.set(baseId(m), (owned.get(baseId(m)) ?? 0) + 1)
    const wants = (m: BoardMinion) => (wanted.get(baseId(m)) ?? 0) > (owned.get(baseId(m)) ?? 0)
    // The debug setting boxes every minion on offer, so the placement can be
    // checked without waiting for a build's minion to turn up.
    const debug = this.store.settings.overlay.debugHighlights
    const targets = base.phase === 'shop' ? base.shop.filter((m) => debug || wants(m)).map((m) => ({ ...m, debug: !wants(m) })) : []

    // The whole tavern, not just the wanted cards: buying anything moves them.
    const key = `${base.shop.map((m) => `${m.pos}:${m.cardId}`).join(',')}|${targets.map((m) => m.cardId).join(',')}`
    if (key !== this.highlightKey) {
      this.highlightKey = key
      this.highlightTargets = targets
      this.highlights = []
      this.highlightPending = ''
    }
    if (targets.length && !this.highlightLoop) {
      this.highlightLoop = true
      this.highlightTimer = setTimeout(() => void this.readHighlights(), HIGHLIGHT_SETTLE_MS)
    }
  }

  /** One pass of the highlight loop: read the tavern, redraw, go again while it's wanted. */
  private async readHighlights() {
    this.highlightTimer = undefined
    const key = this.highlightKey
    const targets = this.highlightTargets
    try {
      if (!targets.length) return
      const [geo, win] = await Promise.all([readShopSlots(), getGameWindowRect()])
      // No game window (minimised): drop the boxes rather than keep them, so
      // restoring it has to find and confirm them afresh, and that publish is
      // what brings the hidden highlight layer back.
      if (!win && this.highlights.length) {
        this.highlights = []
        this.highlightPending = ''
        this.publish()
      }
      // A failed read leaves no boxes, and the next pass tries again.
      if (!geo || !win || key !== this.highlightKey) return
      // Duos, looking at your teammate's board: your boxes would land on their
      // tavern (seen live). Clear them; reads go on, so they come back with
      // your board.
      if (geo.teammateView) {
        this.highlightPending = ''
        if (this.highlights.length) {
          this.highlights = []
          this.publish()
        }
        return
      }
      // Boxes are matched to cards by slot number, so the screen has to show
      // the same number of cards as the log, spells included. Seen live, a box
      // landed on a spell: a missed end shield shifts every slot one over, and
      // after a purchase the log updates at once while the cards are still
      // sliding. Either way, wait for a read where they agree.
      if (geo.slots.length !== this.bg.tavernSize()) return
      // The frame is the captured part of the window, resized; the boxes are
      // drawn over the client area. So scale by the captured size, then shift
      // by where the client area sits inside it: in windowed mode the frame
      // includes the title bar (seen live: boxes a title bar too high), in
      // fullscreen the two are the same and the shift is zero.
      const sx = win.captured.width / geo.frame.width
      const sy = win.captured.height / geo.frame.height
      const ox = win.captured.x - win.x
      const oy = win.captured.y - win.y
      const boxes = targets.flatMap((m) => {
        const r = geo.slots[(m.pos ?? 0) - 1]
        return r ? [{ x: Math.round(r.x * sx + ox), y: Math.round(r.y * sy + oy), width: Math.round(r.width * sx), height: Math.round(r.height * sy), ...(m.debug && { debug: true }) }] : []
      })
      // Reads continue all shop: the tavern can move after it looks settled
      // (seen live: after a spell was bought, the cards held their old places
      // for a moment, then re-centred). A position counts once two reads in a
      // row agree, so a one-read blip doesn't move the boxes: a freeze makes
      // the cards hop, and a read mid-hop put them there and back.
      const seen = JSON.stringify(boxes)
      const confirmed = seen === this.highlightPending
      this.highlightPending = seen
      if (!confirmed || seen === JSON.stringify(this.highlights)) return
      this.highlights = boxes
      this.publish()
    } catch (err) {
      console.warn('could not locate the tavern on screen', err)
    } finally {
      if (this.highlightTargets.length) this.highlightTimer = setTimeout(() => void this.readHighlights(), HIGHLIGHT_POLL_MS)
      else {
        this.highlightLoop = false
        // Nothing left to box: close the stream until the next shop needs it.
        stopCapture()
      }
    }
  }

  private stopHighlights() {
    if (this.highlightLoop) stopCapture()
    if (this.highlightTimer) clearTimeout(this.highlightTimer)
    this.highlightTimer = undefined
    this.highlightLoop = false
    this.highlightTargets = []
    this.highlights = []
    this.highlightPending = ''
    this.highlightKey = ''
  }

  // ------------------------------------------------------------- snapshots

  private schedulePublish() {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.publish()
    }, 60)
  }

  publish() {
    if (!profiling) return this.publishNow()
    const t0 = performance.now()
    this.publishNow()
    const ms = performance.now() - t0
    if (ms > 16) mark(`publish took ${ms.toFixed(0)}ms`)
  }

  private publishNow() {
    // Mid-replay: wait for the rest, so a half-replayed game never shows.
    if ((this.lineQueue.length || this.moreComing) && this.lastSnapshot) return this.schedulePublish()
    const base = this.bg.snapshot()
    let status: BgSnapshot['status']
    let statusDetail: string | undefined
    if (!this.logConfigOk) {
      status = 'setup-needed'
      statusDetail = 'Hearthstone logging is not enabled yet.'
    } else if (!this.powerTail) {
      status = 'waiting-for-logs'
      statusDetail = this.logDir ? 'Hearthstone is running – start a Battlegrounds game and the overlay will appear.' : 'Waiting for Hearthstone to start…'
    } else if (this.logStalled) {
      status = 'waiting-for-logs'
      statusDetail = 'Hearthstone stopped writing its game log mid-game. Restart Hearthstone to resume tracking (the logging fix applies on restart).'
    } else if (this.game.phase === 'none') {
      status = 'idle'
      statusDetail = 'Waiting for a Battlegrounds game.'
    } else if (!this.bg.isBattlegrounds) {
      status = 'not-battlegrounds'
      statusDetail = 'This tracker only follows Battlegrounds games.'
    } else if (this.game.phase === 'over') {
      // Show the result briefly, then step aside until the next game.
      const lingering = this.overSince !== undefined && Date.now() - this.overSince < GAME_OVER_LINGER_MS
      status = lingering ? 'game-over' : 'idle'
      if (!lingering) statusDetail = 'Waiting for your next Battlegrounds game.'
    } else {
      status = 'in-game'
    }
    const tribes = this.screenTribes
    const selectedBuild = this.store.builds.find((b) => b.id === this.selectedBuildId)
    const inCombat = base.phase === 'combat'
    const buildPrompt = buildsToOffer(this.store.builds, tribes, {
      heroPicked: this.heroPicked,
      answered: this.buildPromptAnswered,
      hasSelection: !!selectedBuild,
      inGame: status === 'in-game',
      inCombat,
    })
    // Reaching a fight after the hero pick answers the prompt, as if "Not this
    // game" had been clicked: it doesn't come back next shop, and the lobby
    // overlay offers "Pick a build" instead.
    if (inCombat && this.heroPicked && !this.buildPromptAnswered) {
      this.buildPromptAnswered = true
      this.rememberChoice()
    }
    const buildPickable = canPickBuild(this.store.builds, buildPrompt, {
      heroPicked: this.heroPicked,
      hasSelection: !!selectedBuild,
      inGame: status === 'in-game',
    })
    this.refreshHighlights(base, selectedBuild)
    const snap: BgSnapshot = { ...base, status, statusDetail, tribes, selectedBuild, buildPrompt, buildPickable, shopHighlights: this.highlights }
    this.lastSnapshot = snap
    this.emit('snapshot', snap)
  }

  snapshot(): BgSnapshot {
    if (!this.lastSnapshot) this.publish()
    return this.lastSnapshot!
  }

  // ------------------------------------------------------------- setup

  async setupStatus(): Promise<SetupStatus> {
    const path = this.store.settings.hearthstonePath
    await this.refreshLogConfig()
    return {
      hearthstonePath: path,
      installFound: installLooksValid(path),
      logConfigOk: this.logConfigOk,
      logConfigPath: logConfigPath(),
      activeLogDir: this.logDir,
      powerLogFound: !!this.powerTail,
      cardDbLoaded: this.cards.size > 0,
      cardCount: this.cards.size,
    }
  }

  async fixLogConfig() {
    await ensureLogConfig(this.store.settings.hearthstonePath)
    await this.refreshLogConfig()
  }

  async setInstallPath(path: string) {
    this.store.updateSettings({ hearthstonePath: path })
    this.logDir = undefined
    await this.attachToLogs()
  }
}
