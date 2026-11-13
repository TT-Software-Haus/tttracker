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

### M8 — "Pick a build" on the lobby overlay

The snapshot gains `heroPicked: boolean` (a log fact the Tracker already holds).
The lobby overlay shows the button when `heroPicked && !selectedBuild &&
!buildPrompt?.length` and there's at least one build, reusing M7's `BuildPicker`.

**Verify:** vitest for the show/hide condition, plus Playwright against the stubbed
lobby overlay (declined → button → list → pick).

### M9 — Minion detail on hover in the build sidebar

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
