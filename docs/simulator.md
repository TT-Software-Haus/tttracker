# The combat simulator

`src/main/bg/sim/` — `engine.ts` (rules) and `effects.ts` (card text → effects).

Self-contained: it takes a `CardSource` and two boards and knows nothing about logs,
Electron or React. That's why it's cheap to test.

## Entry point

```ts
simulateMany(cards, a: BoardInput, b: BoardInput, opts?: {
  iterations?: number      // default 5000
  seed?: number            // default random
  firstAttacker?: 0 | 1
  skipStartOfCombat?: boolean
  myHealth?: number
  oppHealth?: number
  timeBudgetMs?: number
}): SimSummary
```

```ts
interface SimSummary {
  win, tie, loss              // fractions of iterations
  avgDamageDealt              // mean over WINS only
  avgDamageTaken              // mean over LOSSES only
  lethalWin, lethalLoss       // fraction of all iterations where damage >= opp/my health
  iterations, ms
  unsupported: string[]       // names of minions whose text didn't compile
}
```

The loop checks `timeBudgetMs` every 100 iterations and breaks early;
`SimSummary.iterations` reports what was actually run. `BgGame` passes 400 ms.

RNG is `mulberry32(seed)` — deterministic, and every random choice routes through it.
One closure is shared across all iterations, so the aggregate run is reproducible for a
given seed but an individual iteration is not independently reproducible.

## Board model

```ts
interface BoardInput {
  minions: MinionInput[]      // current in-game stats, not printed stats
  heroTier: number
  hand?: MinionInput[]        // Choral Mrrrglr, Diremuck Forager
  teammate?: MinionInput[]    // Duos (Sandy)
  reserve?: { minions, heroTier, hand? }   // Duos: the warband that comes in next
}
```

Keywords are supplied **per minion instance**, not read from the card, so buffs and
keywords granted in the shop are respected. Board cap is 7, enforced everywhere.

A live `Minion` is a flat mutable struct: stats, `baseAtk` (printed, used by Reborn),
`tier`, `tribes`, keyword flags, `windfury: 1 | 2 | 4`, an `avenge` counter,
`killedBy`, and a shared `fx: CardFx` cached per card id.

