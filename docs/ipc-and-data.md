# IPC, shared types and storage

## `window.api`

`src/preload/index.ts` exposes one object via `contextBridge.exposeInMainWorld('api', …)`
and exports `type Api = typeof api`. `src/renderer/src/env.d.ts` declares
`Window.api: Api`, so the renderer gets the real signatures with no duplicated types.

Every `on*` returns an unsubscribe function, which the hooks return straight out of
`useEffect`.

| `window.api` | Channel | Kind | Payload → result |
| --- | --- | --- | --- |
| `snapshot()` | `tracker:snapshot` | invoke | → `BgSnapshot` |
| `onSnapshot(fn)` | `tracker:snapshot` | push | `BgSnapshot` |
| `onDataChanged(fn)` | `data:changed` | push | *(none)* |
| `onSettingsChanged(fn)` | `settings:changed` | push | `Settings` |
| `setupStatus()` | `setup:status` | invoke | → `SetupStatus` |
| `fixLogConfig()` | `setup:fixLogConfig` | invoke | → `void` |
| `browseInstall()` | `setup:browse` | invoke | → `string \| undefined` |
| `matches()` | `matches:list` | invoke | → `BgMatch[]` |
| `deleteMatch(id)` | `matches:delete` | invoke | `string` → `void` |
| `pool()` | `cards:pool` | invoke | → `CardInfo[]` |
| `builds()` | `builds:list` | invoke | → `Build[]` |
| `saveBuild(b)` | `builds:save` | invoke | `Build` → `void` (insert or replace by id) |
| `deleteBuild(id)` | `builds:delete` | invoke | `string` → `void` |
| `selectBuild(id)` | `builds:select` | invoke | `string \| null` → `void` |
| `exportBuild(id)` | `builds:export` | invoke | `string` → share code |
| `importBuild(code)` | `builds:import` | invoke | `string` → `Decoded`: `{ build: Omit<Build, 'id'>, missing }` |
| `comps()` | `comps:list` | invoke | → `Comp[]` (fetched from HSReplay) |
| `compDetail(url)` | `comps:detail` | invoke | `string` → `{ addons: string[], howToPlay: string }` |
| `settings()` | `settings:get` | invoke | → `Settings` |
| `updateSettings(patch)` | `settings:update` | invoke | `Partial<Settings>` → merged `Settings` |
| `openExternal(url)` | `app:openExternal` | invoke | `string` → `void` |
| `setInteractive(on)` | `overlay:interactive` | invoke | `boolean` → `void` (overlays only) |
| `onOverlayZoom(fn)` | `overlay:zoom` | push | `number`: the overlay's zoom (game size × Size setting) |

Notes:

- `tracker:snapshot` is both the pull and the push channel.
- Pushes go to **every** window (`broadcast()` loops all `BrowserWindow`s); there's no
  per-window targeting.
- `settings:update` also forwards `simIterations` to the tracker, re-runs
  `updateOverlays()` and broadcasts `settings:changed`.
