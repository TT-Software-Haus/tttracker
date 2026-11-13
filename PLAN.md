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
- Prompt fires **after hero pick**, lists builds whose `tribe` is in
  `snapshot.tribes`, is dismissable, and the build is also selectable manually.
- Prompt renders **in the overlay**, over the game.
- "Highlight minions" is built two ways (user asked for both): shop-offer
  flagging from the log, *and* geometric highlight boxes drawn over the real
  game window. No screen capture, no image recognition — see M5.

## Milestones

### M1 — Build data model, storage, Builds page

`Build` type in `src/shared/types.ts`; `builds.json` via the existing
`JsonFile<T>` in `store.ts`; `builds:list` / `builds:save` / `builds:delete`
IPC + preload, broadcasting `data:changed` like `matches:delete` does. A
`Builds` page in the sidebar: list, create, rename, pick tribe, add/remove
target rows (`by turn N` + minion picker reusing `usePool()` and `MinionCard`).

**Verify:** create a build, restart the app, it's still there; delete works.

### M2 — Selecting a build, and the post-hero-pick prompt

Tracker holds `selectedBuildId` for the current game, cleared on game end.
`BgSnapshot` gains `buildPrompt?: Build[]` (populated once, when the hero is
locked in and ≥1 configured build's tribe is in `snapshot.tribes`) and
`selectedBuild?: Build`. New IPC `selectBuild(id | null)`. The odds overlay
grows a prompt card; it needs the overlay clickable, so the prompt temporarily
un-ignores mouse events and restores the locked state on answer/dismiss.

**Risk:** "hero has been picked" needs a concrete signal in `BgGame` — likely
the friendly player's hero entity leaving the hero-select set. Spike this first;
fall back to `round >= 1` if the clean signal isn't there.

**Verify:** replay a fixture log through the tracker with a matching build
configured; prompt appears once, selection sticks, clears on game over.

### M3 — Build sidebar overlay

Third overlay window (`kind=build`), same machinery as odds/lobby: own entry in
`updateOverlays()`, own saved rect in `windows.json`, own `showBuild` setting
and Setup toggle. Shows the selected build's current target (the earliest
target whose `byTurn >= round`), each minion ticked off if it's already on
`snapshot.board`, plus turns-remaining. Only visible when a build is selected.

**Verify:** run the app with a build selected; overlay shows the right target
for the turn and ticks minions as they land on the board.

### M4 — Shop detection

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

### M5 — Geometric highlight over the game window

A click-through, transparent, full-screen overlay window that draws a box over
each shop slot holding a target minion. Slot position is **computed**, not
seen: Hearthstone lays the tavern out centred in a fixed band, so slot rects
are a function of the game window rect and the offer count. Game window rect
comes from `GetWindowRect` via a `powershell -Command Add-Type …` call, in the
same idiom as the existing `reg.exe` / `tasklist` shelling. Setup gets
calibration sliders (x/y offset, width, height, gap) because no fixed geometry
survives every resolution and UI scale untouched.

**Risk:** highest of the five, and it depends on M4. If the geometry can't be
made to line up acceptably, M1–M4 still ship a complete, useful feature and
this one gets dropped.

**Verify:** run the app alongside the game, windowed and fullscreen, and check
the boxes land on the right minions.

## Open questions

- None blocking. M2 and M4 each have a spike that could change their approach;
  I'll report what I find rather than re-ask.
