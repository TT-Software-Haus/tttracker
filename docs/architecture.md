# Architecture

## Processes

Three electron-vite build targets, one `tsconfig.json` for all of them:

| Target | Entry | Output | Notes |
| --- | --- | --- | --- |
| main | `src/main/index.ts` | `out/main/index.js` | Node context: file tailing, parsing, simulation, windows |
| preload | `src/preload/index.ts` | `out/preload/index.cjs` | Forced CJS; `contextBridge` only |
| renderer | `src/renderer/index.html`, `overlay.html` | `out/renderer/` | React 19, two HTML entries |

`contextIsolation: true` everywhere; `sandbox: false` because the preload is a CJS
bundle importing `electron`. The renderer touches nothing but `window.api`.

Three windows:

- **Main window** — 1280×820, custom title bar (`titleBarStyle: 'hidden'` +
  `titleBarOverlay`), closing it quits the app.
- **Odds overlay** — `overlay.html?kind=odds`, 440×170, top-centre.
- **Lobby overlay** — `overlay.html?kind=lobby`, 290×~720, left edge.

Both overlays are frameless, transparent, `skipTaskbar`, created eagerly at startup
with `show: false`, and raised with `setAlwaysOnTop(true, 'screen-saver')` so they sit
above a fullscreen-windowed game. They're shown with `showInactive()` so they never
steal focus. See [ui.md](ui.md#overlay-windows) for the lock / click-through rules.

Window bounds are persisted per window name (`main`, `overlay-odds`, `overlay-lobby`)
on `moved` / `resized`.

## Module map

```
src/
  main/
    index.ts          windows, IPC registration, overlay show/hide
    tracker.ts        orchestration: tailing, dual Game models, status, publishing
    store.ts          JSON persistence (matches, settings, window bounds)
    logs/
      hsPaths.ts      install discovery, log.config / client.config, active log dir
      logTail.ts      polling tail + "skip to last game" offset
    game/game.ts      Power.log → entities + tags + events (mode-agnostic)
    bg/
      bgGame.ts       Battlegrounds state: lobby, boards, combats, Duos
      sim/engine.ts   combat loop, board model, simulateMany()
      sim/effects.ts  card text → effects compiler + manual handlers
    cards/cardDb.ts   HearthstoneJSON download, slim, cache, indexes
  preload/index.ts    window.api
  renderer/src/
    main.tsx          app shell + all five pages
    overlay.tsx       both overlay kinds
    components.tsx    shared UI (MinionCard, OddsBar, LobbyList, …)
    lib.ts            hooks, tribes, art URLs, formatting
    anim.ts           count-up, delta, FLIP reorder (no animation library)
    styles.css        one hand-written stylesheet, dark theme only
  shared/types.ts     the main↔renderer contract
```

No runtime `dependencies` — React and everything else is bundled at build time.
No state library, no router, no CSS framework, no ORM.

## Data flow

1. **Attach.** `Tracker.start()` resolves the Hearthstone install, initialises the card
   DB, checks `log.config`, then polls for the active log directory every 5 s
   (Hearthstone makes a new session folder on each launch).
2. **Tail.** `LogTail` polls `Power.log` every 150 ms and delivers complete lines.
   The initial `start()` offset is `lastGameOffset()`, so only the current game is
   replayed, not the whole session.
3. **Parse twice.** Every line goes to `lookahead` (`GameState`) first, then `game`
   (`PowerTaskList`). Both build `Map<entityId, { cardId, tags }>` and emit
   `gameStart` / `gameEnd` / `created` / `tag` / `blockStart` / `blockEnd`.
4. **Interpret.** `BgGame` subscribes to the PowerTaskList model for everything the
   user sees, and reads frozen snapshots out of the GameState model for details the
   client hides (notably Duos warband copies).
5. **Simulate.** On the first `ATTACK` block of a combat, both boards are captured and
   run through `simulateMany()` with `skipStartOfCombat: true` — odds come from the
   real post-Start-of-Combat position, not a guess at it.
6. **Publish.** Any state change calls `schedulePublish()`, which coalesces to one
   `BgSnapshot` per 60 ms, stamps a `TrackerStatus` on it and broadcasts
   `tracker:snapshot` to every window.
7. **Persist.** On game end `BgGame` emits a `BgMatch` (after a 4 s delay — the final
   leaderboard place arrives a few lines late), `Store` appends it, and
   `data:changed` is broadcast so History/Stats reload.

## Why two `Game` instances

Hearthstone logs every power twice. `GameState` lines appear as soon as the server
sends them: in Battlegrounds the entire combat and its result are in the log before
the first minion animates. `PowerTaskList` lines appear as the client plays them out,
in step with the screen.

Showing the user GameState would spoil the fight. Showing only PowerTaskList loses
information the client cleans up before it animates. So the live model is
PowerTaskList and the lookahead is GameState, used solely as a reference for Duos
warband grouping (`BgGame.lookCreated`).

Both models are discarded and rebuilt (`freshModel()`) whenever the log directory
changes or Hearthstone exits mid-game.
