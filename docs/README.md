# Hearth Tracker — developer docs

A Hearthstone **Battlegrounds** tracker: Electron + React + TypeScript, with its own
combat simulator. It reads Hearthstone's `Power.log`, plus the game window's pixels for
what the log can't say (the lobby's tribes, where tavern cards sit) — no memory
reading, no injection.

Windows only. The install discovery, config paths and process checks all use
`reg.exe`, `tasklist`, `%LOCALAPPDATA%` and backslash paths; there is no macOS branch.

## Contents

| Doc | What's in it |
| --- | --- |
| [architecture.md](architecture.md) | Process model, module map, end-to-end data flow |
| [log-pipeline.md](log-pipeline.md) | Finding the logs, enabling logging, tailing, the entity/tag model, card data |
| [battlegrounds.md](battlegrounds.md) | `BgGame` — lobby, combats, boards, Duos; `Tracker` orchestration and status |
| [simulator.md](simulator.md) | Combat engine, card-text effect compiler, odds |
| [ipc-and-data.md](ipc-and-data.md) | Every IPC channel, the shared type contract, settings and on-disk storage |
| [ui.md](ui.md) | Renderer pages, shared components, the two overlay windows, styling |
| [development.md](development.md) | Scripts, build config, tests, fixtures, coverage tooling, known rough edges |
| [api-reference.md](api-reference.md) | Every exported symbol, by module, plus the game-tag reference |
| [decisions.md](decisions.md) | Why things are the way they are: decisions and what real games overturned |
| [diagrams.md](diagrams.md) | Ten Mermaid diagrams: modules, line-to-UI flow, round lifecycle, combat loop, IPC map, Duos grouping |

## One-paragraph version

`Tracker` tails `Power.log` and feeds every line to two `Game` parsers — one for the
`PowerTaskList` stream (in sync with what the player sees) and one for `GameState`
(which runs ahead, because the server logs a whole combat before it animates).
`BgGame` watches those entity/tag events and reconstructs the Battlegrounds lobby,
your warband and each combat. At the first attack of a fight — after Start of Combat
has already resolved — it snapshots both boards and runs them through the simulator
5000 times to get win/tie/loss odds. `Tracker` coalesces all of that into a
`BgSnapshot` every 60 ms and pushes it over IPC to the main window and the two
overlay windows. Finished games are appended to `bg-matches.json` for history and
stats.

```
Power.log ──LogTail──▶ Game('PowerTaskList') ─┐
                   └─▶ Game('GameState')  ────┼─▶ BgGame ──▶ simulateMany()
                                               │      │
                                               │      ├─▶ BgSnapshot ─IPC─▶ main window
                                               │      │                 └─▶ overlays
                                               │      └─▶ BgMatch ──▶ Store (bg-matches.json)
                                          CardDb (HearthstoneJSON)
```
