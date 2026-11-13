# Log pipeline

`src/main/logs/`, `src/main/game/game.ts`, `src/main/cards/cardDb.ts`.

## Finding Hearthstone — `hsPaths.ts`

`findInstallPath()`:

1. `C:\Program Files (x86)\Hearthstone\Hearthstone.exe` if it exists.
2. Otherwise `reg query` on, in order,
   `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Hearthstone`
   then the non-WOW6432Node key, parsing `InstallLocation`. Accepted only if
   `Hearthstone.exe` exists underneath.
3. Fall back to the default path anyway.

`findActiveLogDir(installPath)` lists `<install>/Logs`, keeps entries matching
`/^Hearthstone_\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/`, and takes the lexicographically
last one (the names are zero-padded, so that's the newest). Old clients that write
straight to `Logs/Power.log` are handled by a fallback.

Only **one file is ever read: `<activeLogDir>/Power.log`.**

## Enabling logging

Two files are written, both by `ensureLogConfig(installPath)` (the `setup:fixLogConfig`
IPC path, i.e. the **Enable logging** button in Setup):

**`%LOCALAPPDATA%\Blizzard\Hearthstone\log.config`** — backed up to `log.config.bak`
first if non-empty, existing sections preserved, then:

```ini
[Power]
LogLevel=1
FilePrinting=true
ConsolePrinting=false
ScreenPrinting=false
Verbose=true
```

`[Zone]` is actively deleted if present — Zone.log is enormous and pushes the client
over its log size limit. A stray `[Log]` section is also deleted (an earlier version
of this app wrote the size limit into the wrong file).

**`client.config`** — the size limit itself:

```ini
[Log]
FileSizeLimit.Int=-1
```

By default Hearthstone stops writing *all* logs once the file hits ~10 MB, which a
long Battlegrounds game can reach mid-match. Which folder the client reads
`client.config` from isn't documented, so `clientConfigPaths()` returns both
candidates (`%LOCALAPPDATA%\Blizzard\Hearthstone\` and the install folder) and the app
writes both. Failures here warn rather than throw.

`checkLogConfig()` passes only if `[Power]` has `FilePrinting=true` *and*
`Verbose=true`, *and* every client.config path has `FileSizeLimit.Int=-1`.

Changes need a Hearthstone restart to take effect.

## Tailing — `logTail.ts`

`new LogTail(path, onLines, intervalMs = 150)`.

Polling, not `fs.watch`: Hearthstone keeps the handle open and Windows change
notifications are unreliable for it. Each poll stats the file, reads exactly
`size - offset` bytes at an explicit offset, closes the handle, splits on `/\r?\n/`
and keeps the trailing fragment in `partial` so only complete lines are delivered.
Re-entrancy is guarded by a `busy` flag; all errors are warned and swallowed.

Truncation is detected by `size < offset` (reset to 0). Note: a *rotated* file that is
already larger than the old offset is not detected — file identity isn't checked. In
practice a new game session means a new folder, which `Tracker.attachToLogs` catches.

`lastGameOffset(path)` finds the last
`GameState.DebugPrintPower() - CREATE_GAME` in the file and returns the byte after the
preceding newline, so attaching mid-session replays the current game and nothing else.
No match → end of file (start live). Read failure → 0.

## The entity/tag model — `game/game.ts`

`Game` is **mode-agnostic** — there is no deck, hand, mulligan or constructed tracking
anywhere in this codebase. It turns Power.log into entities, tags and events; all
Battlegrounds knowledge lives in `bgGame.ts`.

Only lines matching this survive:

```ts
/^[DIWE] [\d:.]+ (GameState|PowerTaskList)\.(DebugPrintPower|DebugPrintGame)\(\) - (.*)$/
```

A `Game` is constructed with its stream (`new Game('PowerTaskList')`) and ignores
`DebugPrintPower` lines from the other one. Everything before the first `CREATE_GAME`
is dropped.

### Line forms handled

| Line | Effect |
| --- | --- |
| `CREATE_GAME` | `reset()`, `phase = 'running'`, emit `gameStart` |
| `GameEntity EntityID=n` | records the game entity, opens a pending tag block |
| `Player EntityID=… PlayerID=… GameAccountId=[hi=…` | player entity, account hi, name back-fill |
| `FULL_ENTITY - Creating ID=n CardID=x` | new entity, opens a pending tag block |
| `SHOW_ENTITY` / `CHANGE_ENTITY - Updating Entity=…` | reopens an existing entity |
| `HIDE_ENTITY`, `TAG_CHANGE` | single tag write |
| `BLOCK_START BlockType=… Entity=…` / `BLOCK_END` | block stack + events |
| indented `tag=K value=V` | attached to the currently pending entity |

`created` is emitted from `finishPending()` — after the whole tag block is attached —
so listeners always see a complete entity, never a half-built one.

`resolveEntity(ref)` handles all four reference shapes: `[entityName=… id=42 …]`, a
bare number, the literal `GameEntity`, and a player name. Name resolution has a
Battlegrounds-specific rule: the dummy player's name changes every combat (it adopts
the current opponent's name), so **an unrecognised name is the dummy player**.

### Who is "me"

`detectFriendly()` finds the player entity with `BACON_DUMMY_PLAYER=1`; the *other*
player id is you. Fallback: with two players and exactly one having
`accountHi !== '0'`, that one is you. Set once per game.

### End of game

`phase = 'over'` and `gameEnd` fire on either GameEntity `STATE=COMPLETE`, or
`PLAYSTATE ∈ {WON, LOST, TIED, CONCEDED}` on *your own* player entity. The second case
matters in Battlegrounds: you're knocked out while the lobby plays on, so your own
PLAYSTATE is the end of *your* game.

### Events

```ts
type GameEvent =
  | { type: 'gameStart' } | { type: 'gameEnd' }
  | { type: 'created'; entity }
  | { type: 'tag'; entity; tag; value; prev }
  | { type: 'blockStart' | 'blockEnd'; blockType; entity? }
```

Subscribe with `game.on(fn)`. There is no unsubscribe — models are thrown away
wholesale instead.

## Card data — `cardDb.ts`

Source: `https://api.hearthstonejson.com/v1/latest/enUS/cards.json`. One `fetch`, enUS
only, no locale support.

`init(cacheDir)` caches to `<userData>/carddata/cards-v2.json` with a 24 h max age
measured on `mtime`. The flow is cache-first: parse and `load()` the cached file
immediately so startup isn't blocked, then refresh if stale. A failed refresh warns and
keeps the cache; a failure with no cache rethrows.

`slim(raw)` keeps `id`, `dbfId`, `name`, `cost` (plus rarity/class/type/set) for every
card, and the heavy Battlegrounds fields — `text`, `attack`, `health`, `techLevel`,
`races`, `mechanics`, `pool`, `bgHero`, `duosOnly`, `goldenId`, `normalId` — only for
BG-relevant cards. `normalId` is derived by reversing `battlegroundsPremiumDbfId`,
which is how golden cards are linked back to their normal version.

Indexes built by `load()`: `byId`, `byDbf`, `bgByName` (lowercased, BG minions only),
`bgSpells`. Accessors `get`, `byDbfId`, `bgMinionsNamed`, `bgSpellNamed`, `bgMinions`,
`pool()` (the current tavern pool, also exposed to the renderer over `cards:pool`).

`slim()` is exported and reused by `scripts/make-card-fixture.ts`, so tests run against
exactly the production shape with no network.
