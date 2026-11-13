# UI

`src/renderer/src/`. React 19, no router, no state library, no CSS framework.

## State

There isn't a store. Five hooks in `lib.ts` own everything shared:

| Hook | Source | Updates on |
| --- | --- | --- |
| `useSnapshot()` | `api.snapshot()` | `onSnapshot` push |
| `useSettings()` | `api.settings()` → `[settings, update]` | `onSettingsChanged` push |
| `useMatches()` | `api.matches()` | `onDataChanged` → re-invoke |
| `useBuilds()` | `api.builds()` → `[builds, save, remove]` | its own `save`/`remove` (local state updated optimistically; no broadcast) |
| `usePool()` | `api.pool()` | once; module-level promise cache, cleared if the pool came back empty |

Each hook holds its own `useState`, so two components calling `useSnapshot()` have
independent copies (they just receive the same pushes). Everything else is local
`useState` plus `useMemo` for derived lists.

## Main window

CSS grid shell: `220px` sidebar, `36px` title bar row. The title bar is
`-webkit-app-region: drag` with 150px of right padding to clear the Windows caption
buttons drawn by `titleBarOverlay`.

Six pages, selected by a single `useState<Page>('live')`:

**Live game** — hero chip (portrait, tier, health+armor), then the **"Going for"**
selector (`BuildBar`, hidden when there are no builds): a `<select>` that calls
`selectBuild()`, with builds for this lobby's tribes grouped first. It's the way back to
a build after the prompt was dismissed or the tracker restarted mid-game. Then a
two-column grid:

- *Combat panel*: opponent, `ResultBadge`, `OddsBar`, then their board / their reserve /
  your board / your reserve stacked. Titled "Fighting" during the live fight,
  "Last fight · turn N" afterwards. Out of combat it shows "Your warband now".
- *Lobby panel*: tribe chips + `LobbyList` with one expandable row.

Below: "This game's fights" (`RoundsTable`) and the session panel.

**Minions** — the whole tavern pool, grouped by tier 1–7, searchable by name or text,
filterable by tribe. "Only this lobby's tribes" is on by default and uses
`snapshot.tribes`; an explicit tribe filter overrides it.

**Builds** — saved builds, each expanding into `BuildEditor`: name, tribe, stages
(`by turn N` + up to 7 minions, picked from `Picker` — tribe tabs, every tier, card
text) and addon cards. Three ways in besides **New build**:

- **Find build** (`FindBuild`) — HSReplay's published comps via `comps()`; picking one
  also fetches its addons with `compAddons(url)` and stamps `source`. The comp pages
  carry no turn guidance, so the single stage defaults to turn 8.
- **Import** (`ImportBuild`) — paste an `HTB …` code; decoded in main by `importBuild()`.
- **Share** (`ShareBuild`, inside the editor) — `exportBuild(id)` → code to copy.

**History** — All/Solo/Duos, newest first. Place badge, hero, final board, relative
time. Click to expand: tribes, start time, delete (behind a `confirm`), and the full
`RoundsTable` of that match.

**Stats** — mode and 7/30/All-day filters. Games / avg placement / top-half rate /
firsts; a placement distribution bar chart; **simulator accuracy** (predicted win% in
five buckets vs actual win rate, skipping any fight with `unsupported` effects); per-hero
results; and average placement by dominant final-board tribe.

**Setup** — polls `setupStatus()` every 3 s and shows four checks: install found, game
logging enabled (with the **Enable logging** button → `fixLogConfig()`), reading the
game log, card database loaded. Plus overlay toggles (enabled / odds / lobby / locked),
opacity and scale sliders, and the `simIterations` slider. The overlay toggles include *Build sidebar (right)*
(`showBuild`).

## Shared components — `components.tsx`

| Component | What it is |
| --- | --- |
| `MinionCard` | Art tile, tier pip, keyword glyphs (Reborn ✚, Venomous ☠, Windfury ≋), attack/health gems; variants for golden/taunt/divine shield/stealth |
| `Board` | A row of `MinionCard`s at size `sm`/`md`/`lg`, with an empty state |
| `HeroPortrait` | Circular art, desaturated when `dead` |
| `OddsBar` | Win/tie/loss counting up, segmented bar, `Deal ~X` / `Take ~Y` / lethal chances, the `partial` warning, and `Not modelled: …` |
| `ResultBadge` | Won / Lost / Tied, optionally `· N dmg` |
| `LobbyList` / `LobbyRow` | The leaderboard; FLIP-animated reordering, expandable last-known board, damage floats on health loss |
| `TribeChips` | Coloured tribe chips (`--tc` custom property) |
| `SessionStrip`, `Stat`, `Pill` | Session placements, big-number tiles, small pills |
| `CardText` | Card text with Hearthstone's bold/italic emphasis kept (Minions page, picker, build tooltip) |

`OddsBar` takes a `fightKey` so a mid-fight odds revision (a Duos teammate arriving)
renders a ▲/▼ delta chip, while a *new* fight resets instead of showing a bogus delta.

