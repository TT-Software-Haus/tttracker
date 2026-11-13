# Battlegrounds state and orchestration

`src/main/bg/bgGame.ts`, `src/main/tracker.ts`.

## What `BgGame` assumes about the log

- You are one player entity; the other is a **dummy player** that hosts whichever
  opponent you're fighting this round.
- **Odd `TURN` = shop, even `TURN` = combat.** So `round = ceil(turn / 2)` and
  `inCombat = turn > 0 && turn % 2 === 0`.
- At the start of each combat the client creates copies of both warbands in play.
  Each copied hero carries the `PLAYER_ID` of its lobby player — that's how an
  anonymous board is attributed to a player.
- A combat ends with the winner's hero attacking the loser's hero.
- In Duos, when a warband dies its teammate's warband enters mid-combat.

Mode detection: `isBattlegrounds` from `GameType` containing `BATTLEGROUNDS`, falling
back to "some player entity has `BACON_DUMMY_PLAYER`". `mode` is `'duos'` if the game
type contains `DUO`.

Not modelled anywhere: **buddies and anomalies**. Triples are only surfaced as the
per-player `PLAYER_TRIPLES` counter, not detected or predicted.

## Combat lifecycle

```
TURN flips even  ─▶ snapshot warbandIds, clear per-combat caches
first ATTACK     ─▶ startCombat(first) → capture both boards → runSim() → onChange
hero ATTACK      ─▶ result = WON/LOST, snapshot every hero's health
   blockEnd      ─▶ damage = largest health drop
TURN flips odd   ─▶ finishCombat(): default TIED, record lastResults, clear current
```

The capture point is deliberate: **the first attack is after Start of Combat has
already resolved**, so the simulator starts from the real position with
`skipStartOfCombat: true` instead of trying to predict Start of Combat itself.

In Duos, a hero entering `ZONE=PLAY` mid-combat means a teammate's warband arrived;
that sets `resimPending`, and the next attack re-captures the boards and re-runs the
odds from the new position.

`effectiveHealth(hero) = HEALTH + ARMOR - DAMAGE` is used for lobby health, lethal
odds and the `dead` flag.

## Reading boards

`minionEntities(controller)` = entities with `CARDTYPE=MINION`, `ZONE=PLAY`, matching
`CONTROLLER`, sorted by `ZONE_POSITION`.

Two mappers over those entities:

- `toBoardMinion(e): BoardMinion` — for display. `health = HEALTH - DAMAGE`,
  `tier = TECH_LEVEL ?? card.techLevel ?? 1`, `golden = PREMIUM || !!card.normalId`,
  keyword booleans from tags.
- `toInput(e): MinionInput` — for the simulator. Keeps `venomous` and `poisonous`
  separate, and distinguishes `megaWindfury`.

Both read **current in-game stats**, which is why the simulator can treat shop auras
and Blood Gem upgrades as already baked in.

## The lobby

`lobbyHeroes()` picks HERO entities that have **both** `PLAYER_LEADERBOARD_PLACE` and
`PLAYER_ID`, excluding the `TB_BaconShop_HERO_PH` placeholder. The leaderboard place is
the discriminator: opponents' lobby heroes are themselves copies, and the *combat*
copies don't have one. On collisions the highest entity id wins.

`lobby(): LobbyPlayer[]` emits health, armor, tavern tier (`PLAYER_TECH_LEVEL`),
triples, place, Duos team id, `isMe` / `isTeammate` / `isNextOpponent`
(`NEXT_OPPONENT_PLAYER_ID` or `NEXT_OPPONENT_TEAMMATE_PLAYER_ID`), `dead`, plus:

- **`lastBoard`** — `lastBoards: Map<playerId, { round, minions }>`, written whenever
  you actually fight that player. There is no scouting; a player's board only updates
  when you're matched against them (or when their Duos reserve is revealed).
- **`lastResult`** — written in `finishCombat`.

Sorted by place, then team, then player id. Your own hero has no team id in the log, so
it's copied from your teammate's row.

`tribes` comes from `noteTribes()`, which counts only entities tagged
`IS_BACON_POOL_MINION=1` and collects every `race !== 'ALL'` seen — that's the lobby's
active tribe set, used to filter the Minions browser.

## Duos

The hard part is `groupDuoBoards()`. Before each fight Hearthstone creates hidden
copies of all four warbands: each opponent/teammate hero copy (carrying its
`PLAYER_ID`) followed by its minions, plus copies of your own minions with no hero.

