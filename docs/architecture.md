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

Six windows:

- **Main window** — 1280×820, custom title bar (`titleBarStyle: 'hidden'` +
  `titleBarOverlay`), closing it quits the app.
- **Odds overlay** — `overlay.html?kind=odds`, 440×170 at full scale, top-centre of the game.
- **Lobby overlay** — `overlay.html?kind=lobby`, 290×720 at full scale, the game's left edge.
- **Build overlay** — `overlay.html?kind=build`, 240×520 at full scale, the game's right edge. Hidden until a
  build is selected for the game.
- **Highlight layer** — `overlay.html?kind=slots`. Not positionable: main sets its
  bounds to Hearthstone's client area every time there are boxes to draw, and it's
  permanently click-through and unfocusable.

The three positionable overlays are frameless, transparent, `skipTaskbar`, created eagerly at startup
with `show: false`, and raised with `setAlwaysOnTop(true, 'screen-saver')` so they sit
above a fullscreen-windowed game. They're shown with `showInactive()` so they never
steal focus. See [ui.md](ui.md#overlay-windows) for the lock / click-through rules.

**The odds, lobby and build overlays sit inside the game window and follow it**
(`overlayLayout.ts`, wired up in `index.ts`). The anchor is the game's client area, or
the screen's work area with no game window. A position is a fraction of the free space
inside the anchor (0 flush left/top, 1 flush right/bottom, 0.5 centred), so it holds
whatever the window's size and an overlay can't leave the game area. Sizes are stored
unscaled and multiplied by `overlayScale`: the anchor's height ÷ 1440 (this monitor's
fullscreen height in DIPs, so fullscreen looks unchanged), floored at 0.6 for
readability, times the Size setting. The game window is polled every 50ms while
anything is showing, since moving it writes nothing to the log; the highlight layer is
moved by the same loop. Dragging or resizing an unlocked overlay saves a new placement
(`overlay-places.json`); moves made by the layout itself are told apart by comparing
against the bounds it last set. The build prompt grows the odds window by adding to
its height while it's up.

The main window's bounds are persisted in `windows.json` on `moved` / `resized`.

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
      heroSelect.ts   lobby tribes (tesseract.js) and tavern slots, from captured frames
      stream.ts       frames of the Hearthstone window via the Rust module
      native.ts       loads native/capture.node (built from native/capture, Rust)
      bannerRect.ts   find the "Choose a Hero" plate by colour (pure)
      tribeNames.ts   OCR text → race codes, fuzzy-matched (pure)
      shopSlots.ts    find tavern cards by their tier shields (pure)
      gameWindow.ts   Hearthstone client rect via user32 (koffi), converted to DIPs
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