## Overlay windows

One bundle, four kinds, chosen once at module load from `?kind=`: `odds` (default),
`lobby`, `build`, `slots`.

**Odds overlay** — the current (or last) fight's `OddsBar` with the opponent's portrait
and result. Keyed by round, so each new fight replays the slide-in; the card persists
through the following shop phase until the next fight replaces it.

**Build prompt** — rendered *inside the odds overlay*, above the odds card, while
`snap.buildPrompt` is non-empty: "Going for a build?" with one button per matching build
and a dismiss. Either answer calls `selectBuild(id | null)`, which clears the prompt for
the rest of the game. While it's up, main makes the odds window clickable regardless of
the lock setting, and grows it (`growOddsForPrompt`) so the prompt doesn't push the
odds out of view; both revert once it's answered, without touching saved bounds.

**Picking a build from the overlays.** The lobby overlay shows **Pick a build** while
`snap.buildPickable` is set (hero locked in, nothing chosen, no prompt up), and the build
overlay has **Change** in its header. Either one swaps that overlay's content for
`BuildPicker`: every saved build, this lobby's tribes first, plus Cancel. Locked
overlays stay click-through; buttons and the picker use `useClickZone()`, which calls
`setInteractive()` on pointer enter/leave so the window takes clicks only while the
pointer is over them.

**Build overlay** (`kind=build`) — right-hand sidebar for `snap.selectedBuild`: the
current stage (the first whose `byTurn` hasn't passed, else the last), `have/total`,
turns left or overdue, and each minion and addon ticked if owned or flagged *in shop*
if it's in `snap.shop`. Logic is `buildProgress()` in `lib.ts`; goldens count as the
minion. Hovering a row shows a tooltip with tier, tribes and `CardText`. It's
positioned from the row's `offsetTop` against the card, not inside the scrolling list,
and flips above rows in the card's lower half. Hidden until a build is selected, even
with `showBuild` on.

**Highlight layer** (`kind=slots`) — gold boxes drawn at `snap.shopHighlights`, which
are already in Hearthstone client-area coordinates. Main keeps this window sized
exactly over the game's client area (`updateHighlightWindow`), is always
click-through, unfocusable, and hidden whenever there are no boxes. It isn't a
positionable overlay and ignores `locked`. See
[architecture.md](architecture.md#screen-reading--srcmainvision) for where the boxes
come from.

**Lobby overlay** — turn, session strip, tribe chips, and the `LobbyList`. The expanded
row defaults to the next opponent that has a known board, and follows the mouse on
hover.

### Locked vs unlocked

Driven entirely from `settings.overlay` by `updateOverlays()` in the main process:

```ts
const clickable = kind === 'odds' && prompting   // build prompt is up
const on = kind === 'odds' ? showOdds || prompting : kind === 'lobby' ? showLobby : showBuild && !!selectedBuild
const wanted = enabled && on && (inGame || !locked)
win.setIgnoreMouseEvents(locked && !clickable, { forward: true })
win.setFocusable(!locked || clickable)
win.setOpacity(opacity)
```

- **Locked** (default): click-through, so the game receives every click. `forward: true`
  keeps mouse-*move* events flowing to the renderer, which is what still makes lobby-row
  hover work.
- **Unlocked**: interactive, with a dashed outline, a translucent backdrop and a
  "Drag to position · lock in Setup" strip. Unlocked overlays also stay visible out of
  game, so they can be positioned without starting a match.

`scale` is applied as CSS `zoom` on the overlay root. It scales content but not the
window, so a large scale can overflow a saved window size.

## Animation — `anim.ts`

No library. Three hooks, all honouring `prefers-reduced-motion` (plus a global CSS
`@media (prefers-reduced-motion: reduce)` block):

- `useAnimatedNumber(target)` — rAF tween with `easeOutCubic`, starts from 0 so
  percentages count up.
- `useChange(value, resetKey)` — the delta since the last value, *unless* `resetKey`
  changed; drives `OddsBar`'s delta chip and health-drop floats.
- `useFlip(deps)` — measures `[data-flip-id]` elements, and animates any row that moved
  with a Web Animations `translateY` over 450 ms. Vertical only; entering and leaving
  rows aren't animated.

## Styling

`styles.css`, ~1860 lines, one hand-written stylesheet imported by both entries. Dark
theme only; custom properties on `:root` (`--bg #0b0d12`, `--accent #f0b232`,
`--win #3ecf8e`, `--loss #f0605a`, `--radius 12px`, …). `--bg` matches the window
`backgroundColor` and the title bar overlay colour in main, so there's no flash on load.

Per-instance colours are passed inline as custom properties (`--tc` tribe, `--pc`
placement) rather than as classes. `-webkit-app-region` appears in exactly two places:
`.titlebar` and `.overlay.unlocked`. `.overlay-body { background: transparent }` is what
makes the transparent windows actually transparent.
