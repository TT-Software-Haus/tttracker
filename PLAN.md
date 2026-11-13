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
  No OpenCV dependency: `desktopCapturer` → `nativeImage.toBitmap()` → raw
  RGBA, matched against 11 reference crops. `matchTemplate` is the documented
  upgrade path if plain matching proves fragile across resolutions.

## Milestones

### M1 — Build data model, storage, Builds page ✅ done (`ee00a82`)

`Build` type in `src/shared/types.ts`; `builds.json` via the existing
`JsonFile<T>` in `store.ts`; `builds:list` / `builds:save` / `builds:delete`
IPC + preload, broadcasting `data:changed` like `matches:delete` does. A
`Builds` page in the sidebar: list, create, rename, pick tribe, add/remove
target rows (`by turn N` + minion picker reusing `usePool()` and `MinionCard`).

**Verify:** create a build, restart the app, it's still there; delete works.

### M2 — Reading the lobby's tribes off the hero-select screen

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

**Risks:** the strip's position varies with resolution and UI scale, so this
needs the same calibration knob as M6 — build it once, share it. Fullscreen vs
windowed capture differs. If matching is unreliable, fall back to the log's
accumulating tribe list rather than prompting on a wrong read.

**Verify:** capture a real hero-select frame, assert the matcher returns the
tribes actually on screen.

**Status: NOT closed.** Verified: the parser (5 tests — OCR typos, loose crops,
and that unrelated UI words don't invent a tribe), tesseract end-to-end in Node
against a rendered banner (clean read → correct race codes), and
`require("tesseract.js")` being externalised rather than inlined by
electron-vite. **Outstanding:** `DEFAULT_BANNER_RECT` is eyeballed off a stream
screenshot and has never met a real Hearthstone frame. Needs one live
hero-select to confirm or calibrate. Failure is inert — an empty read falls
back to the log's tribe list — so it sits on the branch safely until then.

### M3 — Selecting a build, and the post-hero-pick prompt

Tracker holds `selectedBuildId` for the current game, cleared on game end.
`BgSnapshot` gains `buildPrompt?: Build[]` (populated once, when the hero is
locked in and ≥1 configured build's tribe is in the tribes M2 read off the
screen) and `selectedBuild?: Build`. New IPC `selectBuild(id | null)`. The odds
overlay grows a prompt card; it needs the overlay clickable, so the prompt
temporarily un-ignores mouse events and restores the locked state on
answer/dismiss.

**Verify:** replay a fixture log through the tracker with a matching build
configured; prompt appears once, selection sticks, clears on game over.

### M4 — Build sidebar overlay

Third overlay window (`kind=build`), same machinery as odds/lobby: own entry in
`updateOverlays()`, own saved rect in `windows.json`, own `showBuild` setting
and Setup toggle. Shows the selected build's current target (the earliest
target whose `byTurn >= round`), each minion ticked off if it's already on
`snapshot.board`, plus turns-remaining. Only visible when a build is selected.

**Verify:** run the app with a build selected; overlay shows the right target
for the turn and ticks minions as they land on the board.

### M5 — Shop detection

During shop phase the tavern minions sit in the opposing controller slot —
`boardOf(this.dummyPlayerId())` already reads exactly that set (it's reused for
the opponent's board in combat). Confirm against a fixture, then add
`shop: BoardMinion[]` to `BgSnapshot`, populated only when `phase === 'shop'`.
The build sidebar flags any target minion currently on offer.

**Risk:** the dummy slot may also hold leftovers from the previous combat, or
the tavern may be a different controller entirely. This milestone is a spike
first; if the slot is wrong, parse the `BaconShop8PlayerEnchant` refresh
trigger instead.

**Verify:** new test over an existing fixture asserting shop contents at a few
known turns; then eyeball it live.

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
- None blocking. M5 has a spike that could change its approach; I report what I
  find rather than re-ask.
