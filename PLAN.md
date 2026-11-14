# PLAN — Builds

Add a **Builds** menu option: configure target boards per minion tribe with a
"by turn N" stamp, prompt for one after hero pick when the lobby has a matching
tribe, and surface the target minions while you play — in a sidebar overlay, in
the shop (flagging offered minions), and as highlight boxes drawn over the game
window.

Branch: `feature/builds`, forked from `develop`.

## Decisions already taken

- A build = `{ id, name, tribe, targets: [{ byTurn, minions: cardId[] }] }`,
  targets ordered by turn, max 7 minions each.
- Prompt fires **after hero pick**, lists builds whose `tribe` is in the lobby,
  is dismissable, and the build is also selectable manually.
- Prompt renders **in the overlay**, over the game.
- "Highlight minions" is built two ways (user asked for both): shop-offer
  flagging from the log, *and* geometric highlight boxes drawn over the real
  game window — see M6.
- **The lobby's tribes are read off the screen, not the log.** Measured on a
  real game: zero pool-minion markers appear before the hero is locked in, and
  only 5 of 7 tribes are known by round 1 (ELEMENTAL not until round 2). The
  hero-select screen shows them all up front, so that's where they come from.
  Done with `desktopCapturer` + `tesseract.js`, not OpenCV: a real frame showed
  the banner is *text* in Hearthstone's font, so there are no icons to template
  match. (The tribe icons on streamers' screens are HDT's overlay, not the
  game.) `tesseract.js` is the project's one runtime dependency.

## Milestones

### M1 — Build data model, storage, Builds page ✅ done (`ee00a82`)

`Build` type in `src/shared/types.ts`; `builds.json` via the existing
`JsonFile<T>` in `store.ts`; `builds:list` / `builds:save` / `builds:delete`
IPC + preload, broadcasting `data:changed` like `matches:delete` does. A
`Builds` page in the sidebar: list, create, rename, pick tribe, add/remove
target rows (`by turn N` + minion picker reusing `usePool()` and `MinionCard`).

**Verify:** create a build, restart the app, it's still there; delete works.

### M2 — Reading the lobby's tribes off the hero-select screen ✅ done

`src/main/vision/`. `desktopCapturer` grabs the Hearthstone window, the banner
is cropped from a window-relative rect, and `tesseract.js` OCRs it; each token
goes to its nearest tribe name by Levenshtein, with the allowance scaled to
word length. The banner is text in Hearthstone's own font, not icons — the
icon strip on streamers' screens is HDT's overlay, not the game — so OCR it is.
`tesseract.js` is the one runtime dependency in the project; its ~5 MB language
data caches into `userData` (**not** the working directory, which is where
tesseract.js puts it by default and would break a packaged app).

Trigger: the friendly player's `MULLIGAN_STATE` hits `DONE` (in Battlegrounds
the mulligan *is* the hero choice — verified against a real log: `CREATE_GAME`
at line 256, `MULLIGAN_STATE=DONE` at 1,774, first shop at 2,059).

No calibration knob in the end: the plate is found by colour at run time, so
resolution, aspect and UI scale don't need configuring.

**What real frames overturned, in order:**

1. **The fixed rect was wrong and the idea was wrong.** The banner sat 640px
   right of where centring predicts. Replaced by colour detection.
2. **The trigger was at the wrong end.** `MULLIGAN_STATE=DONE` is when hero
   select *closes* — measured: heroes offered 11:19:59, DONE 11:21:08, shop
   0.4s later. Now starts when heroes are offered and retries across the ~70s
   window.
3. **Tesseract's layout guesser is not deterministic enough to rely on.** A
   one-pixel change in the crop lost a tribe. A character whitelist helped, but
   no single segmentation mode proved reliable — see below.

**Closed against two live resolutions.** 4K read all five tribes first time.
1080p lost one — "Dragons, Murlocs, Pir" — which turned out to be two separate
faults: the gold emblems sitting on the plate were inside the crop (fixed by
tightening onto text-coloured pixels, blue well above green, where the emblems
are almost blue-free), and tesseract's segmentation mode, where neither
available mode is reliable alone. Both modes now run and merge. The poller also
accumulates across attempts rather than keeping its first answer. Failure stays
inert — an empty read falls back to the log's tribe list.

