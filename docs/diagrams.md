# Diagrams

Mermaid; GitHub renders these inline.

## 1. Modules and processes

```mermaid
flowchart LR
  subgraph HS["Hearthstone (external)"]
    POWER[("Power.log")]
    CFG[["log.config<br/>client.config"]]
  end

  subgraph MAIN["Main process"]
    direction TB
    HSP["logs/hsPaths.ts<br/>install + config"]
    TAIL["logs/logTail.ts<br/>150ms poll"]
    GPT["game/game.ts<br/>Game('PowerTaskList')"]
    GGS["game/game.ts<br/>Game('GameState')<br/>lookahead"]
    BG["bg/bgGame.ts<br/>BgGame"]
    SIM["bg/sim/<br/>engine + effects"]
    TRK["tracker.ts<br/>Tracker"]
    STORE["store.ts<br/>Store"]
    IDX["index.ts<br/>windows + IPC"]
    CDB["cards/cardDb.ts<br/>CardDb"]
  end

  subgraph REN["Renderer"]
    MW["main window<br/>index.html"]
    OV1["odds overlay<br/>overlay.html?kind=odds"]
    OV2["lobby overlay<br/>overlay.html?kind=lobby"]
  end

  HJ[("api.hearthstonejson.com")]

  HSP -. writes .-> CFG
  POWER --> TAIL --> GGS
  TAIL --> GPT
  GPT --> BG
  GGS -. "frozen copies<br/>(duos only)" .-> BG
  BG --> SIM
  CDB --> BG
  CDB --> SIM
  HJ --> CDB
  HSP --> TRK
  TRK --> BG
  BG -- BgMatch --> STORE
  TRK -- BgSnapshot --> IDX
  STORE --> IDX
  IDX -- "contextBridge<br/>window.api" --> MW
  IDX --> OV1
  IDX --> OV2
```

## 2. One log line, end to end

```mermaid
sequenceDiagram
  autonumber
  participant HS as Hearthstone
  participant T as LogTail
  participant GS as Game(GameState)
  participant PT as Game(PowerTaskList)
  participant BG as BgGame
  participant S as simulateMany
  participant TR as Tracker
  participant UI as Windows

  HS->>T: appends to Power.log
  Note over T: poll every 150 ms,<br/>read size-offset bytes,<br/>keep partial line
  T->>GS: handleLine(line)
  T->>PT: handleLine(line)
  Note over GS: runs ahead — the whole<br/>combat is already logged
  PT-->>BG: blockStart ATTACK
  BG->>GS: read frozen warband copies (duos)
  BG->>BG: captureBoards()
  BG->>S: simulateMany(a, b, skipStartOfCombat)
  S-->>BG: SimOdds
  BG-->>TR: onChange()
  TR->>TR: schedulePublish() — coalesce 60 ms
  TR->>UI: broadcast('tracker:snapshot', BgSnapshot)
```

## 3. Battlegrounds round lifecycle

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Shop: CREATE_GAME

  Shop --> CombatPending: TURN flips even
  note right of CombatPending
    snapshot warbandIds
    clear duoBoards / enteredPids
  end note

  CombatPending --> Fighting: first ATTACK block
  note right of Fighting
    startCombat(firstAttacker)
    groupDuoBoards()
    captureBoards(initial)
    runSim(skipStartOfCombat)
  end note

  Fighting --> Fighting: teammate warband enters<br/>(resimPending → re-capture + re-sim)
  Fighting --> Decided: hero attacks hero<br/>result = WON / LOST
  Decided --> Decided: blockEnd → damage = max health drop
  Decided --> Shop: TURN flips odd<br/>finishCombat()
  Fighting --> Shop: TURN flips odd<br/>(default TIED)

  Shop --> Over: STATE=COMPLETE or<br/>your PLAYSTATE set
  Decided --> Over
  Over --> [*]: emitMatch() after 4 s<br/>(placement arrives late)
```

## 4. Simulator — one iteration

```mermaid
flowchart TD
  A["simulate()"] --> B["taunt-while-shielded pre-pass"]
  B --> C{"firstAttacker given?"}
  C -- no --> D["more minions wins<br/>tie → coin flip"]
  C -- yes --> E
  D --> E{"skipStartOfCombat?"}
  E -- no --> F["Start of Combat:<br/>hand fx → board fx L→R<br/>→ resolveDeaths<br/>→ attackImmediately"]
  E -- yes --> G
  F --> G["loop, max 300 steps"]
  G --> H{"a side empty?"}
  H -- "yes, has reserve" --> I["bringInReserves()<br/>re-pick first attacker"]
  I --> G
  H -- "yes, no reserve" --> Z
  H -- no --> J["nextAttacker: skip dead<br/>and atk <= 0"]
  J --> K{"found?"}
  K -- no --> Z
  K -- yes --> L["attackWith: repeat<br/>windfury times (1/2/4)"]
  L --> M["singleAttack"]
  M --> N["alternate side"]
  N --> G
  Z["outcome()<br/>heroTier + Σ survivor tiers"]
