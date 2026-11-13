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

Five windows:

- **Main window** — 1280×820, custom title bar (`titleBarStyle: 'hidden'` +
  `titleBarOverlay`), closing it quits the app.
- **Odds overlay** — `overlay.html?kind=odds`, 440×170, top-centre.
- **Lobby overlay** — `overlay.html?kind=lobby`, 290×~720, left edge.
- **Build overlay** — `overlay.html?kind=build`, 240×~520, right edge. Hidden until a
  build is selected for the game.
- **Highlight layer** — `overlay.html?kind=slots`. Not positionable: main sets its
  bounds to Hearthstone's client area every time there are boxes to draw, and it's
  permanently click-through and unfocusable.

The three positionable overlays are frameless, transparent, `skipTaskbar`, created eagerly at startup
with `show: false`, and raised with `setAlwaysOnTop(true, 'screen-saver')` so they sit
above a fullscreen-windowed game. They're shown with `showInactive()` so they never
steal focus. See [ui.md](ui.md#overlay-windows) for the lock / click-through rules.

Window bounds are persisted per window name (`main`, `overlay-odds`, `overlay-lobby`,
`overlay-build`) on `moved` / `resized` — except while main is resizing a window itself
(`resizingOurselves`, used to grow the odds window around the build prompt).

## Module map

```
src/
  main/
    index.ts          windows, IPC registration, overlay show/hide
    tracker.ts        orchestration: tailing, dual Game models, status, publishing
    store.ts          JSON persistence (matches, settings, builds, window bounds)
    comps.ts          HSReplay comps list + addons, scraped via Electron `net`
    buildCode.ts      build ⇄ short share code (`HTB …`), checksummed
    logs/
      hsPaths.ts      install discovery, log.config / client.config, active log dir
      logTail.ts      polling tail + "skip to last game" offset
    game/game.ts      Power.log → entities + tags + events (mode-agnostic)
    bg/
      bgGame.ts       Battlegrounds state: lobby, boards, combats, Duos
      sim/engine.ts   combat loop, board model, simulateMany()
      sim/effects.ts  card text → effects compiler + manual handlers
    cards/cardDb.ts   HearthstoneJSON download, slim, cache, indexes
    vision/
      heroSelect.ts   desktopCapturer + tesseract.js: lobby tribes, tavern slots
      bannerRect.ts   find the "Choose a Hero" plate by colour (pure)
      tribeNames.ts   OCR text → race codes, fuzzy-matched (pure)
      shopSlots.ts    find tavern cards by their tier shields (pure)
      gameWindow.ts   Hearthstone client rect via PowerShell GetClientRect
  preload/index.ts    window.api
  renderer/src/
    main.tsx          app shell + all six pages
    overlay.tsx       all four overlay kinds (odds + build prompt, lobby, build, slots)
    components.tsx    shared UI (MinionCard, OddsBar, LobbyList, …)
    lib.ts            hooks, tribes, art URLs, formatting
    anim.ts           count-up, delta, FLIP reorder (no animation library)
    styles.css        one hand-written stylesheet, dark theme only
  shared/types.ts     the main↔renderer contract
```

One runtime dependency, `tesseract.js` (OCR for the tribe banner — see below).
Everything else, React included, is a devDependency bundled at build time. No state
library, no router, no CSS framework, no ORM.

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

## Screen reading — `src/main/vision/`

The log can't answer two questions the Builds feature needs, so these are read off the
screen. Each is split into a pure pixel/text half (tested against captured frames) and
a thin Electron half in `heroSelect.ts`. Captures come from `desktopCapturer`: the
window named `Hearthstone`, as a thumbnail capped at 2560×1440.

**Lobby tribes, before the first shop.** Hearthstone writes no `IS_BACON_POOL_MINION`
markers before the hero is locked in, and some tribes don't show up in the log until
round 2. The hero-select screen lists them all in a text banner (Hearthstone's font,
not icons). So from the moment heroes are offered (`BACON_HERO_CAN_BE_DRAFTED`),
`Tracker` polls `readLobbyTribes()` every 2.5 s, up to 12 times, stopping once the hero
is picked:

1. `findBannerRect` locates the purple "Choose a Hero" plate by colour. A fixed
   window-relative rect was tried and dropped: tesseract needs a tight crop, and the
   plate's position can't be derived from the window size.
2. The crop is OCR'd twice (`SPARSE_TEXT` and `AUTO` segmentation) and the results
   merged, because neither mode is reliable alone at both 4K and 1080p.
3. `parseTribeBanner` maps each word to the nearest tribe by Levenshtein, with the
   allowance scaled to word length; non-tribe words are dropped.

Results accumulate across attempts and are merged with the log's tribes in the
snapshot. An empty read means "don't know", so a failure falls back to the log.
The tesseract worker is created lazily and its ~5 MB language data is cached in
`userData/carddata/` (tesseract.js defaults to the working directory, which is wrong
for a packaged app).

**Where the tavern cards are.** `shopSlots.ts` finds each offered card by the magenta
tier shield at its top edge, which nothing else on the shop screen shares; card size
is derived from the slot pitch (`CARD_WIDTH`, `CARD_ASPECT`). The log gives each offered
minion's `ZONE_POSITION` (`BgSnapshot.shop[].pos`), and the slot is matched on that
rather than by counting minions, because tavern spells take slots too.
`Tracker.refreshHighlights` re-runs the capture only when the tavern's contents
change, scales frame coordinates to the client rect from `gameWindow.ts`, and drops
the result if the tavern moved on meanwhile. Any failure means no boxes, never
misplaced ones.

## Builds flow

1. **Hero picked.** `MULLIGAN_STATE = DONE` on your player entity (in Battlegrounds the
   mulligan *is* the hero choice) sets `heroPicked`.
2. **Offer.** `buildsToOffer()` (exported from `tracker.ts`, tested) returns the builds
   whose `tribe` is in the lobby (or empty), but only after the hero pick, only in game,
   and never once answered or with a build already selected. That becomes
   `snapshot.buildPrompt`.
3. **Answer.** `builds:select` → `Tracker.selectBuild(id | null)` marks it answered.
   The selection is in memory and reset on `gameStart`; the Live page's "Going for"
   selector can change it at any time.
4. **Follow.** The build overlay shows progress from `snapshot.board` and
   `snapshot.shop`; the highlight layer boxes wanted minions that are on offer and not
   already owned (goldens count as owned).
