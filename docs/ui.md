# UI

`src/renderer/src/`. React 19, no router, no state library, no CSS framework.

## State

There isn't a store. Four hooks in `lib.ts` own everything shared:

| Hook | Source | Updates on |
| --- | --- | --- |
| `useSnapshot()` | `api.snapshot()` | `onSnapshot` push |
| `useSettings()` | `api.settings()` → `[settings, update]` | `onSettingsChanged` push |
| `useMatches()` | `api.matches()` | `onDataChanged` → re-invoke |
| `usePool()` | `api.pool()` | once; module-level promise cache, cleared if the pool came back empty |

Each hook holds its own `useState`, so two components calling `useSnapshot()` have
independent copies (they just receive the same pushes). Everything else is local
`useState` plus `useMemo` for derived lists.

## Main window

CSS grid shell: `220px` sidebar, `36px` title bar row. The title bar is
`-webkit-app-region: drag` with 150px of right padding to clear the Windows caption
buttons drawn by `titleBarOverlay`.

Five pages, selected by a single `useState<Page>('live')`:

**Live game** — hero chip (portrait, tier, health+armor), then a two-column grid:

- *Combat panel*: opponent, `ResultBadge`, `OddsBar`, then their board / their reserve /
  your board / your reserve stacked. Titled "Fighting" during the live fight,
  "Last fight · turn N" afterwards. Out of combat it shows "Your warband now".
- *Lobby panel*: tribe chips + `LobbyList` with one expandable row.

Below: "This game's fights" (`RoundsTable`) and the session panel.

**Minions** — the whole tavern pool, grouped by tier 1–7, searchable by name or text,
filterable by tribe. "Only this lobby's tribes" is on by default and uses
`snapshot.tribes`; an explicit tribe filter overrides it.

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
opacity and scale sliders, and the `simIterations` slider.

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

`OddsBar` takes a `fightKey` so a mid-fight odds revision (a Duos teammate arriving)
renders a ▲/▼ delta chip, while a *new* fight resets instead of showing a bogus delta.

## Overlay windows

One bundle, two kinds, chosen once at module load from the query string:

```ts
const kind = new URLSearchParams(location.search).get('kind') === 'lobby' ? 'lobby' : 'odds'
```

**Odds overlay** — the current (or last) fight's `OddsBar` with the opponent's portrait
and result. Keyed by round, so each new fight replays the slide-in; the card persists
through the following shop phase until the next fight replaces it.

**Lobby overlay** — turn, session strip, tribe chips, and the `LobbyList`. The expanded
row defaults to the next opponent that has a known board, and follows the mouse on
hover.

### Locked vs unlocked

Driven entirely from `settings.overlay` by `updateOverlays()` in the main process:

```ts
const wanted = enabled && (kind === 'odds' ? showOdds : showLobby) && (inGame || !locked)
win.setIgnoreMouseEvents(locked, { forward: true })
win.setFocusable(!locked)
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

`styles.css`, ~1440 lines, one hand-written stylesheet imported by both entries. Dark
theme only; custom properties on `:root` (`--bg #0b0d12`, `--accent #f0b232`,
`--win #3ecf8e`, `--loss #f0605a`, `--radius 12px`, …). `--bg` matches the window
`backgroundColor` and the title bar overlay colour in main, so there's no flash on load.

Per-instance colours are passed inline as custom properties (`--tc` tribe, `--pc`
placement) rather than as classes. `-webkit-app-region` appears in exactly two places:
`.titlebar` and `.overlay.unlocked`. `.overlay-body { background: transparent }` is what
makes the transparent windows actually transparent.