```

## 5. One attack, in order

```mermaid
flowchart TD
  A["clear attacker stealth"] --> B["Rally effects"]
  B --> C["friendly-attack triggers"]
  C --> D{"anyone died?"}
  D -- yes --> X["resolveDeaths, return"]
  D -- no --> E["hit list = target<br/>+ neighbours if Cleave"]
  E --> F["fire 'attacked' on defender<br/>(BEFORE damage)"]
  F --> G{"anyone died?"}
  G -- yes --> X
  G -- no --> H["snapshot atk and retaliation<br/>— both read before any damage"]
  H --> I["damage each hit"]
  I --> J{"immuneWhileAttacking?"}
  J -- no --> K["retaliation damage to attacker"]
  J -- yes --> L
  K --> L["'kill' triggers"]
  L --> M["overkill splash to a random<br/>adjacent enemy"]
  M --> N["afterAttack"]
  N --> O["resolveDeaths"]
```

### `damage()`

```mermaid
flowchart TD
  A["damage(target, n, source)"] --> B{"n <= 0 or target dead?"}
  B -- yes --> Z["return 0"]
  B -- no --> C{"divineShield?"}
  C -- yes --> D["pop shield<br/>onShieldLost<br/>return 0"]
  C -- no --> E["hp -= n"]
  E --> F{"source venomous/poisonous<br/>AND target survived?"}
  F -- yes --> G["destroyed = true<br/>venomous consumed"]
  F -- no --> H
  G --> H["record killedBy (first killer wins)"]
  H --> I["onFriendlyDamage on the source's side"]
  I --> J["target onDamaged + 'damaged' triggers"]
```

Note the shield absorbs poison too, because it returns before the poison check.

### `resolveDeaths()` — batch order

```mermaid
flowchart LR
  A["collect all dead<br/>(active side first)"] --> B["remove from both boards<br/>adjust nextAttacker"]
  B --> C["per corpse, in order:"]
  C --> D["'dies' triggers"]
  D --> E["Avenge counters"]
  E --> F["Deathrattles ×(1 + extraDeathrattles)"]
  F --> G["Reborn: 1 hp copy at the same position"]
  G --> H{"board changed?"}
  H -- yes --> A
  H -- no --> I["fillFromHand, done"]
```

## 6. Card text → `CardFx`

```mermaid
flowchart TD
  A["compileFx(card, cards)"] --> B{"MANUAL[normalId ?? id]?"}
  B -- yes --> Z["hand-written handler<br/>(24 cards)"]
  B -- no --> C["cleanText: strip tags, [x], $"]
  C --> D["split on headers:<br/>Deathrattle / Start of Combat /<br/>Rally / Avenge (N) / Battlecry / …"]
  D --> E["leading text"]
  D --> F["sections"]
  E --> G["strip bare keywords →<br/>parseTriggerSentence"]
  G --> H{"matched?"}
  H -- no --> I{"SHOP_TRIGGER<br/>allowlist?"}
  I -- no --> U["unsupported[]"]
  F --> J{"Battlecry / Activate /<br/>Spellcraft / Choose One?"}
  J -- yes --> K["skip — shop phase"]
  J -- no --> L["parseBody →<br/>sentences → parseAction"]
  L --> M{"template matched?"}
  M -- no --> U
  M -- yes --> N["Effect[] attached to<br/>deathrattle / startOfCombat /<br/>rally / avenge"]
  H -- yes --> N
  U --> V["SimOdds.unsupported<br/>→ 'Not modelled: …' in the UI"]
```

## 7. `TrackerStatus` decision

```mermaid
flowchart TD
  A["publish()"] --> B{"logConfigOk?"}
  B -- no --> S1["setup-needed"]
  B -- yes --> C{"tail attached?"}
  C -- no --> S2["waiting-for-logs<br/>(no log dir / no Power.log)"]
  C -- yes --> D{"silent > 3 min<br/>while in game?"}
  D -- yes --> S3["waiting-for-logs<br/>'restart Hearthstone'"]
  D -- no --> E{"game.phase"}
  E -- none --> S4["idle"]
  E -- other --> F{"isBattlegrounds?"}
  F -- no --> S5["not-battlegrounds"]
  F -- yes --> G{"phase === over?"}
  G -- "yes, < 30 s" --> S6["game-over"]
  G -- "yes, > 30 s" --> S4
  G -- no --> S7["in-game"]