### M3 — Selecting a build, and the post-hero-pick prompt ✅ done

Tracker holds `selectedBuildId` for the current game, cleared on game end.
`BgSnapshot` gains `buildPrompt?: Build[]` (populated once, when the hero is
locked in and ≥1 configured build's tribe is in the tribes M2 read off the
screen) and `selectedBuild?: Build`. New IPC `selectBuild(id | null)`. The odds
overlay grows a prompt card; it needs the overlay clickable, so the prompt
temporarily un-ignores mouse events and restores the locked state on
answer/dismiss.

**Verify:** replay a fixture log through the tracker with a matching build
configured; prompt appears once, selection sticks, clears on game over.

**Closed in a live game:** the prompt appeared after the hero was locked in
and was clickable over Hearthstone, which confirms the `setIgnoreMouseEvents`
dance — the one thing no amount of offline testing could show. Also verified:
the offer gate
(`buildsToOffer`, 8 tests — won't fire before hero pick, after an answer, out
of game, or with no tribe match), and the overlay prompt driven in Playwright
(both builds render, the lobby overlay correctly ignores it, clicks dispatch
`b1` then `null`, and it fits the 440×170 default window with no overflow).


### M3.5 — "Find build": import from HSReplay's comps ✅ done

Added mid-flight at the user's request. `src/main/comps.ts` pulls the 33
published Battlegrounds comps and offers them as starting points on the Builds
page; choosing one creates a build pre-filled with the name, tribe and core
minions, credited to HSReplay/JeefHS with a link back to the original guide.

Why it works the way it does:

- **No API, and node:fetch can't reach it.** Cloudflare answers 403 to
  anything that isn't a browser, whatever headers you send — the block is on
  the TLS fingerprint. Electron's `net` module uses Chromium's network stack
  and gets a 200, so no hidden BrowserWindow is needed.
- **No scraping.** The page server-renders everything into
  `<script id="react_context">`, so it's one regex and a `JSON.parse`.
- **Detail pages are reachable after all.** I first recorded them as blocked,
  on the strength of Playwright hitting a Cloudflare interstitial. Electron's
  `net` returns 200 for them too, and they carry `comp_addon_cards`, which the
  list page doesn't — so addons are prefilled, fetched when a comp is actually
  used rather than 33 times on open. There is still no turn guidance in the
  data ("when to commit" is prose), so the stage turn stays a default.
- `comp_core_cards` are dbfIds, which `CardDb.byDbfId` already resolves.
- Comp names read "Quilboar - APM Shop Buff", so the tribe comes from the same
  word-matching table the OCR uses. "Menagerie" is the one comp with no tribe,
  which is why a build may now have an empty tribe meaning "any lobby".

**Verified:** 5 tests on the page contract (including that a missing blob
throws rather than silently importing nothing); all 8 sampled dbfIds resolve to
real minions against the live card database; the picker driven in Playwright —
tier badges, card art, attribution link, and "Use" producing a correct build
with its source recorded.

**Expect this to break** when HSReplay restructures the page. It fails with a
readable message and offers the link instead.

### M4 — Build sidebar overlay ✅ done (`5592a0f`)

Third overlay window (`kind=build`), same machinery as odds/lobby: own entry in
`updateOverlays()`, own saved rect in `windows.json`, own `showBuild` setting
and Setup toggle. Shows the selected build's current target (the earliest
target whose `byTurn >= round`), each minion ticked off if it's already on
`snapshot.board`, plus turns-remaining. Only visible when a build is selected.

**Verify:** run the app with a build selected; overlay shows the right target
for the turn and ticks minions as they land on the board.

**Verified:** `buildProgress` has 8 tests covering the turns where the stage
choice is ambiguous (on the deadline turn, just past it, all deadlines passed,
stages stored out of order, golden copies). The overlay was driven in
Playwright across five states — early, due this turn, overdue, complete, and no
build selected (renders nothing) — all correct, no overflow at the default
240x420.

### M5 — Shop detection ✅ done (`5934d7f`)

