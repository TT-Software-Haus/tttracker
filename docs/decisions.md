# Decisions and findings

Why things are the way they are: the decisions that shaped a feature, and what real
games overturned. `PLAN.md` is a local working file (gitignored); anything in it worth
keeping moves here when its work is done. The how-it-works detail lives in the other
pages; this one is the reasoning behind it.

## Builds

- **A build** is a name, an optional tribe (none means "any lobby", for comps like
  Menagerie), stages of target minions each with a "by turn N", addons, and a free-text
  description. Builds share as short `HTB …` codes; descriptions are deliberately left
  out to keep codes around 90 characters.
- **The prompt comes after the hero is picked**, offers builds whose tribe is in the
  lobby, and can be dismissed ("Not this game"). Still open when combat starts counts
  as "Not this game". The choice is saved per game, so a tracker restart mid-game
  keeps it.
- **Overlays are clickable only while hovered.** A locked overlay stays click-through;
  the renderer reports when the pointer is over a button and main makes that window
  take clicks just then. This relies on forwarded mouse moves, which is the source of
  the mouse-hook constraint below.
- **"Owned" means board or hand.** A minion bought but not played counts. During
  combat the board as the fight began is used, since the fighting copy loses minions
  as they die. A golden from a triple is logged as a copy of one of the three; it's
  kept, because its originals are set aside, unlike the copies Hearthstone makes for
  a fight.

## The lobby's tribes come from the screen only

- The log has no tribe list. Pool minions give none before the hero is picked, some
  tribes only show in round 2, and a dual-tribe card (Demon/Naga) added Naga to a
  lobby, and a season, that had none. So the hero-select banner is the only source.
- The banner is text in Hearthstone's font, not icons (the icon strips on streams are
  HDT's overlay), so it's OCR (`tesseract.js`), not template matching.
- A fixed crop rect failed (the banner sat 640px from where centring predicts), so the
  plate is found by colour. Tesseract needs a tight crop: the gold emblems on the plate
  cost a tribe at 1080p until the crop was tightened onto text-coloured pixels. Neither
  segmentation mode is reliable alone, so both run and merge, and reads accumulate.
- Reading starts when heroes are offered, on the GameState stream: PowerTaskList logs
  the offered heroes as updates of known entities, so they never count as created
  there. `MULLIGAN_STATE=DONE` is when the screen closes, too late. A `Power.log` that
  appears while we watch is the session's first game, live, not history.
- Tribes are saved per game and with the match. A tracker started after hero select
  can't know them.
- Hearthstone Deck Tracker reads them from game memory (HearthMirror). That's exact but
  not reusable here: a closed binary, a memory-reading grey area, and per-patch upkeep.

## Shop and highlight boxes

- **The tavern is the dummy player's board**, read only during a shop phase: the same
  slot holds the opponent's warband in combat. Spells take tavern slots too.
- **Boxes come from the screen**, because the log says which slot a card is in, never
  where. Cards are found by their magenta tier shields, in the top half only (cards in
  hand carry shields too).
- **A box is drawn only when the screen's card count equals the log's**, spells
  included: a missed shield shifts every slot one over.
- **Reads continue all shop; boxes move only when two reads agree.** Stopping once
  settled left boxes behind when the tavern re-centred late (after buying a spell); a
  freeze makes the cards hop for a single read.
- **Mapping:** a window capture includes the title bar (DWM's extended frame bounds),
  boxes are drawn over the client area. Fullscreen on this machine is borderless:
  other windows draw over it and capture works. True exclusive fullscreen would hide
  the overlays as well, and isn't supported.
- **No boxes on your Duos teammate's board.** The log doesn't record switching views,
  so it's read off the screen: their view has a bright cyan swirl in both top corners
  (31-35% of pixels on a real frame), yours has dark curtains (0-0.2%).
- Known gap: when Hearthstone hides the tier shields (seen late in a game), no boxes.

## The build sidebar

- It only changes in the tavern. During combat it shows the tavern as you left it:
  live combat data moved it about (the fighting board loses minions, the shop empties,
  the round ticks over).

## Capture: three generations

1. `desktopCapturer.getSources()` renders a thumbnail of every open window to return
   one: ~1.3s and 57MB per call at 720p, 227MB at 2560x1440; memory sawtoothed to 1.1GB.
2. A hidden window streaming the game through `getDisplayMedia`: one frame per read, but
   each read copied a whole video frame off the GPU into a CPU canvas.
3. **Now:** a Rust module (`native/capture`, crates `napi` + `windows`) holding one
   Windows Graphics Capture session. Only the strip the detectors scan leaves the GPU,
   shrunk there with mipmaps first. ~2.5ms a read, ~0.25s to open.

Finding the game window uses `koffi` (user32/dwmapi in-process, about a microsecond);
the PowerShell lookup it replaced compiled C# on every call.

## Overlays follow the game window

- Positions are fractions of the free space inside the game's client area, so overlays
  stay inside it at any size; a drag is remembered the same way.
- Size scales with the window's height (1440 DIPs = 1.0, the fullscreen height of the
  monitor it was designed on), floored at 0.6 for readability, times the Size setting.
  CSS zoom doesn't adjust `vh`, hence the zoom-corrected `--vh`.
- They follow on a 50ms poll; 500ms visibly lagged a dragged window.
- Endless CSS animations were made static: they kept the GPU busy over the game.

## The main thread must stay free

Click-through with forwarded mouse moves installs a system-wide low-level mouse hook on
Electron's main thread, so any synchronous work there freezes the user's cursor. Found
by bisecting startup with the user watching the mouse; traces showed nothing, because
the cost is latency, not load. Offenders measured: the log replay on launch (~700ms),
combat sims (17–84ms each, up to a 400ms budget), card data load (~46ms). The user chose
to keep the hook and move or slice the work. See CLAUDE.md.

What it took, all found with `--profile` (see development.md):

- Sims run on a worker thread, spawned at launch (spawning it lazily blocked ~50ms).
- The launch replay is fed in 8ms slices, and Power.log is read 1MB at a time, with
  `lastGameOffset` searching backwards (a single game was 58MB of log).
- Anything unavoidably slow happens before the first window exists, when there's no
  hook yet: creating the capture's Direct3D device (~250ms, once per process, never
  released) and parsing the card data.
- Opening a capture session never waits for its first frame (that slept 300–400ms at
  every shop); callers retry.
- Overlay window settings are applied only when they change; re-applying them on every
  publish cost 5–75ms.
- What's left before the hook: creating the windows (~300ms), harmless to the cursor.