```

## 8. IPC map

```mermaid
flowchart LR
  subgraph R["Renderer (window.api)"]
    direction TB
    r1["snapshot()"]
    r2["setupStatus()<br/>fixLogConfig()<br/>browseInstall()"]
    r3["matches()<br/>deleteMatch(id)"]
    r4["settings()<br/>updateSettings(patch)"]
    r5["pool()"]
    r6["openExternal(url)"]
    p1["onSnapshot"]
    p2["onDataChanged"]
    p3["onSettingsChanged"]
  end

  subgraph M["Main (index.ts handlers)"]
    direction TB
    h1["tracker.snapshot()"]
    h2["tracker.setupStatus / fixLogConfig /<br/>dialog + setInstallPath"]
    h3["store.matches / deleteMatch"]
    h4["store.settings / updateSettings<br/>+ setSimIterations + updateOverlays"]
    h5["tracker.cards.pool()"]
    h6["shell.openExternal — https only"]
    b["broadcast() → every window"]
  end

  r1 -->|"tracker:snapshot"| h1
  r2 -->|"setup:status / setup:fixLogConfig / setup:browse"| h2
  r3 -->|"matches:list / matches:delete"| h3
  r4 -->|"settings:get / settings:update"| h4
  r5 -->|"cards:pool"| h5
  r6 -->|"app:openExternal"| h6
  h3 --> b
  h4 --> b
  b -->|"tracker:snapshot"| p1
  b -->|"data:changed"| p2
  b -->|"settings:changed"| p3
```

## 9. Duos — reconstructing the four warbands

```mermaid
flowchart TD
  A["TURN flips even"] --> B["snapshot warbandIds<br/>= ids of YOUR real board minions"]
  B --> C["client creates copies of all<br/>four warbands in SETASIDE"]
  C --> D{"lookahead available?"}
  D -- yes --> E["lookCreated: entities frozen at<br/>the first ATTACK block of this turn"]
  D -- no --> F["combatCreated<br/>(PowerTaskList, lossy)"]
  E --> G["sort by entity id"]
  F --> G
  G --> H{"entity kind"}
  H -- "HERO with PLAYER_ID<br/>in SETASIDE" --> I["open a new group<br/>cur = PLAYER_ID"]
  H -- "MINION in SETASIDE<br/>COPIED_FROM_ENTITY_ID ∈ warbandIds" --> J["it's YOURS"]
  H -- "MINION in SETASIDE / HAND" --> K{"ZONE=HAND<br/>or tag 3085 != HEALTH?"}
  K -- yes --> L["hand"]
  K -- no --> M["board — boardStarted = true,<br/>everything after is board"]
  L --> N["backstop: board > 7 →<br/>move the excess to the hand"]
  M --> N
  N --> O["duoBoards: playerId → { board, hand }"]
  O --> P["reservePid: first team member<br/>not in enteredPids"]
  P --> Q{"found?"}
  Q -- yes --> R["BoardInput.reserve"]
  Q -- no --> S["reserveUnknown<br/>→ SimOdds.partial = true<br/>→ 'only current boards simulated'"]
```

Tag `3085` is undocumented — see
[api-reference.md](api-reference.md#tag-3085).

## 10. Renderer component tree

```mermaid
flowchart TD
  App --> TB["Titlebar + StatusChip"]
  App --> SB["Sidebar nav + Recent"]
  App --> PG{"page"}
  PG --> LIVE["LivePage"]
  PG --> MIN["MinionsPage"]
  PG --> HIS["HistoryPage"]
  PG --> STA["StatsPage"]
  PG --> SET["SettingsPage"]

  LIVE --> HP1["HeroPortrait"]
  LIVE --> OB["OddsBar"]
  LIVE --> BD["Board ×4<br/>(theirs, their reserve,<br/>yours, your reserve)"]
  LIVE --> LL["LobbyList → LobbyRow"]
  LIVE --> RT["RoundsTable"]
  LIVE --> SS["SessionStrip"]
  BD --> MC["MinionCard"]
  LL --> BD
  HIS --> MD["MatchDetail → RoundsTable"]
  RT --> RB["ResultBadge"]

  subgraph OVW["overlay.html"]
    OVR["Overlay"] --> OD["OddsOverlay → OddsBar"]
    OVR --> LO["LobbyOverlay → LobbyList + TribeChips + SessionStrip"]
  end
```

Shared components live in `components.tsx` and are used by both windows.
