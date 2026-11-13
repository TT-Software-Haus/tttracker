import { existsSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { CardDb } from './cards/cardDb'
import { Game } from './game/game'
import { BgGame } from './bg/bgGame'
import { checkLogConfig, ensureLogConfig, findActiveLogDir, findInstallPath, installLooksValid, logConfigPath } from './logs/hsPaths'
import { LogTail, lastGameOffset } from './logs/logTail'
import { readLobbyTribes, stopVision } from './vision/heroSelect'
import type { Store } from './store'
import type { BgSnapshot, Build, SetupStatus } from '../shared/types'

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
  state: { heroPicked: boolean; answered: boolean; hasSelection: boolean; inGame: boolean },
): Build[] | undefined {
  if (!state.heroPicked || state.answered || state.hasSelection || !state.inGame) return undefined
  const matching = builds.filter((b) => tribes.includes(b.tribe))
  return matching.length ? matching : undefined
}

/**
 * Finds the logs, tails Power.log, feeds the game model and publishes
 * snapshots. Emits 'snapshot' (BgSnapshot) and 'data' (match history changed).
 */
const GAME_OVER_LINGER_MS = 30_000
/** Hero select lasts ~70s; retry the banner read across it, then give up. */
const TRIBE_READ_ATTEMPTS = 12
const TRIBE_READ_INTERVAL_MS = 2500
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
  private logDir?: string
  private dirTimer?: NodeJS.Timeout
  private emitTimer?: NodeJS.Timeout
  private catchingUp = false
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
  /** Tribes read off the hero-select screen; merged with the ones the log reveals later. */
  private screenTribes: string[] = []
  private heroPicked = false
  private selectedBuildId?: string
  /** Set once the prompt has been answered or dismissed, so it doesn't come back. */
  private buildPromptAnswered = false
  private tribeTimer?: NodeJS.Timeout

  constructor(
    private store: Store,
    private cacheDir: string,
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
    this.bg.onChange = () => this.schedulePublish()
    this.bg.onMatchEnd = (m) => {
      if (this.endedDuringReplay) return // finished before we started watching; avoid duplicates
      this.store.addMatch(m)
      this.emit('data')
    }
    this.game.on((e) => {
      if (e.type === 'gameStart') {
        this.overSince = undefined
        this.endedDuringReplay = false
        this.stopTribeRead()
        this.screenTribes = []
        this.heroPicked = false
        this.selectedBuildId = undefined
        this.buildPromptAnswered = false
      }
      // The minion-type banner is only on screen while you're choosing, so the
      // read starts when the heroes are offered — not at MULLIGAN_STATE=DONE,
      // which is the moment the screen is dismissed (measured on a real game:
      // heroes offered 11:19:59, DONE 11:21:08, first shop 0.4s after that).
      if (e.type === 'created' && e.entity.tags.BACON_HERO_CAN_BE_DRAFTED === '1' && !this.catchingUp) this.startTribeRead()
      // In Battlegrounds the mulligan *is* the hero choice, so DONE means the
      // hero is locked — which is when a build becomes worth offering.
      if (e.type === 'tag' && e.tag === 'MULLIGAN_STATE' && e.value === 'DONE' && !this.heroPicked && !this.catchingUp) {
        if (e.entity === this.game.playerEntity(this.game.friendlyPlayerId)) {
          this.heroPicked = true
          this.schedulePublish()
        }
      }
      if (e.type === 'gameEnd') {
        this.endedDuringReplay = this.catchingUp
        this.overSince = this.catchingUp ? 0 : Date.now()
        if (this.lingerTimer) clearTimeout(this.lingerTimer)
        this.lingerTimer = setTimeout(() => this.publish(), GAME_OVER_LINGER_MS + 100)
      }
    })
    this.overSince = undefined
  }

  async start() {
    if (!this.store.settings.hearthstonePath) {
      this.store.updateSettings({ hearthstonePath: await findInstallPath() })
    }
    try {
      await this.cards.init(this.cacheDir)
    } catch (err) {
      console.error('Could not load card data', err)
    }
    this.logConfigOk = await checkLogConfig(this.store.settings.hearthstonePath)
    // Logging already switched on but the size-limit fix missing (older versions of this app
    // wrote it to the wrong file): repair it, since the user has already opted in.
    if (!this.logConfigOk && existsSync(logConfigPath())) {
      await ensureLogConfig(this.store.settings.hearthstonePath).catch((err) => console.warn('log config repair failed', err))
      this.logConfigOk = await checkLogConfig(this.store.settings.hearthstonePath)
    }
    await this.attachToLogs()
    // Hearthstone creates a new log folder each launch; keep checking.
    this.dirTimer = setInterval(() => void this.attachToLogs(), 5000)
    this.publish()
  }

  stop() {
    if (this.dirTimer) clearInterval(this.dirTimer)
    this.powerTail?.stop()
    this.stopTribeRead()
    void stopVision()
  }

  setSimIterations(n: number) {
    this.bg.simIterations = n
  }

  /** Choose a build for this game, or `null` to dismiss the prompt without one. */
  selectBuild(id: string | null) {
    this.selectedBuildId = id ?? undefined
    this.buildPromptAnswered = true
    this.publish()
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
      this.logDir = dir
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
    if (!existsSync(powerPath)) return

    // Replay only the latest game, then follow live.
    const offset = await lastGameOffset(powerPath)
    let first = true
    // The replayed history is old: judge staleness by when the file was last written.
    this.lastLineAt = statSync(powerPath).mtimeMs
    this.powerTail = new LogTail(powerPath, (lines) => {
      this.catchingUp = first
      if (!first) this.lastLineAt = Date.now()
      first = false
      let changed = false
      for (const l of lines) {
        this.lookahead.handleLine(l)
        changed = this.game.handleLine(l) || changed
      }
      this.catchingUp = false
      if (changed) this.schedulePublish()
    })
    this.powerTail.start(offset)
    this.publish()
  }

  /**
   * Poll the hero-select screen until the banner reads. One shot isn't enough:
   * the plate slides in, so an early capture finds a half-drawn banner. Hero
   * select lasts a minute or so, which is plenty of room to retry.
   *
   * Fire-and-forget throughout — a slow or failed read must never hold up log
   * parsing, and giving up just means falling back to the log's own tribe list.
   */
  private startTribeRead() {
    if (this.tribeTimer || this.screenTribes.length) return
    let attempts = 0
    const tick = async () => {
      this.tribeTimer = undefined
      attempts++
      const tribes = await readLobbyTribes(this.cacheDir).catch((err) => {
        console.warn('could not read tribes from the hero-select screen', err)
        return [] as string[]
      })
      if (tribes.length) {
        this.screenTribes = tribes
        this.publish()
        return
      }
      // Stop once the hero is locked in: the banner has gone, and anything we
      // read after that is some other screen.
      if (attempts >= TRIBE_READ_ATTEMPTS || this.heroPicked) return
      this.tribeTimer = setTimeout(() => void tick(), TRIBE_READ_INTERVAL_MS)
    }
    this.tribeTimer = setTimeout(() => void tick(), TRIBE_READ_INTERVAL_MS)
  }

  private stopTribeRead() {
    if (this.tribeTimer) clearTimeout(this.tribeTimer)
    this.tribeTimer = undefined
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
    const tribes = this.screenTribes.length ? [...new Set([...base.tribes, ...this.screenTribes])].sort() : base.tribes
    const selectedBuild = this.store.builds.find((b) => b.id === this.selectedBuildId)
    const buildPrompt = buildsToOffer(this.store.builds, tribes, {
      heroPicked: this.heroPicked,
      answered: this.buildPromptAnswered,
      hasSelection: !!selectedBuild,
      inGame: status === 'in-game',
    })
    const snap: BgSnapshot = { ...base, status, statusDetail, tribes, selectedBuild, buildPrompt }
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