- `app:openExternal` is guarded by `/^https:\/\//`. (`setWindowOpenHandler` on the main
  window is not — see [development.md](development.md#rough-edges).)
- `matches:delete` broadcasts `data:changed` afterwards so every view reloads.
- `builds:save` / `builds:delete` do **not** broadcast — only the Builds page and the
  Live page's selector read the list, and `useBuilds()` updates its own state. The
  selected build reaches the overlays through the snapshot instead.
- `builds:select` sets the game's build (`null` = dismiss the prompt with none) and
  marks the prompt answered. Saved per game in `build-choice.json`, so a tracker restart
  mid-game keeps it.
- `overlay:interactive` makes the *sending* overlay take clicks while `on`, even when
  locked. Overlay buttons send it on pointer enter/leave (and on unmount); main keeps
  a set of hovered windows and folds it into `updateOverlays()`, and forgets a window
  when it's hidden.
- `comps:detail` only accepts `https://hsreplay.net/battlegrounds/comps/…` URLs, since
  the renderer supplies the address.
- `builds:export` / `builds:import` go through `buildCode.ts` in main because codes
  address cards by `CardDb.shareIndexOf` / `shareCardAt`. Import throws on a bad
  checksum rather than returning the wrong minions.

## Shared types — `src/shared/types.ts`

Pure types, no runtime code. The contract between main, preload and renderer.

**`BgSnapshot`** — the live state, pushed every ≤60 ms:

```ts
{
  status: 'setup-needed' | 'waiting-for-logs' | 'idle'
        | 'in-game' | 'game-over' | 'not-battlegrounds'
  statusDetail?: string
  mode?: 'solo' | 'duos'
  round: number
  phase: 'none' | 'shop' | 'combat' | 'over'
  me?: LobbyPlayer
  lobby: LobbyPlayer[]
  tribes: string[]
  board: BoardMinion[]      // your warband in shop; the fighting copy in combat
  shop: BoardMinion[]       // tavern offerings, with pos; [] outside a shop phase
  combat?: CombatRound      // the live round, or the most recent one
  rounds: CombatRound[]
  placement?: number
  selectedBuild?: Build     // the build followed this game
  buildPrompt?: Build[]     // builds to offer; set after hero pick, cleared once answered
  buildPickable?: boolean   // offer "Pick a build" on the lobby overlay (canPickBuild)
  shopHighlights: { x, y, width, height, debug? }[]  // Hearthstone client-area coords
}
```

`tribes` is the log's tribe list merged with the ones OCR'd off the hero-select
screen (see [architecture.md](architecture.md#screen-reading--srcmainvision)).
`selectedBuild`, `buildPrompt`, `buildPickable` and `shopHighlights` are filled in by `Tracker`, not
`BgGame` — they come from user choice and the screen, not the log.

`status` and `phase` are independent axes — the UI combines them (e.g. "fighting" is
`status === 'in-game' && phase === 'combat' && combat.round === round`).

**`CombatRound`** — `round`, opponent id/hero/name, `myBoard`, `oppBoard`, the four
Duos reserve fields, `odds?`, `result?` (`WON`/`LOST`/`TIED`), `damage?`.

**`SimOdds`** — `win`/`tie`/`loss` as 0–1 fractions, `avgDamageDealt` (when we win),
`avgDamageTaken` (when we lose), `lethalWin`/`lethalLoss`, `iterations`, `ms`,
`unsupported: string[]`, `partial?` (Duos: a teammate warband was unknown).

**`BoardMinion`** — `cardId`, `name`, `atk`, `health`, `tier`, `golden`, plus optional
`taunt`/`divineShield`/`reborn`/`venomous`/`windfury`/`stealth`, and `pos` (shop
minions only: the 1-based tavern slot from `ZONE_POSITION`, kept because spells take
slots too).

**`LobbyPlayer`** — `playerId`, hero card/name, `health`, `armor`, `tier`, `triples`,
`place`, `team?`, `isMe`, `isTeammate`, `isNextOpponent`, `dead`,
`lastBoard?: { round, minions }`, `lastResult?`.

**`BgMatch`** — a persisted game: `id`, `startedAt`, `endedAt`, `mode`, hero,
`placement`, `rounds`, `tribes`, `finalBoard`, `teammateHeroCardId?`, `combats`.

**`Build`** — `id`, `name`, `tribe` (race code; `''` = any lobby, e.g. Menagerie),
`targets: BuildTarget[]` (`{ byTurn, cardIds }`, ≤7 cards each, earliest first),
`addons?: string[]` (supporting cards, no turn), `description?: string` (free text;
from HSReplay it's the How to Play paragraph with card names kept as
`[[Name||dbfId]]`), `source?: { name, url }` when started from a published comp.
Share codes carry everything but `id` and `description`.

**`Comp`** — an HSReplay comp: `id`, `name`, `tribe` (`''` if none), `summary`, `tier`
(1 = S … 3 = B), `difficulty`, `cardIds` (core minions resolved to known ids), `url`.

**`CardInfo`** — the slimmed HearthstoneJSON record (see
[log-pipeline.md](log-pipeline.md#card-data--carddbts)).

**`Settings`** — `hearthstonePath`, `simIterations`, and
`overlay: { enabled, opacity, scale, showOdds, showLobby, showBuild, debugHighlights, locked }`.

**`SetupStatus`** — `hearthstonePath`, `installFound`, `logConfigOk`, `logConfigPath`,
`activeLogDir?`, `powerLogFound`, `cardDbLoaded`, `cardCount`.

## Storage — `src/main/store.ts`

Everything lives in Electron's `userData` directory
(`%APPDATA%\hearth-tracker\` on Windows) as pretty-printed JSON:

| File | Contents |
| --- | --- |
| `bg-matches.json` | `BgMatch[]`, appended on game end, never pruned |
| `settings.json` | `Settings` |
| `builds.json` | `Build[]` |
| `build-choice.json` | `{ game, buildId?, answered }`: the build answer for the latest game, so a restart mid-game keeps it |
| `windows.json` | `Record<name, Electron.Rectangle>` — the main window's bounds |
| `overlay-places.json` | `Record<kind, { fx, fy, width, height }>`: each overlay's position relative to the game window, size at scale 1 |
| `carddata/cards-v2.json` | HearthstoneJSON cache (owned by `CardDb`, not `Store`) |
| `carddata/eng.traineddata` | tesseract.js language data (~5 MB), downloaded on first OCR |

`JsonFile<T>` is ~25 lines: synchronous read on construction with a silent fallback to
the default on a missing or corrupt file, a 200 ms debounced `save()`, and an atomic
`flush()` (write `.tmp`, then rename). No schema validation and no migrations — the only
forward-compat measure is the one-level deep merge of defaults into `settings`:

```ts
{ ...DEFAULT_SETTINGS, ...loaded, overlay: { ...DEFAULT_SETTINGS.overlay, ...loaded.overlay } }
```

Defaults: `simIterations: 5000`, overlay
`{ enabled: true, opacity: 0.95, scale: 1, showOdds: true, showLobby: true, showBuild: true, debugHighlights: false, locked: true }`.
