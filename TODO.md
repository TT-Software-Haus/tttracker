# TODO — `feature/builds`

21 commits, none pushed. All six milestones in [`PLAN.md`](PLAN.md) are built;
five are verified against a real game, one isn't. 95 tests pass; `npm run
typecheck` is clean apart from one error that predates this branch (see below).

## Blocking

### 1. Verify M6 in a live game

The only part of the feature never seen working. Everything else was confirmed
in a real game; the highlight boxes were only confirmed against a *captured*
frame and a stubbed overlay.

To test: pick a build with minions you'll actually see (**Murlocs - Keyword**
has Kelp Keeper), wait for one to appear in the tavern, then check

- [ ] a gold box appears, and on the **right** card — not offset, not one slot over
- [ ] clicking through the box still buys the minion (the window is
      `setIgnoreMouseEvents(true)`, but that's untested over the live game)
- [ ] it tracks a shop reroll, and disappears in combat
- [ ] a tavern containing a **spell** doesn't shift the boxes — slots are matched
      on `ZONE_POSITION` for exactly this reason, and it's the case most likely
      to be wrong

If the boxes are offset, `findShopSlots` in `src/main/vision/shopSlots.ts` has
`CARD_WIDTH` and `CARD_ASPECT` constants, and the measured numbers from a real
2560x1440 frame are in its comment.

### 2. Update `docs/`

`CLAUDE.md` says the developer docs are the contract and to read them before
changing a subsystem. They currently describe the app as it was before this
branch and will mislead the next person:

- [ ] `docs/ui.md` — says "Five pages"; there are now six. No mention of the
      Builds page, the build sidebar overlay (`kind=build`), the highlight
      layer (`kind=slots`), the build prompt, or the "Going for" selector.
- [ ] `docs/ipc-and-data.md` — missing `builds:list/save/delete/select`,
      `comps:list`, `comps:addons`, `builds:export`, `builds:import`; the
      `Build`/`Comp` types; `BgSnapshot.shop`, `selectedBuild`, `buildPrompt`,
      `shopHighlights`; `OverlaySettings.showBuild`; and `builds.json` in the
      storage table.
- [ ] `docs/architecture.md` — no `src/main/vision/` (screen capture + OCR),
      no `comps.ts`, no `buildCode.ts`. `tesseract.js` is the project's first
      runtime dependency and the README/architecture still imply zero.
- [ ] `docs/api-reference.md` — `CardDb.shareList/shareIndexOf/shareCardAt`,
      `BgGame.shopMinions`, `Tracker.selectBuild`.

### 3. Decide how this lands

- [ ] Push `feature/builds` (nothing is on the remote yet)
- [ ] Merge to `develop`, or open a PR — not started, and not something to do
      without asking

## Housekeeping

- [ ] Delete the scratch harness when M6 is signed off: `tmp-live.cjs`,
      `tmp-live-full.png`, `tmp-live-crop.png`. Gitignored via `tmp-*`, so
      they're untracked, but they're the only way to re-run the live vision
      check — keep them until M6 closes.
- [ ] `PLAN.md` M6 still has no status block; close it out once verified.
- [ ] Your saved builds include an empty **"New build"** (Murlocs, 0 minions)
      from early testing. It shows up in the prompt looking broken. Your data,
      so left alone — delete it from the Builds page.

## Known, deliberate, revisit only if they bite

Judgement calls made along the way. None are bugs; all are written down so the
reasoning isn't lost.

- **The selected build is in memory only.** Restarting the tracker mid-game
  loses it. Persisting it properly means keying it to the game so the next one
  doesn't inherit it — machinery for a problem that only shows up during
  development. The Live-page selector covers recovery.
- **Build codes address cards by list position**, so they'd break if the
  Battlegrounds minion list ever stopped growing only at the end. A checksum
  catches it and refuses the import rather than producing a plausible wrong
  build. Headroom is 2,836 more cards before the 2-character index overflows.
- **HSReplay scraping will break** when they restructure the page. It fails
  with a readable message and offers the link instead. Covered by tests that
  assert it throws rather than silently importing nothing.
- **The tribe OCR runs two segmentation passes and merges them**, because
  neither mode is reliable alone — verified at 4K and 1080p. If a future
  Hearthstone restyle breaks it, an empty read falls back to the log's own
  tribe list, so tracking degrades rather than lying.
- **`src/main/bg/sim/effects.ts:455` — unused `perCombatLimit`.** Pre-existing
  on `develop`, confirmed by stashing. Not this branch's to fix, but it's the
  one thing standing between you and a clean `npm run typecheck`.