A `Side` additionally carries `nameBonus` / `tribeBonus` maps ("Your Beetles have
+5/+5"), applied retroactively in `summon()` so later tokens inherit them.

## Combat loop

1. Minions with "Taunt while this has Divine Shield" get taunt.
2. First attacker: `opts.firstAttacker`, else whoever has more minions, else coin flip.
3. Start of Combat — per side, hand effects then board effects left to right, then
   resolve deaths; afterwards any `attackImmediately` minions attack. (Skipped when
   `BgGame` captures at the first attack, which is the normal live path.)
4. Up to `MAX_ATTACKS = 300` steps: bring in Duos reserves if a side emptied, pick the
   next attacker, attack, alternate sides.
5. Outcome: survivor's `heroTier + Σ survivors' tiers` damage, or a tie.

**Attacker selection** scans circularly from `side.nextAttacker` and skips anything
with `atk <= 0` — a board of 0-attack minions ties out rather than looping forever.

**Targeting** (`chooseTarget`): living enemies → drop stealthed (unless all are
stealthed) → keep taunts if any → uniform random pick.

**One attack**, in order: clear the attacker's stealth → Rally → friendly-attack
triggers → build the hit list (plus neighbours if Cleave) → fire `attacked` triggers on
the defender **before** damage → snapshot both attack values → deal damage out, then
retaliation (unless immune-while-attacking) → kill triggers → overkill splash →
after-attack → resolve deaths.

**`damage()`**: Divine Shield absorbs the whole instance (including poison), otherwise
subtract, and if the source is venomous/poisonous and the target survived, destroy it
— venomous is consumed, poisonous isn't.

**`resolveDeaths()`** batches: collect every dead minion, remove them all, then per
corpse in order run `dies` triggers → **Avenge** counters → **Deathrattles**
(`extraDeathrattles` from Titus-style effects multiplies them) → **Reborn** (1 hp copy
at the same position, printed attack). Repeat until stable, max 50 passes.

### Keywords

Taunt, Stealth, Divine Shield, Poisonous, Venomous, Windfury / Mega-Windfury (as a
1/2/4 attack count), Reborn, Cleave, Avenge(N), immune-while-attacking, and an
overkill-splash hook. **Magnetic is parsed away but never modelled.**

## Card text → effects (`effects.ts`)

`compileFx(card, cards): CardFx` turns a card's text into a bag of hooks
(`deathrattle`, `startOfCombat`, `rally`, `avenge`, `triggers`, `onSummon`,
`onShieldLost`, `friendlyAttack`, `cleave`, …) plus `unsupported: string[]`.

Pipeline:

1. **Manual override.** `MANUAL[card.normalId ?? card.id]` short-circuits everything.
   24 hand-written entries (Leeroy, Wildfire Elemental, Sandy, Diremuck Forager,
   Choral Mrrrglr, …). Golden and normal share one handler, which branches on a `g()`
   multiplier.
2. **Clean** the text (strip tags, `[x]`, `$`, newlines).
3. **Split on headers** — `Deathrattle:`, `Start of Combat:`, `Rally:`, `Avenge (N):`,
   and so on. `Battlecry` / `Activate` / `Spellcraft` / `Choose One` sections are
   skipped outright (they're shop-phase).
4. **Leading text** is tried as a trigger sentence ("Whenever another friendly Dragon
   attacks, give it +3/+1", "Also damages adjacent minions", "Your Deathrattles trigger
   one extra time", …) or matched against a large allowlist of shop-only phrasings.
5. **Bodies** are split into sentences and matched against action templates: summon
   N/golden/random-tribe tokens, give/gain stats and keywords, deal damage to a
   selector, play Blood Gems, "Your Murlocs have +2/+2", remove keywords, attack
   immediately, cast a tavern spell (recursively compiled from the spell's own text),
   double its attack.

Anything that doesn't match any template is pushed onto `unsupported`, which bubbles
all the way to the UI as *"Not modelled: …"* under the odds.

**Golden cards work for free** — they have their own text with the numbers already
doubled, so parsing the actual card's text is correct without any special casing.

## Hero powers

`BoardInput.heroPower` and `reserve.heroPower` carry the hero power's card id.
`compileHeroPower` looks it up by **name** in `HERO_POWERS` (so skins share a handler)
and returns a `startOfCombat(c, side)` effect. It runs before the side's minions' Start
of Combat: in `startOfCombat()` when that isn't skipped, and in `bringInReserves()`
every time, because a Duos reserve is captured before the fight and its hero power
fires as it enters. Then attack-immediately minions swing. A hero power with "Start of
Combat" text and no handler is listed under `unsupported`.

Modelled: Wingmen (Illidan).

## Known limitations

- Shop auras ("Your other Murlocs have +2 Attack") are deliberately treated as no-ops,
  because the log already reports the buffed stats. The simulator is only correct when
  fed current stats — which `toInput()` does.
- Blood Gems are modelled as flat +1/+1; game-long gem upgrades aren't visible.
- Magnetic, "deity" text, granting poisonous or stealth via text, and windfury→mega
  upgrades are not modelled.
- `castSpell` is all-or-nothing: one unparsed sentence makes the whole cast unsupported.
- `unsupported` is computed over board and reserve minions only — not hand or teammate
  minions.
- Unsupported leading text is only *detected* if it mentions attack/dies/summon/reborn/
  divine shield/damage/combat. Combat-relevant text phrased otherwise is dropped
  silently.
- Hard caps: 300 attack steps and 50 death-resolution passes. Hitting either truncates
  the fight (and probably reports a tie).
- Per-combat trigger limits ("Twice per combat") are enforced on generic triggers;
  manual handlers count their own.
- Hero powers: only those in `HERO_POWERS` (`effects.ts`) are modelled; see below.

## Checking coverage after a patch

```sh
# download cards.json from https://hearthstonejson.com first
npx tsx scripts/sim-coverage.ts cards.json        # current tavern pool
npx tsx scripts/sim-coverage.ts cards.json --all  # + tokens, rewards, rotated cards
```

Prints one line per minion (and its golden version) whose text didn't compile, with the
offending sentences, then a `N minions checked; M have unmodelled text` summary. That
list is the to-do list for `effects.ts`.
