# Hearth Tracker: Battlegrounds

A Battlegrounds tracker written in TypeScript (Electron + React), with its own combat simulator. It only reads Hearthstone's log files, with no memory reading or injection.

## Features

- **Combat odds.** Win, tie and loss chances for every fight, plus expected damage and the chance a fight is lethal for you or the opponent. Shown in an overlay at the top of the screen. In Duos the odds are re-run when the second warband joins.
- **Lobby overlay.** All heroes with health and armor, tavern tier, triples, teams, and your next opponent highlighted. Hover any hero to see the last board you saw them play. Locked overlays let clicks pass through to the game.
- **Minion browser.** Every minion in the tavern pool by tier, filtered to the tribes seen in your lobby.
- **History and stats.** Placement, hero, final board and every fight (odds vs. actual result) for each game. Stats show average placement, top-half rate, placement distribution, per-hero and per-tribe results, and how accurate the simulator has been.

## The simulator (`src/main/bg/sim`)

- `engine.ts` handles the combat rules:
  - Who attacks first, attack order, and Taunt / Stealth targeting.
  - Divine Shield, Venomous and Poisonous, Windfury and Mega-Windfury, Cleave, Reborn.
  - Death batches with Avenge, Deathrattles (including Titus's extra triggers) and summon positions.
  - Damage: hero tier + surviving minions' tiers.
- `effects.ts` turns card text into effects. It parses common templates such as "Deathrattle: Summon two 1/1 Skeletons", "Rally: Give your other minions +4/+1" and "Whenever another friendly Dragon attacks, give it +3/+1". Golden cards have their own text, so they work automatically. Odd cards get hand-written handlers in `MANUAL`.
- Effects it can't model are listed under the odds ("Not modelled: …"). These are hand-dependent minions, mid-combat spell casts, and a few others.
- To check coverage after a patch, download HearthstoneJSON's `cards.json` and run `npx tsx scripts/sim-coverage.ts cards.json`. It lists every pool minion whose text isn't understood.

The boards are captured at the first attack of each combat, after Start of Combat effects have resolved. So the odds are calculated from the actual position, not a guess at the Start of Combat outcome.

## Running

```sh
npm install
npm run dev      # hot-reloading dev mode
npm test         # simulator + real-log replay tests
npm run dist     # Windows installer into dist/
```

First run: open **Setup**, click **Enable logging**, then restart Hearthstone.

## Layout

| Piece | File |
| --- | --- |
| Power.log → entities/tags + events | `src/main/game/game.ts` |
| Battlegrounds state: lobby, combats, results | `src/main/bg/bgGame.ts` |
| Combat simulator | `src/main/bg/sim/` |
| Log discovery, `log.config`, tailing | `src/main/logs/` |
| Card data (HearthstoneJSON) | `src/main/cards/cardDb.ts` |
| Orchestration, windows, IPC | `src/main/tracker.ts`, `src/main/index.ts` |
| UI | `src/renderer/src/` |
| Test fixtures (anonymised real log) | `tests/fixtures/`, built with `scripts/make-fixture.ts` |

Data is stored as JSON in `%APPDATA%\hearth-tracker\`.

Developer docs: [`docs/`](docs/README.md).

Card data and art come from [HearthstoneJSON](https://hearthstonejson.com). Not affiliated with Blizzard Entertainment.