- Source entities come from the **GameState lookahead** (`lookCreated`) when available,
  because by the time the fight animates in PowerTaskList those copies are gone. The
  lookahead freezes a deep-ish copy of the pending entities on the first `ATTACK`
  block of each even turn.
- A `CARDTYPE=HERO` with a `PLAYER_ID` in `ZONE=SETASIDE` opens a new group.
- A minion is *yours* if it's in SETASIDE and its `COPIED_FROM_ENTITY_ID` is in
  `warbandIds` (snapshotted at the shop→combat flip).
- Hand vs board split: `ZONE=HAND`, or tag `3085` differing from `HEALTH` — a waiting
  teammate's cards have that mismatch. **Tag 3085 is not in any public GameTag enum**
  (see [api-reference.md](api-reference.md#tag-3085)); it was derived empirically and is
  the most fragile line in the file. Backstop: a board can't exceed 7, so any excess is
  moved to the front of the hand.

`reservePid(side)` picks the first team member that hasn't fought yet and has grouped
copies; `reserveInput(side)` feeds it to the simulator as `BoardInput.reserve`.
`reserveUnknown(side)` is true when a teammate warband hasn't fought and no copies were
found — that sets `SimOdds.partial`, which the UI shows as "only the current boards
were simulated".

`handFor(pid)` supplies the hand to the simulator (needed for cards like Diremuck
Forager and Choral Mrrrglr). For other players it's the Duos hand copies minus anything
already summoned; for you it's real `ZONE=HAND` minions you control.

## Running the sim

```ts
simulateMany(cards, a, b, {
  iterations: simIterations,   // from settings, default 5000
  timeBudgetMs: 400,
  firstAttacker, skipStartOfCombat,
  myHealth, oppHealth,         // effectiveHealth of the lobby heroes → lethal odds
})
```

Exceptions are caught and logged; the round simply gets no `odds`.

## Output

`snapshot()` returns everything but `status`: `mode`, `round`, `phase`
(`none`/`shop`/`combat`/`over`), `me`, `lobby`, `tribes`, `board`, `combat`, `rounds`,
`placement`.

`emitMatch()` builds a `BgMatch` (uuid, timestamps, hero, placement, rounds, tribes,
final board, teammate hero, every combat) and hands it to `onMatchEnd`.

## `Tracker`

```ts
this.game      = new Game('PowerTaskList')   // what you see
this.lookahead = new Game('GameState')       // runs ahead
this.bg        = new BgGame(this.game, this.cards, this.lookahead)
```

`start()`: resolve the install path (persisting it), `cards.init()`, `checkLogConfig()`
— and if it fails *but a `log.config` already exists*, silently repair it, since the
user already opted in and an older build wrote the size limit to the wrong place. Then
`attachToLogs()` on a 5 s interval.

`attachToLogs()` each tick:

- Log directory changed → stop the tail, `freshModel()`, publish. (New Hearthstone
  session; the old state is stale.)
- `game.inGame` but `tasklist` says Hearthstone isn't running → flush the pending
  match, `freshModel()`, publish. Don't leave the overlay stuck on a dead game.
- No tail yet and `Power.log` exists → seed `lastLineAt` from the file's **mtime**
  (replayed history is old, so staleness must be judged by the file's write time),
  then tail from `lastGameOffset()`.

The first batch of lines is flagged `catchingUp`, which is how `endedDuringReplay` is
decided — a game that finished before we attached must not be written to history twice.

**Stall detection**: mid-game Hearthstone writes constantly, so
`inGame && now - lastLineAt > 3 min` means it stopped logging (almost always the log
size limit). Surfaces as `waiting-for-logs` with a "restart Hearthstone" message.

**Publishing**: `schedulePublish()` coalesces to one `publish()` per 60 ms. `publish()`
takes `bg.snapshot()` and decides `status` in this order:

1. `!logConfigOk` → `setup-needed`
2. no tail → `waiting-for-logs`
3. stalled → `waiting-for-logs`
4. `phase === 'none'` → `idle`
5. not Battlegrounds → `not-battlegrounds`
6. `phase === 'over'` → `game-over` for 30 s (`GAME_OVER_LINGER_MS`), then `idle`
7. otherwise → `in-game`

Then `emit('snapshot', snap)`. The only other event is `emit('data')` when match
history changes.