Two runtime dependencies: `tesseract.js` (OCR for the tribe banner — see below) and
`koffi` (in-process user32 calls to find the game window; it replaced a PowerShell
lookup that started the C# compiler every time).
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
a thin Electron half in `heroSelect.ts`.

Frames come from a Rust module (`native/capture`, loaded by `native.ts`, wrapped by
`stream.ts`). It keeps one Windows Graphics Capture session on the window titled
`Hearthstone`, opened on the first read (~0.25s) and kept until `stopCapture()`.
`captureFrame(height, fraction)` returns the frame at `height` as BGRA, the layout the
detectors were written against, with only the top `fraction` of its rows filled in (the
rest are zero): the top half for the tavern, the top 40% for the tribe banner. Only that
strip leaves the GPU. It's shrunk there with mipmaps to the nearest level above the
requested height, and box-filtered to the exact size on the CPU. A read takes ~2.5ms.
Callers `stopCapture()` when they're done: the tribe read after hero select, and the
highlight loop when nothing is left to box. Reads return nothing on any failure,
including frames that come back black (logged once), and there's no fallback if the
module can't load.

History: `desktopCapturer.getSources()` thumbnails rendered *every* open window to
return one (~1.3s and 57MB per call at 720p), and memory sawtoothed to 1.1GB. Their
replacement, a hidden window streaming the game through `getDisplayMedia`, copied a
whole video frame from the GPU per read. With the boxes on and a read every second, the
user's mouse froze at random moments.

**Lobby tribes, from the screen only.** The log has no tribe list. Collecting tribes
from the pool minions that turn up (`IS_BACON_POOL_MINION`) was dropped: nothing shows
before the hero is picked, some tribes only appear in round 2, and a dual-tribe card (a
Demon/Naga) added Naga to a lobby, and a season, that had none. The hero-select screen
lists them all in a text banner (Hearthstone's font, not icons). So the moment heroes
are offered (`BACON_HERO_CAN_BE_DRAFTED`, on the GameState stream), `Tracker` reads
`readLobbyTribes()`, then once a second until a read adds nothing new (two reads agree),
the hero is picked, or 70 tries. A read before the banner is up costs a capture and a
colour scan, with no OCR:

1. `findBannerRect` locates the purple "Choose a Hero" plate by colour. A fixed
   window-relative rect was tried and dropped: tesseract needs a tight crop, and the
   plate's position can't be derived from the window size.
2. The crop is OCR'd twice (`SPARSE_TEXT` and `AUTO` segmentation) and the results
   merged, because neither mode is reliable alone at both 4K and 1080p.
3. `parseTribeBanner` maps each word to the nearest tribe by Levenshtein, with the
   allowance scaled to word length; non-tribe words are dropped.

Results accumulate across attempts and are the snapshot's `tribes`. They're saved with
the match, and with the game's build choice (`build-choice.json`), so a tracker restarted
mid-game gets them back. An empty read means "don't know": a failed read, or a tracker
first started after hero select, leaves the lobby's tribes unknown.
The tesseract worker is created lazily and its ~5 MB language data is cached in
`userData/carddata/` (tesseract.js defaults to the working directory, which is wrong
for a packaged app).

**Where the tavern cards are.** `shopSlots.ts` finds each offered card by the magenta
tier shield at its top edge, which nothing else on the shop screen shares; card size
is derived from the slot pitch (`CARD_WIDTH`, `CARD_ASPECT`). The log gives each offered
minion's `ZONE_POSITION` (`BgSnapshot.shop[].pos`), and the slot is matched on that
rather than by counting minions, because tavern spells take slots too.
Before drawing, the number of slots found on screen must equal `BgGame.tavernSize()`:
the log's count of tavern cards, spells included (tavern spells are
`BATTLEGROUND_SPELL` entities in the same `PLAY` zone, with their own
`ZONE_POSITION`). A missed end shield, or a read taken while cards are still sliding
after a purchase, shows up as a mismatch, and that read draws nothing.
While a wanted minion (or, with *Debug minion highlight*, any minion) is on offer,
`Tracker.readHighlights` reads the tavern 0.25s after the tavern changes, then every
0.25s for as long as there's something to box (~2.5ms a read). The boxes move only when
two reads in a row agree on a new position. The tavern can move after it looks settled:
after a spell was bought, the cards held their old places for a moment, then re-centred.
And a one-read blip shouldn't move them: a freeze makes the cards hop. The log can't
say where cards *are*, only which slot they're in, so the screen is the authority on
position. Any change to what's on offer clears the boxes at once. In Duos, a frame showing your
teammate's board (`vision/duoView.ts`: a cyan swirl in both top corners, which the log
never mentions) clears them until your board is back. A captured frame is the visible window, title bar included (DWM's extended
frame bounds), while the boxes are drawn over the client area, so `gameWindow.ts`
returns both: boxes are scaled by the captured size and shifted by the client area's
offset inside it. In fullscreen the two are the same; windowed at 150% the frame was
1924×1127 around a 1920×1080 client area, offset (2, 45). A result is dropped if the
tavern moved on while it was being read. When nothing is left to box, the loop stops
and closes the capture session. Any failure means no boxes, never misplaced
ones. Moving or resizing the game window is followed too, since reads never stop.

## Builds flow

1. **Hero picked.** `heroPicked` reads `MULLIGAN_STATE = DONE` on your player entity (in
   Battlegrounds the mulligan *is* the hero choice) from state rather than waiting for
   the tag change, so it also holds for a game replayed after a restart, or a log that
   opens on a state dump.
2. **Offer.** `buildsToOffer()` (exported from `tracker.ts`, tested) returns the builds
   whose `tribe` is in the lobby (or empty), but only after the hero pick, only in game,
   and never once answered or with a build already selected. That becomes
   `snapshot.buildPrompt`. It's withdrawn when combat starts, and the Tracker marks
   it answered, so a prompt left open into the first fight counts as "Not this game".
3. **Answer.** `builds:select` → `Tracker.selectBuild(id | null)` marks it answered.
   The answer is saved to `build-choice.json` keyed to the game (log folder plus the
   timestamped `CREATE_GAME` line), so a tracker restart mid-game replays into the same
   key and restores it; a new game starts clean. The Live page's "Going for" selector
   can change it at any time.
4. **Follow.** The build overlay shows progress from `snapshot.board` and
   `snapshot.shop`; the highlight layer boxes wanted minions that are on offer and not
   already owned (goldens count as owned).