During shop phase the tavern minions sit in the opposing controller slot —
`boardOf(this.dummyPlayerId())` already reads exactly that set (it's reused for
the opponent's board in combat). Confirm against a fixture, then add
`shop: BoardMinion[]` to `BgSnapshot`, populated only when `phase === 'shop'`.
The build sidebar flags any target minion currently on offer.

**Risk:** the dummy slot may also hold leftovers from the previous combat, or
the tavern may be a different controller entirely. This milestone is a spike
first; if the slot is wrong, parse the `BaconShop8PlayerEnchant` refresh
trigger instead.

**Spike result: the hypothesis held, but not where I first looked.** Probing on
the turn boundary showed the dummy slot empty, which nearly sent me to the
screen for this too. Sampling mid-phase showed four pool minions, down to two
by the end of the shop — the missing pair having appeared on my own board.

The hazard is that the slot is shared with combat: read it one phase late and
the warband you're fighting is presented as "on offer". The phase guard is
tested, and the test was confirmed load-bearing by deleting the guard and
watching it fail.

**Verified:** 4 tests over the Duos fixture, sampled at 24 points so they can't
pass by the shop simply never populating (max seen: 5 minions, exact contents
asserted at round 6); 4 more on the in-shop flag, including that an already-owned
minion isn't flagged when the tavern offers another copy. Sidebar driven in
Playwright: exactly one of three target minions flagged, correctly.

### M6 — Geometric highlight over the game window

A click-through, transparent, full-screen overlay window that draws a box over
each shop slot holding a target minion. Slot position is **computed**, not
seen: Hearthstone lays the tavern out centred in a fixed band, so slot rects
are a function of the game window rect and the offer count. Game window rect
comes from `GetWindowRect` via a `powershell -Command Add-Type …` call, in the
same idiom as the existing `reg.exe` / `tasklist` shelling. Setup gets
calibration sliders (x/y offset, width, height, gap) because no fixed geometry
survives every resolution and UI scale untouched.

**Risk:** highest of the six, and it depends on M4. If the geometry can't be
made to line up acceptably, M1–M5 still ship a complete, useful feature and
this one gets dropped.

**Verify:** run the app alongside the game, windowed and fullscreen, and check
the boxes land on the right minions.

## Open questions

- None blocking. M5 has a spike that could change its approach; I report what I
  find rather than re-ask.

---

# Follow-up — picking a build from the overlays, and minion detail on hover

Asked for 2026-11-13: a way back to a build from the overlays after "Not this
game", a way to switch builds from the build sidebar, and tier/tribe/card text on
hover in the build sidebar. Today the only way to change your mind mid-game is
the Live page selector in the main window, which means alt-tabbing out of the game.

## Decisions taken

- **"Pick a build"** goes on the **lobby overlay** (left). It shows once the hero
  is locked in and no build is being followed: after "Not this game", or when no
  build matched the lobby so the prompt never appeared. It doesn't show while the
  prompt is still up.
- **"Change"** goes on the **build sidebar** (right), next to the build name.
- Either button turns *that* overlay into a list of all builds, this lobby's
  tribes first (same grouping as the Live page's `BuildBar`), plus Cancel. Picking
  one calls `selectBuild(id)`. The list opens in the overlay whose button you
  pressed, so there's no cross-window state.
- **Clickable only while hovered.** Locked overlays stay click-through. Mouse
  moves are already forwarded (`forward: true`), so the renderer reports when the
  pointer enters or leaves an interactive element (`overlay:interactive` IPC), and
  main makes *that* window take clicks only while the pointer is there. Clicks on
  the game under the rest of the overlay still go through.
- **Hover detail** in the build sidebar is a floating tooltip with tier, tribe(s)
  and card text, taken from `usePool()`'s `CardInfo`. It's drawn over the rows (or
  above them near the bottom) so the list never shifts.

## Milestones

### M7 — Hover-to-click plumbing, and "Change" on the build sidebar ✅ done

`overlay:interactive` IPC + `window.api.setInteractive(on)`. Main keeps a set of
windows currently hovered and folds it into `updateOverlays()`'s `clickable`,
because that runs on every snapshot and would otherwise reset it. The renderer
also clears the flag whenever the element under the pointer unmounts (picking a
build closes the list, and no `mouseleave` fires). The `BuildPicker` component
(list + Cancel) and the "Change" button go in the build sidebar.

**Verify:** typecheck + tests. Playwright with a stubbed `window.api`: the button
opens the list, picking calls `selectBuild`, and `setInteractive` is called true on
enter and false on leave or close. Real overlay click-through gets checked in your
next game.

### M8 — "Pick a build" on the lobby overlay ✅ done

The snapshot gains `buildPickable` (changed from the planned `heroPicked`). The
Tracker computes it with the pure `canPickBuild()`: hero locked in, in game,
nothing selected, no prompt up, at least one saved build. The Tracker already
holds the build list, so the overlay doesn't need its own copy, which would go
stale because saving doesn't broadcast. The lobby overlay shows the button when
it's set, reusing M7's `BuildPicker`.

**Verify:** vitest for the show/hide condition, plus Playwright against the stubbed
lobby overlay (declined → button → list → pick).

### M9 — Minion detail on hover in the build sidebar ✅ done

Tooltip on each target and addon row: tier, tribe(s) via `tribeLabel`, and card
text via the existing `cardTextParts` (keeps Hearthstone's bold keywords).

**Verify:** Playwright hover screenshot of the stubbed build overlay, including a
row near the bottom (tooltip flips above).

## Risks

- **Hover-to-click over the live game is unproven,** like M6's click-through. If a
  forwarded `mouseleave` goes missing, the overlay could stay clickable. The
  unmount reset covers the known case. If it still sticks in a real game, the
  fallback is to drop the flag on a timer.
- Clicking a focusable overlay takes focus from Hearthstone, which is the same
  trade-off the build prompt already makes.

---

# Follow-up — a description on each build

Asked for 2026-11-13: every build gets a free-text description. "Find build"
fills it from the comp's **How to Play** section, and the build sidebar shows it
under the minions to buy.

## What HSReplay gives us

Checked against live comp pages: the detail page's `react_context` blob carries
`comp_how_to_play`. It's one 480–800 character paragraph with no newlines or
formatting, except card names written as `[[Felboar||110664]]` (name, dbfId).
That's the same page `fetchCompAddons` already loads, so it adds no request.

## Decisions taken

- `Build.description?: string`, stored with HSReplay's `[[Name||dbfId]]` links
  intact so the cards can be resolved at display time. Typed text is plain.
- **Not in share codes.** Codes stay ~90 chars, and an imported build arrives
  without a description.
- **No backfill.** Builds already made from HSReplay stay empty unless edited.
- **Sidebar shows it in full**, under the minions and addons. The *whole
  sidebar* scrolls (rather than only the minion list), so a long guide can't
  squeeze the list to nothing.
- **Card names render bold, and hovering one shows the same tier/tribe/text
  tooltip** as the minion rows. Names that resolve to no known card stay bold
  with no tooltip.

## Milestones

### M10 — Description on a build, filled by Find build ✅ done

`description` on `Build`. `fetchCompAddons` becomes `fetchCompDetail`, returning
`{ addons, howToPlay }`, and the `comps:addons` IPC becomes `comps:detail`, so
one request still serves both. `useComp` stores the text. The Builds editor gets
a Description textarea.

**Verify:** vitest for the parser (the field present, absent, and its markup
preserved) and that share codes ignore `description`. Playwright on the Builds
page with a stubbed `window.api`: Find build → the description is filled and
editable.

### M11 — Description in the build sidebar ✅ done

A `parseCardLinks` helper in `lib.ts` (text → plain and card-link parts, tested)
renders the description with bold names. The sidebar card becomes the scroll
container, and the tooltip code is generalised from rows to any element: it uses
offsets in the card's content coordinates, and above-placement uses a transform,
since `bottom` doesn't track content in a scroll container.

**Verify:** vitest for `parseCardLinks`. Playwright on the stubbed build overlay:
the description renders under the minions, hovering a name shows its card, the
sidebar scrolls at 520px, and the minion row tooltips still land correctly after
scrolling.

---

# Follow-up — capture Hearthstone with a single-window stream

Asked for 2026-11-13, after measuring the current capture live.
`desktopCapturer.getSources()` renders a thumbnail of *every* open window (24
here) and keeps one: ~1.3s and 57MB per call at 720p, 227MB at 2560x1440. The
tavern loop calls it every couple of seconds through a shop phase. Memory saw-
toothed to 1.1GB at full size, and the main process sits at ~40% of a core
while it runs.

## What the probe showed

A hidden window streaming one window via `getDisplayMedia` (main answers with
that window through `setDisplayMediaRequestHandler`): listing windows without
thumbnails 0.5s plus starting the stream 0.27s, once; then 13–17ms per frame
read, one frame (~3.5MB) at a time. Frames arrive at the window's own aspect
ratio, capped at the requested height. Chromium only sends frames when the
window changes, so `ImageCapture.grabFrame()` rejected when nothing had changed;
drawing from a `<video>` element always yields the latest frame. The page must
be a secure context (`file://` or `localhost`), as the app's already are.

## Decisions taken

- **Stream lifetime:** open only while something needs it: through the tribe
  read at hero select, and while the highlight loop has boxes to draw. Closed
  otherwise, combat included.
- **Tribe OCR moves to the stream too**, at full resolution (1440 high) during
  hero select. The tavern uses 720 high. One stream at a time, reopened if the
  requested height changes.
- **No fallback.** If the stream can't open or stops delivering, there are no
  boxes (and no tribes read off the screen, which already falls back to the
  log), with a warning logged; the next read tries again.
- Detection stays in main, unchanged: the capture window sends back a BGRA
  frame (swapped from canvas RGBA), the same layout `toBitmap()` gave.

## Milestones

### M12 — Stream capture, used for the tavern ✅ done (`e2b730b`)

A hidden capture window (`overlay.html?kind=capture`, `backgroundThrottling:
false`) and a `vision/stream.ts` in main: `captureFrame(height)` opens the
stream on first use (finding the Hearthstone source without thumbnails, then
starting it in the capture window) and returns `{ width, height, bgra }`;
`stopCapture()` closes it. `readShopSlots` uses it at 720; the highlight loop
calls `stopCapture()` when it stops.

**Verify:** typecheck and tests. In real Electron against a stand-in window
titled "Hearthstone": frames arrive at the right size, the stream closes when
told, and repeated reads hold memory flat (vs the 1.37GB loop). Then live shop
phases in Hearthstone's **Fullscreen** and **windowed** modes: boxes as before,
no black frames, and the main process's CPU during shops.

### M13 — Tribe OCR on the stream; drop thumbnail capture ✅ done

`readLobbyTribes` reads a 1440-high frame from the stream and crops the banner
from it (`nativeImage.createFromBitmap` → `crop` → `toPNG`); the tribe read
calls `stopCapture()` when it finishes. The thumbnail capture path is deleted.

**Verify:** typecheck and tests, the banner tests against saved frames, then a
live hero select: the tribes read as before.

## Risks

- **Fullscreen must work** (asked for at approval). Hearthstone's Fullscreen
  setting on this machine lets other windows draw over the game (every overlay
  in today's 3840x2160 screenshots), which is borderless-window behaviour, and
  window capture works there. A true exclusive-fullscreen mode would hide all of
  the overlays too, so it was never supported. M12's live step checks
  Hearthstone's Fullscreen *and* windowed modes, and the capture logs a warning
  when a frame comes back black, so a silent capture failure is visible.
- A 0.8s open per shop delays the first box of each shop slightly.

## Status (2026-11-13)

M12 and M13 are built; both wait on a live game before they're committed.
Checked so far against a stand-in window titled "Hearthstone": frames at the
window's aspect, 720 high (1276x720), colour order right after the BGRA swap,
6-11ms per read, memory flat over 20 reads, nothing returned with no window, and
first frame 0.95s after opening at 5fps (2.6s at 2fps). An open stream cost under
1% of a core at 2, 5 and 15fps. The real readLobbyTribes read all five tribes off
a stand-in banner through the stream in 1.7s.

Found during the first live game on the stream: a box occasionally landed on
the tavern spell. A missed end shield shifts every slot one over, and after a
purchase the log updates while the cards are still sliding. Boxes now need the
screen's slot count to equal the log's tavern size, spells included (checked
against the live log at the end of each shop: 4, 4, 5, matching the screen).

Windowed mode, live: the boxes were sized and placed as if the frame were the
client area, but a window capture includes the title bar. gameWindow.ts now also
returns DWM's extended frame bounds (what the capture covers; 1924x1127 around a
1920x1080 client area, offset (2, 45) at 150%), and boxes are mapped through it.
Checked by drawing the computed boxes on a screenshot taken at the same instant:
square on the cards. Fullscreen is unchanged (the offset is zero there).

Still to see live: boxes in Hearthstone's Fullscreen and windowed modes, no
black frames, tribes read at a real hero select, and the main process's CPU
during shops.

---

# Follow-up — overlays that move and scale with the game window

Asked for 2026-11-13, in windowed mode: the odds, lobby and build overlays sit at
the *screen's* edges (or wherever they were dragged) and keep their size, so with
a 1920x1080 game window they float outside it. They should always sit at the
inside edges of the game window, and scale and move with it.

## Decisions taken

- **Anchored to the game's client area**, the same rect the highlight layer
  uses. With no game window (not running), the primary display's work area
  stands in, so positioning out of game still works.
- **Draggable, remembered relative to the game.** Each overlay's position is
  stored as a fraction of the free space inside the anchor:
  `fx = (x - anchor.x) / (anchor.width - width)`, likewise `fy`, clamped to
  0..1. 0 is flush left/top, 1 flush right/bottom, 0.5 centred, whatever the
  window's size or scale, and an overlay can never leave the game area.
  Defaults: odds top-centre, lobby left edge, build sidebar right edge.
  Positions saved before this change are ignored.
- **Scale with the game window's height**: `max(0.6, anchor.height / 1440)`
  times the existing Size slider. 1440 is this monitor's fullscreen height in
  DIPs, so fullscreen looks exactly as it does today; a 1920x1080 window at
  150% (720 DIP high) comes out at the 0.6 floor. Window sizes are stored
  unscaled (a resize while unlocked divides by the scale) and multiplied out;
  page content scales through `webContents.setZoomFactor`, replacing the
  renderer's CSS `zoom`. The highlight layer is untouched (it draws in game
  coordinates already).

## Milestones

### M14 — Overlays placed at the game window's inside edges, following it ✅ done

A pure `src/main/overlayLayout.ts`: `place(placement, anchor, scale)` → bounds,
and `placementOf(bounds, anchor, scale)` for drags. `index.ts` keeps one
placement per overlay (new `overlay-place-*` keys in `windows.json`), lays the
overlays out from the anchor whenever it changes (polled every 0.5s while
overlays are showing, via the microsecond native lookup), and turns a user's
drag or resize into a new placement, ignoring the moves it makes itself. The
build prompt's temporary growth of the odds window works from the scaled size.

**Verify:** vitest for the layout maths (defaults, moved and resized game
window, a drag round-tripping, clamping). Then live in windowed mode: move and
resize the game window; the overlays follow and stay inside it; drag one while
unlocked and it keeps its place relative to the game.

### M15 — Overlays scale with the game window ✅ done

`overlayScale(anchorHeight, userScale)`; window sizes multiplied out, content
via `setZoomFactor`; the renderer's CSS zoom removed.

**Verify:** vitest for the scale (fullscreen 1.0, the floor, the Size slider).
Live screenshots: fullscreen unchanged from today, a 1920x1080 window with
proportionally smaller overlays still readable, and the build sidebar's minion
tooltips still positioned right under the new zoom.

## Risks

- A window's own `setBounds` fires the same `moved` event as a drag; the
  layout code must tell them apart or every follow would be saved as a drag.
- The 0.6 floor is a judgement call about readability at 720 DIP; it's one
  constant if it needs tuning.

## Status (2026-11-13, overlays)

M14 and M15 done and confirmed live in windowed mode. Two things the first live
look found: the overlays lagged a dragged window (the follow poll went from
500ms to 50ms; a look is a microsecond) and the highlight boxes stayed where the
window had been (the highlight layer now moves in the same loop). Scaling to
0.6 then cut the lobby list short, because CSS zoom doesn't adjust `vh`; the
overlay styles use a zoom-corrected `--vh`.

---

# Follow-up — native capture in Rust

Asked for 2026-11-14. With debug highlighting on, the user's mouse froze at
random moments. A 30-minute trace (1s CPU, ~6s GPU samples) showed nothing from
the tracker above ~3% CPU or measurable GPU, so the freeze is short and
system-wide. The suspect: every read draws a whole video frame into a
CPU-backed canvas (`willReadFrequently`), which forces a GPU→CPU copy of the
full frame and makes the GPU stop and wait. A first fix (stop polling once the
boxes have settled, uncommitted) cuts the number of reads; this follow-up cuts
the cost of each one.

## Decisions taken

- **Both reads move to Rust** (tavern boxes and hero-select tribe OCR). The
  hidden capture window, `capture.ts`, and the `getDisplayMedia` handler are
  deleted.
- **Crates:** `napi`, `napi-derive`, `napi-build` for the binding; Microsoft's
  `windows` for Windows Graphics Capture (WGC) and Direct3D 11. No npm
  additions. Built with `cargo build --release` into a `.node` file. Node-API is
  ABI-stable, so there's no rebuild per Electron version.
- **Build:** `npm run dev`/`build`/`dist` run the cargo build first; the
  `.node` is gitignored; electron-builder unpacks it from the asar. Building
  the app now needs Rust (already installed here).
- **No fallback.** If the module fails to load or capture: no boxes, no screen
  tribes (the log still supplies tribes), one warning logged.
- **Detectors and callers unchanged.** `stream.ts` keeps `captureFrame(height)`
  and `stopCapture()`. They now call Rust, which returns the same BGRA frame at
  the requested height, with only the rows the detectors scan filled in: the
  top half for the tavern, the top 40% for the banner. Only those rows are
  copied off the GPU.

## How the Rust side works

One WGC session on the Hearthstone window (found by title, like
`gameWindow.ts`), with a free-threaded frame pool, so no message loop or
dispatcher is needed. It's opened on first read, and closed by `stopCapture()`
or when the window goes away. The yellow capture border is turned off where
Windows allows. A read takes the latest frame and copies only the wanted rows
(`CopySubresourceRegion`) into a strip-sized staging texture. It maps that,
scales it down to the requested height on the CPU (box filter), and returns it.

## Milestones

### M16 — Rust module skeleton, wired into the build ✅ done

`native/capture/` (a cdylib crate) exporting a trivial function, the cargo step
in the npm scripts, a copy to a fixed path, a loader in main that warns once on
failure, and electron-builder `asarUnpack`.

**Verify:** `npm run dev` builds the crate and main calls the function. Tests
and typecheck pass.

### M17 — WGC strip capture in Rust ✅ done

`open()`, `frame(height, fraction)` → `{ width, height, bgra }`, `close()`, as
above.

**Verify:** a scratch Electron script (no visible windows) against the live
game. It saves the frame and checks it against a screenshot, and times reads
(target: a few ms). Memory stays flat over a few hundred reads. Fullscreen and
windowed both work.

### M18 — Switch to the native module; delete the stream

`stream.ts` calls Rust. The capture window, `capture.ts`, `initCapture` and the
display-media handler go. Docs updated (architecture, development:
Rust needed to build).

**Verify:** typecheck and tests. Then live: boxes in a shop phase (windowed and
fullscreen) and tribes at a hero select, with the read times logged. The user
plays with highlighting on and reports whether the freezes are gone.

## Risks

- **WGC inside Electron's main process:** a free-threaded frame pool should
  need no dispatcher, but this is unproven here. M17's probe settles it first.
- **Debugging is harder:** a crash in native code takes down the main process,
  not just a window. The Rust code catches errors and returns them instead of
  panicking across the boundary.
- **It may not be the fix.** If the freezes come from somewhere else (Discord
  was encoding video at a steady 64% of the GPU during the trace), this removes
  a suspect without curing them. The polling fix, the deleted window, and the
  timings still help either way.
