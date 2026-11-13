# API reference

Every exported symbol, by module. Signatures are copied from source; private members
are listed only where they're load-bearing for understanding the flow.

---

## `src/shared/types.ts`

Pure types. See [ipc-and-data.md](ipc-and-data.md#shared-types--srcsharedtypests) for
field-level descriptions.

| Export | Kind |
| --- | --- |
| `CardInfo` | interface |
| `GameMode` | `'solo' \| 'duos'` |
| `CombatResult` | `'WON' \| 'LOST' \| 'TIED'` |
| `TrackerStatus` | `'setup-needed' \| 'waiting-for-logs' \| 'idle' \| 'in-game' \| 'game-over' \| 'not-battlegrounds'` |
| `BoardMinion` | interface |
| `SimOdds` | interface |
| `CombatRound` | interface |
| `LobbyPlayer` | interface |
| `BgSnapshot` | interface |
| `BgMatch` | interface |
| `BuildTarget`, `Build` | interface |
| `Comp` | interface |
| `OverlaySettings`, `Settings` | interface |
| `SetupStatus` | interface |

---

## `src/main/logs/hsPaths.ts`

| Export | Signature | Notes |
| --- | --- | --- |
| `DEFAULT_INSTALL` | `const string` | `C:\Program Files (x86)\Hearthstone` |
| `logConfigPath()` | `(): string` | `%LOCALAPPDATA%\Blizzard\Hearthstone\log.config`, falls back to `%USERPROFILE%\AppData\Local\…` |
| `findInstallPath()` | `(): Promise<string>` | Default path → `reg query` on two uninstall keys → default anyway |
| `installLooksValid(path)` | `(string): boolean` | `Hearthstone.exe` exists under `path` |
| `findActiveLogDir(installPath)` | `(string): Promise<string \| undefined>` | Newest `Hearthstone_YYYY_MM_DD_HH_MM_SS` folder under `Logs/`; falls back to `Logs/` itself |
| `clientConfigPaths(installPath)` | `(string): string[]` | Both candidate `client.config` locations — the app writes both |
| `checkLogConfig(installPath)` | `(string): Promise<boolean>` | `[Power] FilePrinting=true` + `Verbose=true` **and** `Log.FileSizeLimit.Int=-1` in every client.config |
| `ensureLogConfig(installPath)` | `(string): Promise<void>` | Backs up, rewrites `log.config`, writes both `client.config`s |

Module constants: `REQUIRED_SECTIONS = ['Power']`, `OBSOLETE_SECTIONS = ['Zone']`.

---

## `src/main/logs/logTail.ts`

| Export | Signature |
| --- | --- |
| `LogTail` | `class` |
| `lastGameOffset(path)` | `(string): Promise<number>` |

### `class LogTail`

| Member | Signature | Notes |
| --- | --- | --- |
| constructor | `(path: string, onLines: (lines: string[]) => void, intervalMs = 150)` | |
| `start(fromOffset = 0)` | `(number): void` | Resets offset + partial, polls immediately, then on the interval |
| `stop()` | `(): void` | Clears the interval |

`lastGameOffset` scans for the last `GameState.DebugPrintPower() - CREATE_GAME` and
returns the byte after the preceding newline. No match → file length. Error → `0`.

---

## `src/main/cards/cardDb.ts`

| Export | Signature |
| --- | --- |
| `CardDb` | `class` |
| `slim(raw)` | `(RawCard[]): CardInfo[]` |

### `class CardDb`

| Member | Signature | Notes |
| --- | --- | --- |
| `get size` | `number` | Cards loaded |
| `get(cardId)` | `(string \| undefined): CardInfo \| undefined` | |
| `byDbfId(dbfId)` | `(number): CardInfo \| undefined` | |
| `bgMinionsNamed(name)` | `(string): CardInfo[]` | Case-insensitive; BG minions only. Used by the simulator to summon tokens by name |
| `bgSpellNamed(name)` | `(string): CardInfo \| undefined` | Tavern spells cast mid-combat |
| `bgMinions()` | `(): CardInfo[]` | All BG minions incl. tokens and rotated cards |
| `pool()` | `(): CardInfo[]` | Current tavern pool only; also the `cards:pool` IPC payload |
| `shareList()` | `(): CardInfo[]` | Non-golden BG minions sorted by `dbfId`, memoised (reset by `load`). The index space for build codes — only stable while new cards append |
| `shareIndexOf(cardId)` | `(string): number \| undefined` | Position in `shareList()` |
| `shareCardAt(index)` | `(number): string \| undefined` | Card id at that position |
| `load(cards)` | `(CardInfo[]): void` | Builds `byId`, `byDbf`, `bgByName`, `bgSpells`. Tests call this directly with a fixture |
| `init(cacheDir)` | `(string): Promise<void>` | Cache-first load, refresh if older than 24 h |

Constants: `CARDS_URL = https://api.hearthstonejson.com/v1/latest/enUS/cards.json`,
`MAX_AGE_MS = 24 h`, cache file `cards-v2.json`.

---

## `src/main/game/game.ts`

| Export | Kind |
| --- | --- |
| `Entity` | `{ id: number; cardId: string; tags: Record<string, string> }` |
| `GameInfo` | `{ gameType?, formatType?, buildNumber? }` |
| `GameEvent` | union — see below |
| `PowerSource` | `'GameState' \| 'PowerTaskList'` |
| `Game` | `class` |

```ts
type GameEvent =
  | { type: 'gameStart' }
  | { type: 'gameEnd' }
  | { type: 'created';    entity: Entity }
  | { type: 'tag';        entity: Entity; tag: string; value: string; prev?: string }
  | { type: 'blockStart'; blockType: string; entity?: Entity }
  | { type: 'blockEnd';   blockType: string; entity?: Entity }
```

### `class Game`

| Member | Signature | Notes |
| --- | --- | --- |
| constructor | `(powerSource: PowerSource = 'PowerTaskList')` | Ignores `DebugPrintPower` from the other stream |
| `entities` | `Map<number, Entity>` | |
| `playerEntityByPlayerId` | `Map<number, number>` | playerId → entity id |
| `playerNames` | `Map<number, string>` | by **entity** id |
| `namesByPlayerId` | `Map<number, string>` | by **player** id; survives `reset()` |
| `accountHi` | `Map<number, string>` | `0` ⇒ AI/dummy |
| `friendlyPlayerId?` | `number` | Set once per game by `detectFriendly()` |
| `gameEntityId` | `number` (default 1) | |
| `info` | `GameInfo` | Survives `reset()` |
| `phase` | `'none' \| 'running' \| 'over'` | |
| `startedAt` | `number` | epoch ms at `CREATE_GAME` |
| `on(fn)` | `((e: GameEvent) => void): void` | No unsubscribe — models are replaced wholesale |
| `get inGame` | `boolean` | `phase === 'running'` |
| `get turn` | `number` | GameEntity `TURN` tag |
| `gameEntity()` | `(): Entity \| undefined` | |
| `playerEntity(playerId)` | `(number \| undefined): Entity \| undefined` | |
| `playerName(playerId)` | `(number \| undefined): string \| undefined` | |
| `controllerOf(e)` | `(Entity): number` | |
| `handleLine(raw)` | `(string): boolean` | Returns whether state changed |

---

## `src/main/bg/bgGame.ts`

| Export | Signature |
| --- | --- |
| `effectiveHealth(hero)` | `(Entity \| undefined): number` — `HEALTH + ARMOR - DAMAGE` |
| `BgGame` | `class` |

### `class BgGame` — public surface

| Member | Signature | Notes |
| --- | --- | --- |
| constructor | `(game: Game, cards: CardDb, lookahead?: Game)` | Subscribes to both |
| `simIterations` | `number` (5000) | Overridden from settings |
| `onMatchEnd?` | `(m: BgMatch) => void` | |
| `onChange?` | `() => void` | Odds/results changed outside the normal line batch |
| `get isBattlegrounds` | `boolean` | GameType, falling back to the dummy-player tag |
| `get mode` | `GameMode` | |
| `get round` | `number` | `ceil(turn / 2)` |
| `get inCombat` | `boolean` | `turn > 0 && turn % 2 === 0 && inGame` |
| `flushPendingMatch()` | `(): void` | Emit the finished match now (used when Hearthstone exits) |
| `lobby()` | `(): LobbyPlayer[]` | Sorted by place, then team, then player id |
| `snapshot()` | `(): Omit<BgSnapshot, 'status' \| 'statusDetail' \| 'shopHighlights'>` | `shop` filled only during `'shop'`; `selectedBuild`/`buildPrompt` left for `Tracker` |

### Private members worth knowing

| Member | Purpose |
| --- | --- |
| `groupDuoBoards()` | Attributes the pre-combat warband copies to players. The hairiest function in the file |
| `captureBoards(round, initial)` | Snapshots both boards (+ reserves) and writes `lastBoards` |
| `runSim(round, opts)` | Calls `simulateMany` with a 400 ms budget; catches and logs throws |
| `reservePid` / `reserveUnknown` / `reserveInput` | Duos reserve resolution; `reserveUnknown` ⇒ `SimOdds.partial` |
| `handFor(pid)` | Hand minions for the simulator (Choral Mrrrglr, Diremuck Forager) |
| `minionEntities` / `toBoardMinion` / `toInput` | Entity → display / simulator minion |
| `lobbyHeroes()` | HERO entities with both `PLAYER_LEADERBOARD_PLACE` and `PLAYER_ID` |
| `emitMatch()` | Builds the persisted `BgMatch` |
| `shopMinions()` | Tavern offerings: `IS_BACON_POOL_MINION` minions in the dummy player's PLAY zone, each with `pos` = `ZONE_POSITION` |

---

## `src/main/bg/sim/engine.ts`

| Export | Signature |
| --- | --- |
| `mulberry32(seed)` | `(number): () => number` |
| `hasTribe(m, tribe)` | `({ tribes: string[] }, string): boolean` — `'ALL'` matches everything |
| `simulateMany(cards, a, b, opts?)` | → `SimSummary` |
| `Combat` | `class` |
| `CardSource`, `Minion`, `Side`, `MinionInput`, `BoardInput`, `CombatOutcome`, `SimSummary` | interfaces |

```ts
function simulateMany(cards: CardSource, a: BoardInput, b: BoardInput, opts?: {
  iterations?: number        // default 5000
  seed?: number              // default random
  firstAttacker?: 0 | 1
  skipStartOfCombat?: boolean
  myHealth?: number          // → lethalLoss
  oppHealth?: number         // → lethalWin
  timeBudgetMs?: number      // checked every 100 iterations
}): SimSummary
```

```ts
interface CardSource {
  get(cardId: string | undefined): CardInfo | undefined
  bgMinionsNamed(name: string): CardInfo[]
  bgSpellNamed(name: string): CardInfo | undefined
  pool(): CardInfo[]
}
```
`CardDb` satisfies this structurally — the simulator never imports it.

### `class Combat`

| Member | Signature | Notes |
| --- | --- | --- |
| constructor | `(cards: CardSource, rng: () => number, a: BoardInput, b: BoardInput, fxCache?: Map<string, CardFx>)` | `fxCache` is shared across all iterations of a run |
| `sides` | `[Side, Side]` | |
| `lastSummoned?` | `Minion` | |
| `simulate(opts?)` | `({ firstAttacker?, skipStartOfCombat? }): CombatOutcome` | |
| `minionFrom(m)` | `(MinionInput): Minion` | |
| `makeMinion(opts)` | `({ card?, name?, atk?, hp?, tribes?, keywords?, tier? }): Minion` | Token path |
| `fx(cardId)` | `(string): CardFx` | Compile-on-demand, cached |
| `newUid()` | `(): number` | |
| `fillFromHand(side)` | `(Side): void` | Diremuck Forager |
| `other` / `sideOf` / `alive` / `isDead` | | |
| `pick<T>` / `pickN<T>` | `(T[], n?): T \| undefined \| T[]` | The only randomness |
| `buff(m, atk, hp)` | | |
| `damage(target, amount, source?)` | `(…): number` | Divine shield, poison/venom, `killedBy`, damage triggers |
| `summon(side, m, pos)` | `(…): Minion \| undefined` | `undefined` if the board is full; applies name/tribe bonuses |
| `run(effects, self, side, ev?)` | | Executes a compiled effect list |
| `fire(side, kind, subject, ev?)` | `(…, TriggerKind, …): void` | Generic trigger dispatch |
| `chooseTarget(side)` | `(Side): Minion \| undefined` | **`side` is the defending side** |
| `singleAttack(side, attacker, forcedTarget?)` | | One swing (windfury calls it repeatedly) |
| `resolveDeaths(activeSide)` | `(Side): void` | Batched; max 50 passes |

Constants: `MAX_BOARD = 7`, `MAX_ATTACKS = 300`.

```ts
interface CombatOutcome { winner: 0 | 1 | null; damage: number }

interface SimSummary {
  win: number; tie: number; loss: number        // fractions of `iterations`
  avgDamageDealt: number                        // mean over wins only
  avgDamageTaken: number                        // mean over losses only
  lethalWin: number; lethalLoss: number         // fractions of all iterations
  iterations: number; ms: number
  unsupported: string[]                         // board + reserve minions only
}
```

---

## `src/main/bg/sim/effects.ts`

| Export | Signature |
| --- | --- |
| `cleanText(text)` | `(string \| undefined): string` |
| `compileFx(card, cards)` | `(CardInfo \| undefined, CardSource): CardFx` |
| `Effect` | `(c: Combat, self: Minion, side: Side, ev: EffectEvent) => void` |
| `EffectEvent` | `{ target?: Minion; other?: Minion; pos?: number; attacking?: boolean }` |
| `TriggerKind` | `'dies' \| 'attacked' \| 'damaged' \| 'kill'` |
| `Trigger` | `{ on, selfOnly?, excludeSelf?, tribe?, needTaunt?, needDeathrattle?, limit?, effects }` |
| `FriendlyAttackTrigger` | `{ tribe?, excludeSelf, rallyOnly?, effects }` |
| `CardFx` | interface — the compiled hook bag |

### `CardFx` fields and who dispatches them

| Field | Type | Dispatched by |
| --- | --- | --- |
| `triggers` | `Trigger[]` | `Combat.fire` — `damaged` in `damage()`, `kill` in `onKilled`, `attacked` in `singleAttack`, `dies` in `resolveDeaths` |
| `deathrattle` | `Effect[]` | `resolveDeaths` |
| `startOfCombat` | `Effect[]` | `startOfCombat`, `bringInReserves` |
| `startOfCombatFromHand` | `Effect[]` | same, over `side.hand` |
| `rally` | `Effect[]` | `singleAttack`, before damage |
| `afterAttack` | `Effect[]` | `singleAttack`, if the attacker survived |
| `avenge` | `{ n, effects }` | `resolveDeaths`, per friendly death |
| `extraDeathrattles` | `number` | `resolveDeaths` (summed over living friendlies) |
| `friendlyAttack` | `FriendlyAttackTrigger[]` | `singleAttack` |
| `onFriendlyDamage` | `FriendlyAttackTrigger[]` | `onDamageDealt`, per damage instance |
| `onSummon` | `Effect[]` | `summon` |
| `onFriendlyReborn` | `Effect[]` | `resolveDeaths` after a successful reborn |
| `onShieldLost` | `Effect[]` | `damage` when a shield pops |
| `onKill` | `Effect[]` | `onKilled` |
| `onDamaged` | `Effect[]` | `damage`, on the target |
| `summonFromHand` | `{ tribe, left }` | `fillFromHand` via `side.pendingFromHand` |
| `cleave` | `boolean` | `singleAttack` hit list |
| `overkillAdjacent` | `boolean` | `singleAttack` excess damage |
| `immuneWhileAttacking` | `boolean` | suppresses retaliation |
| `tauntWhileShielded` | `boolean` | `simulate` pre-pass + `onShieldLost` |
| `unsupported` | `string[]` | surfaced in `SimSummary.unsupported` |

Module tables (private): `MANUAL` (24 hand-written card handlers keyed by normal card
id), `SPELL_MANUAL` (2 tavern spells), `KEYWORD` (the 5 grantable keywords: divine
shield, taunt, reborn, venomous, windfury), `SHOP_TRIGGER` (allowlist of out-of-combat
phrasings to ignore), `IRRELEVANT`, `TRIBES`, `NUMBERS`.

---

## `src/main/tracker.ts`

| Export | Signature |
| --- | --- |
| `canPickBuild(builds, prompt, state)` | `(Build[], Build[] \| undefined, { heroPicked, hasSelection, inGame }): boolean` — pure; drives `buildPickable` |
| `buildsToOffer(builds, tribes, state)` | `(Build[], string[], { heroPicked, answered, hasSelection, inGame }): Build[] \| undefined` — pure; `undefined` means don't prompt |
| `Tracker` | `class` |

### `class Tracker extends EventEmitter`

| Member | Signature | Notes |
| --- | --- | --- |
| constructor | `(store: Store, cacheDir: string)` | |
| `cards` | `readonly CardDb` | |
| `start()` | `(): Promise<void>` | Install path, card DB, log config check/repair, attach + 5 s re-attach timer |
| `stop()` | `(): void` | Clears the directory timer and the tail (not `emitTimer`/`lingerTimer`) |
| `setSimIterations(n)` | `(number): void` | |
| `selectBuild(id)` | `(string \| null): void` | Choose this game's build (`null` = none), mark the prompt answered, publish. In memory; reset on `gameStart` |
| `publish()` | `(): void` | Builds the `BgSnapshot`, stamps `status`, emits |
| `snapshot()` | `(): BgSnapshot` | Cached; publishes lazily on first call |
| `setupStatus()` | `(): Promise<SetupStatus>` | Re-checks the log config |
| `fixLogConfig()` | `(): Promise<void>` | → `ensureLogConfig` |
| `setInstallPath(path)` | `(string): Promise<void>` | |

| Event | Payload |
| --- | --- |
| `'snapshot'` | `BgSnapshot` |
| `'data'` | *(none)* — match history changed |

Constants: `GAME_OVER_LINGER_MS = 30_000`, `STALL_MS = 3 * 60_000`,
`TRIBE_READ_ATTEMPTS = 12` × `TRIBE_READ_INTERVAL_MS = 2500`, publish debounce
60 ms, re-attach interval 5 s.

---

## `src/main/store.ts`

### `class Store`

| Member | Signature | Notes |
| --- | --- | --- |
| constructor | `(dir: string)` | `app.getPath('userData')` |
| `get matches` | `BgMatch[]` | Live reference |
| `get settings` | `Settings` | Live reference, defaults merged one level deep |
| `addMatch(m)` | `(BgMatch): void` | Push + debounced save |
| `deleteMatch(id)` | `(string): void` | |
| `get builds` | `Build[]` | Live reference |
| `saveBuild(b)` | `(Build): void` | Insert or replace by id |
| `deleteBuild(id)` | `(string): void` | |
| `updateSettings(patch)` | `(Partial<Settings>): void` | `overlay` merged one level deeper |
| `getBounds(name)` | `(string): Electron.Rectangle \| undefined` | |
| `setBounds(name, b)` | `(string, Electron.Rectangle): void` | |
| `flushAll()` | `(): Promise<void>` | |

`JsonFile<T>` (private): sync read with silent fallback, 200 ms debounced `save()`,
atomic `flush()` (write `.tmp`, rename).

---

## `src/preload/index.ts`

`window.api`, typed as `Api`. See
[ipc-and-data.md](ipc-and-data.md#windowapi) for the channel table. Every `on*` returns
an unsubscribe function.

---

## `src/renderer/src/lib.ts`

| Export | Signature | Notes |
| --- | --- | --- |
| `TRIBES` | `Record<string, { label, color }>` | The 11 tribes; source of ordering **and** colour |
| `tribeLabel(t)` | `(string): string` | Title-case fallback for unknown races |
| `artUrl(cardId)` | `(string): string` | `art.hearthstonejson.com/v1/256x/…`, strips `_G` so goldens reuse normal art |
| `renderUrl(cardId)` | `(string): string` | **Unused** |
| `pct(n, digits = 0)` | `(number \| undefined, number): string` | `'–'` for undefined/NaN |
| `timeAgo(ts)` | `(number): string` | |
| `isTopHalf(place, mode)` | `(number, GameMode): boolean` | ≤2 duos, ≤4 solo |
| `placeColor(place, mode)` | `(number, GameMode): string` | CSS var |
| `ordinal(n)` | `(number): string` | |
| `useSnapshot()` | `(): BgSnapshot` | |
| `useSettings()` | `(): [Settings \| undefined, (p: Partial<Settings>) => Promise<void>]` | |
| `useMatches()` | `(): BgMatch[]` | Reloads on `data:changed` |
| `useBuilds()` | `(): readonly [Build[], save: (Build) => void, remove: (string) => void]` | Optimistic local state; persists via IPC |
| `usePool()` | `(): CardInfo[]` | Module-level promise cache, cleared if empty |
| `buildsByLobby(builds, tribes)` | `→ readonly [relevant, rest]` | Builds for this lobby's tribes (or tribeless) first; used by `BuildBar` and `BuildPicker` |
| `sortedTargets(b)` | `(Build): BuildTarget[]` | Earliest `byTurn` first, copied |
| `buildProgress(build, round, board, shop?)` | `→ { stage, minions, addons, have, turnsLeft, final } \| undefined` | Current stage = first not yet past its turn, else the last; goldens count |
| `cardTextParts(raw)` / `cardTextPlain(raw)` | `(string \| undefined): TextPart[]` / `string` | Card text with Hearthstone's bold/italic emphasis kept as parts / stripped |
| `Session` | `{ games: BgMatch[]; avg: number; topRate: number }` | games oldest-first |
| `currentSession(matches)` | `(BgMatch[]): Session` | Cuts at the first >2 h gap (`SESSION_GAP_MS`) |
| `placementStats(matches)` | `(BgMatch[]): { games, avg, topRate, firsts }` | |

---

## `src/renderer/src/anim.ts`

| Export | Signature | Notes |
| --- | --- | --- |
| `reducedMotion()` | `(): boolean` | |
| `useAnimatedNumber(target, duration = 700)` | `(number, number): number` | rAF + `easeOutCubic`, starts at 0 |
| `useChange(value, resetKey)` | `(number, unknown): { delta: number; key: number }` | Delta only while `resetKey` is unchanged; `key` increments to replay a CSS animation |
| `useFlip<T extends HTMLElement>(deps)` | `(unknown): RefObject<T>` | FLIP over `[data-flip-id]` children, 450 ms, vertical only |

---

## `src/renderer/src/components.tsx`

| Component | Props |
| --- | --- |
| `MinionCard` | `{ m: BoardMinion; size?: 'sm' \| 'md' \| 'lg' }` |
| `Board` | `{ minions: BoardMinion[]; size?; empty?: ReactNode }` |
| `HeroPortrait` | `{ cardId?: string; size?: number; dead?: boolean }` |
| `OddsBar` | `{ odds: SimOdds; compact?: boolean; fightKey?: unknown }` |
| `ResultBadge` | `{ result?: CombatResult; damage?: number }` |
| `LobbyList` | `{ players: LobbyPlayer[]; mode?; expandedId?: number; onToggle?: (id) => void; onHover?: (id \| undefined) => void }` |
| `LobbyRow` | `{ p: LobbyPlayer; expanded?: boolean; onToggle?: () => void; mode? }` |
| `TribeChips` | `{ tribes: string[]; all?: boolean }` |
| `SessionStrip` | `{ s: Session; compact?: boolean }` |
| `Stat` | `{ label: string; value: ReactNode; hint?: ReactNode }` |
| `Pill` | `{ children: ReactNode; tone?: 'neutral' \| 'win' \| 'loss' \| 'accent' }` |
| `CardText` | `{ text?: string }` |

---

## Game tags consumed

Every Hearthstone `GameTag` this codebase reads. Tag names come from the log text
itself (Hearthstone prints symbolic names for known tags and bare numbers for the rest).

| Tag | Read by | Used for |
| --- | --- | --- |
| `TURN` | `Game.turn`, `BgGame.onTag` | Odd = shop, even = combat; `round = ceil(turn/2)` |
| `STATE` | `Game.setTag` | `COMPLETE` ⇒ game over |
| `PLAYSTATE` | `Game.setTag` | `WON/LOST/TIED/CONCEDED` on your player ⇒ *your* game is over |
| `ZONE` | `BgGame` | `PLAY`, `HAND`, `SETASIDE` |
| `ZONE_POSITION` | `BgGame.minionEntities` | Board order |
| `CONTROLLER` | `Game.controllerOf`, `BgGame` | Whose minion it is |
| `CARDTYPE` | `BgGame` | `MINION` / `HERO` |
| `PLAYER_ID` | `Game`, `BgGame` | Links a hero copy back to a lobby player |
| `ATK`, `HEALTH`, `DAMAGE`, `ARMOR` | `BgGame` | `health = HEALTH - DAMAGE`; `effectiveHealth = HEALTH + ARMOR - DAMAGE` |
| `TECH_LEVEL` | `toBoardMinion`, `toInput` | Minion tier (damage on loss) |
| `PREMIUM` | `toBoardMinion`, `toInput` | Golden |
| `TAUNT`, `DIVINE_SHIELD`, `REBORN`, `VENOMOUS`, `POISONOUS`, `WINDFURY`, `MEGA_WINDFURY`, `STEALTH` | `toBoardMinion`, `toInput` | Keyword flags handed to the simulator |
| `COPIED_FROM_ENTITY_ID` | `groupDuoBoards`, `handFor` | Maps a combat copy back to the real minion |
| `BACON_DUMMY_PLAYER` | `Game.detectFriendly`, `BgGame.isBattlegrounds` | The opponent-hosting dummy; the *other* player is you |
| `IS_BACON_POOL_MINION` | `BgGame.noteTribes` | Which tribes are in this lobby |
| `PLAYER_TECH_LEVEL` | `BgGame.lobby`, `simInput` | Tavern tier (hero damage contribution) |
| `PLAYER_TRIPLES` | `BgGame.lobby` | Triple counter shown in the lobby |
| `PLAYER_LEADERBOARD_PLACE` | `lobbyHeroes`, `updatePlacement` | Distinguishes lobby heroes from combat copies; final placement |
| `NEXT_OPPONENT_PLAYER_ID`, `NEXT_OPPONENT_TEAMMATE_PLAYER_ID` | `BgGame.lobby` | Highlights your next opponent |
| `BACON_DUO_TEAM_ID` (3095) | `BgGame.lobby` | Duos team grouping |
| `BACON_DUO_TEAMMATE_PLAYER_ID` | `BgGame` | Your teammate; reserve resolution |
| **`3085`** | `groupDuoBoards` | **Unnamed.** See below |

### Tag `3085`

Used in exactly one place:

```ts
// src/main/bg/bgGame.ts:307
const looksLikeHand = zone === 'HAND' || Number(e.tags['3085'] ?? -1) !== Number(e.tags.HEALTH ?? 0)
```

Hearthstone prints a bare number when the client has no symbolic name for a tag, so
`3085` was derived empirically: on a Duos warband copy waiting to fight, this tag
differs from `HEALTH`, which is what separates hand cards from board cards in the
pre-combat copy block.

**It has no public name.** Checked against HearthSim's two published `GameTag` enums —
[python-hearthstone `enums.py`](https://github.com/HearthSim/python-hearthstone/blob/master/hearthstone/enums.py)
and [HearthDb `Enums.cs`](https://github.com/HearthSim/HearthDb/blob/master/HearthDb/Enums/Enums.cs)
— neither defines 3085; the surrounding values are `FX_DATANUM_2 = 3077`,
`RITUALIST_MINION = 3078`, `SUPPRES_ALL_SOUNDS_FOR_ENTITY = 3093`,
`BACON_DUO_TEAM_ID = 3095`. Hearthstone-Deck-Tracker has no equivalent code to compare
against: it doesn't reconstruct Duos reserve warbands from the copy block, so there's
nothing there to crib a name from.

**Ruled out: this is not a dbfId.** `Entity.tags` is keyed by the token after `tag=`
(`game.ts:132`), so `3085` lives in the GameTag namespace alongside `HEALTH` and `ZONE`
— and the entities inspected here are Duos warband *minion* copies in `SETASIDE`, not
heroes. A card or hero dbfId (e.g. Tae'thelan Bloodwatcher, `BG28_HERO_800`) would
appear as a `CardID=` or as the *value* of a tag, never as a tag name.

Treat it as an undocumented, version-specific client tag. The `≤ 7 minions` backstop in
`groupDuoBoards` exists precisely because this heuristic can break. If Duos reserves
regress after a patch, re-derive it: dump the `SETASIDE` block for a Duos combat and
diff the tags on a waiting teammate's hand card against a board card.
