// Types shared between the main process, preload and renderer.

export interface CardInfo {
  id: string
  dbfId: number
  name: string
  cost: number
  rarity?: string
  cardClass?: string
  type?: string
  set?: string
  text?: string
  attack?: number
  health?: number
  techLevel?: number
  races?: string[]
  mechanics?: string[]
  /** Part of the Battlegrounds tavern pool. */
  pool?: boolean
  /** Card id of the golden version (for pool minions). */
  goldenId?: string
  /** For golden cards: the normal version's card id. */
  normalId?: string
  bgHero?: boolean
  duosOnly?: boolean
}

export type GameMode = 'solo' | 'duos'
export type CombatResult = 'WON' | 'LOST' | 'TIED'

/** A minion as shown on a board. */
export interface BoardMinion {
  cardId: string
  name: string
  atk: number
  health: number
  tier: number
  golden: boolean
  taunt?: boolean
  divineShield?: boolean
  reborn?: boolean
  venomous?: boolean
  windfury?: boolean
  stealth?: boolean
}

export interface SimOdds {
  win: number
  tie: number
  loss: number
  /** Average damage dealt to the opponent when we win. */
  avgDamageDealt: number
  /** Average damage we take when we lose. */
  avgDamageTaken: number
  /** Chance this fight kills us (our hero health + armor). */
  lethalLoss: number
  /** Chance this fight kills the opponent. */
  lethalWin: number
  iterations: number
  ms: number
  /** Names of minions whose effects the simulator can't model yet. */
  unsupported: string[]
  /** Duos: a teammate's warband wasn't known, so only the current boards were simulated. */
  partial?: boolean
}

export interface CombatRound {
  round: number
  opponentPlayerId?: number
  opponentHeroCardId?: string
  opponentHeroName?: string
  myBoard: BoardMinion[]
  oppBoard: BoardMinion[]
  /** Duos: teammates' warbands that come in when the first ones die. */
  myReserve?: BoardMinion[]
  myReserveHeroCardId?: string
  oppReserve?: BoardMinion[]
  oppReserveHeroCardId?: string
  odds?: SimOdds
  result?: CombatResult
  damage?: number
}

export interface LobbyPlayer {
  playerId: number
  heroCardId: string
  heroName: string
  health: number
  armor: number
  tier: number
  triples: number
  place: number
  team?: number
  isMe: boolean
  isTeammate: boolean
  isNextOpponent: boolean
  dead: boolean
  lastBoard?: { round: number; minions: BoardMinion[] }
  /** Result of our most recent fight against this player. */
  lastResult?: CombatResult
}

export type TrackerStatus = 'setup-needed' | 'waiting-for-logs' | 'idle' | 'in-game' | 'game-over' | 'not-battlegrounds'

export interface BgSnapshot {
  status: TrackerStatus
  statusDetail?: string
  mode?: GameMode
  round: number
  phase: 'none' | 'shop' | 'combat' | 'over'
  me?: LobbyPlayer
  lobby: LobbyPlayer[]
  /** Tribes seen in the tavern / on boards this game. */
  tribes: string[]
  /** Your current board (during shop: your warband; during combat: the fighting copy). */
  board: BoardMinion[]
  combat?: CombatRound
  rounds: CombatRound[]
  placement?: number
  /** The build being followed this game, if one was chosen. */
  selectedBuild?: Build
  /** Builds worth offering: set once after the hero is picked, cleared once answered. */
  buildPrompt?: Build[]
}

export interface BgMatch {
  id: string
  startedAt: number
  endedAt: number
  mode: GameMode
  heroCardId: string
  heroName: string
  placement: number
  rounds: number
  tribes: string[]
  finalBoard: BoardMinion[]
  teammateHeroCardId?: string
  combats: CombatRound[]
}

/** One step of a build: the board you want to have by a given turn. */
export interface BuildTarget {
  byTurn: number
  /** Card ids, in the order they should sit on the board. At most 7. */
  cardIds: string[]
}

/** A planned warband for one tribe, in stages. */
export interface Build {
  id: string
  name: string
  /**
   * Tribe this build is for, e.g. 'MURLOC' — matched against the lobby's
   * tribes. Empty means it isn't tied to one tribe (a Menagerie board), so it's
   * offered in every lobby.
   */
  tribe: string
  /** Ordered by byTurn, earliest first. */
  targets: BuildTarget[]
  /** Set when the build was started from someone else's published comp. */
  source?: { name: string; url: string }
}

/** A community composition from HSReplay's Battlegrounds comps list. */
export interface Comp {
  id: number
  name: string
  /** Race code, or '' for a comp that isn't tied to one tribe. */
  tribe: string
  summary: string
  /** 1 = S, 2 = A, 3 = B. */
  tier: number
  difficulty: number
  /** The comp's core minions, resolved to card ids we know about. */
  cardIds: string[]
  url: string
}

export interface OverlaySettings {
  enabled: boolean
  opacity: number
  scale: number
  showOdds: boolean
  showLobby: boolean
  /** When locked the overlays ignore the mouse (click-through). */
  locked: boolean
}

export interface Settings {
  hearthstonePath: string
  simIterations: number
  overlay: OverlaySettings
}

export interface SetupStatus {
  hearthstonePath: string
  installFound: boolean
  logConfigOk: boolean
  logConfigPath: string
  activeLogDir?: string
  powerLogFound: boolean
  cardDbLoaded: boolean
  cardCount: number
}
