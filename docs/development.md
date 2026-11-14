# Development

## Commands

```sh
npm install
npm run native     # cargo build of native/capture → native/capture.node
npm run dev        # native, then electron-vite dev, hot reloading
npm test           # vitest: simulator + real-log replay
npm run typecheck  # tsc --noEmit
npm run build      # native, then all three targets into out/
npm run dist       # + electron-builder --win → NSIS installer in dist/
```

**Rust is needed to build** (stable, MSVC toolchain): the screen capture is a Rust
module, `native/capture` (crates `napi` and `windows`). It's built with plain cargo into
`native/capture.node`, which is gitignored and shipped unpacked from the asar. Node-API is
ABI-stable, so it needs no rebuild when Electron updates. Windows locks a loaded DLL, so
**close the app before rebuilding it**: `npm run native` fails to copy (EBUSY) while the
app is running, and `--watch` doesn't rebuild Rust.

First run: open **Setup**, click **Enable logging**, restart Hearthstone.

There is no lint script and no ESLint/Prettier config.

## Build config

`electron.vite.config.ts`:

- **main** and **preload** use electron-vite's conventional entries
  (`src/main/index.ts`, `src/preload/index.ts`) — neither is spelled out.
- The preload is forced to **CJS with a `.cjs` extension**, matching
  `join(__dirname, '../preload/index.cjs')` in `src/main/index.ts`. These two must stay
  in sync.
- The renderer is a two-entry build: `index.html` (main window) and `overlay.html`
  (all four overlay kinds).
- **No path aliases.** All cross-layer imports are relative (`../../shared/types`).

`tsconfig.json` is one config for all three layers: `strict`, `noUnusedLocals`,
`moduleResolution: Bundler`, `jsx: react-jsx`, and both `DOM` and `node` types. Nothing
structurally stops a main-process file importing DOM APIs — the layering is by
convention.

`electron-builder` config is inline in `package.json`: Windows NSIS only, no icon, no
code signing, no publish or auto-update.

**Two runtime dependencies**: `tesseract.js` (OCR for the hero-select tribe banner — see
[architecture.md](architecture.md#screen-reading--srcmainvision)) and `koffi` (in-process
user32 calls for the game window's position, about a microsecond each; the PowerShell
lookup it replaced compiled C# on every call). electron-vite externalizes everything in
`dependencies`, so both are `require`d from `node_modules` at runtime rather than bundled:
tesseract.js runs a worker thread and loads WASM from its own package, and koffi loads its
prebuilt native binary from `@koromix/koffi-<platform>`. The dev server reads the dependency
list once at startup, so restart `npm run dev` after adding one. React, Electron and
everything else are devDependencies bundled at build time.

## Tests

`tests/`, run with vitest. Nothing touches the network, the filesystem watcher or
Electron.

**`sim.test.ts`** — the simulator, against ~18 hand-written `CardInfo` records.
Two suites: combat rules (bigger minion wins and deals `heroTier + survivor tiers`,
taunt targeting over 30 seeds, divine shield, venomous, windfury, reborn, 0-attack
stalemate) and card effects from text (deathrattle tokens including the golden text,
`extraDeathrattles`, rally, cleave, start of combat, tavern spells cast mid-combat,
hand-based start of combat, the Duos reserve swap, Diremuck Forager on a full board,
and that unparseable text is reported in `unsupported`).

**`bg-replay.test.ts`, `bg-live-streams.test.ts`, `bg-duos-reserves.test.ts`** — replay
anonymised real logs line-by-line straight into `Game.handleLine` and assert on the
resulting `BgGame` state. `bg-duos-reserves` is a regression case: simulating only the
first pair of boards in a Duos fight predicted a win. `bg-live-streams` contains *both*
log streams, so it exercises the dual-model live path rather than GameState alone.

Not covered: lethal odds, `timeBudgetMs`, stealth, poisonous, mega-windfury, avenge,
most of the `MANUAL` card handlers, `LogTail`, and anything in the Electron shell.

## Fixtures

| File | Used by |
| --- | --- |
| `bg-duos-partial.log.gz` | `bg-replay.test.ts` — GameState-only Duos log, 3 combats, knocked out 3rd |
| `bg-duos-reserves.log.gz` | `bg-duos-reserves.test.ts` |
| `bg-duos-both-streams.log.gz` | `bg-live-streams.test.ts` |
| `cards-*.json` | the slimmed `CardInfo[]` each log needs |

Regenerate from a real log:

```sh
npx tsx scripts/make-fixture.ts "<...>/Power.log" tests/fixtures/my-case.log.gz
npx tsx scripts/make-card-fixture.ts cards.json tests/fixtures/my-case.log.gz tests/fixtures/cards-my-case.json
```

`make-fixture.ts` keeps only the lines the tracker reads, then anonymises: player names
become `Player1`, `Player2`, … (replaced longest-name-first so prefixes aren't partially
substituted), and `GameAccountId` is normalised to `hi=0 lo=0` for AI/dummy players and
`hi=1 lo=1` for everyone else — which is exactly the distinction `detectFriendly()`
relies on. Output is gzipped.

`make-card-fixture.ts` runs the production `slim()` over a HearthstoneJSON dump and
keeps a card if its id appears in the log, its `normalId` appears (so golden versions
survive), or it's a tier-1 non-pool BG minion (the tokens the simulator can summon).

## Simulator coverage after a patch

```sh
npx tsx scripts/sim-coverage.ts cards.json [--all]
```

See [simulator.md](simulator.md#checking-coverage-after-a-patch).

## Rough edges

Known, found while writing these docs. None are currently breaking anything.

- **Tag `3085`** in `BgGame.groupDuoBoards()` is a bare numeric tag that appears in
  neither of HearthSim's published GameTag enums, and Hearthstone-Deck-Tracker has no
  equivalent Duos-reserve code to compare against. The Duos hand/board split depends on
  it (with a ≤7-minion backstop). First thing to check if Duos reserves break after a
  patch — see [api-reference.md](api-reference.md#tag-3085) for how to re-derive it.
- **`LogTail` rotation** only detects shrink, not replace-with-larger; file identity
  isn't checked. `partial` is buffered as a string, so a multi-byte character split
  across a poll boundary could mangle.
- **`before-quit` doesn't await `flushAll()`** (`void store?.flushAll()`), so a pending
  debounced write can be lost on quit.
- **`setWindowOpenHandler`** forwards any URL to `shell.openExternal` without the
  `^https://` check that the `app:openExternal` handler applies.
- **`settings:update`** only forwards `simIterations` when truthy (`if (patch.…)`), so a
  `0` would be stored but not applied. Harmless with the current slider.
- **Stats page simulator-accuracy buckets** use all matches, ignoring the page's mode and
  range filters, unlike every other panel there.
- **No single-instance lock** — two copies would both tail the logs and both write
  `bg-matches.json`.
- **Saved window bounds aren't clamped to the current displays**, so a window saved on a
  monitor that's since been removed restores off-screen.
- **`Tracker.stop()`** clears the directory timer and the tail but leaves `emitTimer`
  and `lingerTimer` pending.
- **`renderUrl` in `lib.ts` is unused.**
- **`make-fixture.ts`'s header comment is stale** — it says "keeps only GameState lines"
  but the regex keeps both streams (which `bg-duos-both-streams` depends on).
- **`bg-matches.json` is never pruned** and has no schema version.
