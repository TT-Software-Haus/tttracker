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
| `settings()` | `settings:get` | invoke | → `Settings` |
| `updateSettings(patch)` | `settings:update` | invoke | `Partial<Settings>` → merged `Settings` |
| `openExternal(url)` | `app:openExternal` | invoke | `string` → `void` |

Notes:

- `tracker:snapshot` is both the pull and the push channel.
- Pushes go to **every** window (`broadcast()` loops all `BrowserWindow`s); there's no
  per-window targeting.
- `settings:update` also forwards `simIterations` to the tracker, re-runs
  `updateOverlays()` and broadcasts `settings:changed`.
- `app:openExternal` is guarded by `/^https:\/\//`. (`setWindowOpenHandler` on the main
  window is not — see [development.md](development.md#rough-edges).)
- `matches:delete` broadcasts `data:changed` afterwards so every view reloads.

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
  combat?: CombatRound      // the live round, or the most recent one
  rounds: CombatRound[]
  placement?: number
}
```

`status` and `phase` are independent axes — the UI combines them (e.g. "fighting" is
`status === 'in-game' && phase === 'combat' && combat.round === round`).

**`CombatRound`** — `round`, opponent id/hero/name, `myBoard`, `oppBoard`, the four
Duos reserve fields, `odds?`, `result?` (`WON`/`LOST`/`TIED`), `damage?`.

**`SimOdds`** — `win`/`tie`/`loss` as 0–1 fractions, `avgDamageDealt` (when we win),
`avgDamageTaken` (when we lose), `lethalWin`/`lethalLoss`, `iterations`, `ms`,
`unsupported: string[]`, `partial?` (Duos: a teammate warband was unknown).

**`BoardMinion`** — `cardId`, `name`, `atk`, `health`, `tier`, `golden`, plus optional
`taunt`/`divineShield`/`reborn`/`venomous`/`windfury`/`stealth`.

**`LobbyPlayer`** — `playerId`, hero card/name, `health`, `armor`, `tier`, `triples`,
`place`, `team?`, `isMe`, `isTeammate`, `isNextOpponent`, `dead`,
`lastBoard?: { round, minions }`, `lastResult?`.

**`BgMatch`** — a persisted game: `id`, `startedAt`, `endedAt`, `mode`, hero,
`placement`, `rounds`, `tribes`, `finalBoard`, `teammateHeroCardId?`, `combats`.

**`CardInfo`** — the slimmed HearthstoneJSON record (see
[log-pipeline.md](log-pipeline.md#card-data--carddbts)).

**`Settings`** — `hearthstonePath`, `simIterations`, and
`overlay: { enabled, opacity, scale, showOdds, showLobby, locked }`.

**`SetupStatus`** — `hearthstonePath`, `installFound`, `logConfigOk`, `logConfigPath`,
`activeLogDir?`, `powerLogFound`, `cardDbLoaded`, `cardCount`.

## Storage — `src/main/store.ts`

Everything lives in Electron's `userData` directory
(`%APPDATA%\hearth-tracker\` on Windows) as pretty-printed JSON:

| File | Contents |
| --- | --- |
| `bg-matches.json` | `BgMatch[]`, appended on game end, never pruned |
| `settings.json` | `Settings` |
| `windows.json` | `Record<name, Electron.Rectangle>` — `main`, `overlay-odds`, `overlay-lobby` |
| `carddata/cards-v2.json` | HearthstoneJSON cache (owned by `CardDb`, not `Store`) |

`JsonFile<T>` is ~25 lines: synchronous read on construction with a silent fallback to
the default on a missing or corrupt file, a 200 ms debounced `save()`, and an atomic
`flush()` (write `.tmp`, then rename). No schema validation and no migrations — the only
forward-compat measure is the one-level deep merge of defaults into `settings`:

```ts
{ ...DEFAULT_SETTINGS, ...loaded, overlay: { ...DEFAULT_SETTINGS.overlay, ...loaded.overlay } }
```

Defaults: `simIterations: 5000`, overlay
`{ enabled: true, opacity: 0.95, scale: 1, showOdds: true, showLobby: true, locked: true }`.
