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
  damageCap?: number       // the game's per-fight damage cap, while it's on (BgGame reads it)
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

### Engine hooks for card effects

- **`triggerDeathrattle(m, side, pos)`** runs a minion's own Deathrattle plus any it was
  given (`grantedDeathrattles`: Leapfrogger, Whirl-O-Tron), then fires
  `afterDeathrattle` ("After you trigger a Deathrattle"). Death processing and every
  "trigger a Deathrattle" effect go through it.
- **`buff()`** fires `onGainStats` on the buffed minion's side ("Whenever a friendly
  minion gains Attack", "After this gains stats"), with the gain in `ev.atk/ev.hp`.
  Hand minions have no side, so buffing them triggers nothing. Depth-capped at 20.
- **`grantedRallies`** (Stoneshell) run alongside the attacker's own Rally.
- **`rebornFull`** (Timewarped Hag): Reborn keeps its stats and granted effects.
- **`side.bloodGem`**: what one Blood Gem gives in this fight, +1/+1 plus in-combat
  upgrades (Gemsplitter, Jazzer). Game-long upgrades aren't in the log, so Blood Gem
  cards are flagged approximated.
- **`side.start`**: the warband as the fight (or reserve) began (Magnanimoose).
- **Per-combat limits** on Rally sections are enforced per minion (`limited()`).

- **`side.dead`**: friendly minions that died this combat, as they died ("your first 2
  Mechs that died this combat", Elementium Squirrel Bomb).
- **`side.summonBuffs`**: buffs applied to every later summon that matches ("for the rest
  of this combat, after you summon a Pirate", tribe auras like Raptor Elder's).
- **`summon(side, m, pos, plain)`**: card summons are multiplied by Khadgar
  (`summonExtra`) and Captain Bonerender (`copySummons`); Reborn, hand summons and the
  copies themselves are `plain`. A summon that doesn't fit fires `onSummonFail`.
  Effects that summon reset `c.batch`, which "Give them Taunt" reads.
- **Targeting** (`fx.targeting`): Zapp / Merciless Mammoth hit the lowest Attack
  (ignoring Taunt); Worgen Vigilante prefers an enemy it can kill.
- **Damage**: `shieldHits` (a Divine Shield that takes N hits), `doubleDamage`
  (Whitemane), `redirectDamage` (Mad Matador, once).
- **Triggers from hand** (`summonSelfFromHand`, Free-Flying Feathermane), **when you have
  space** for minions as well as hero powers, **any-side deaths** (`onAnyDeath`), and
  first-attack immunity (`side.immuneAttacks`, Eclipsion Illidari).
- **Spells cast in combat** cast extra times for each `spellExtra` (Maelstrom Emergent,
  Balinda); **Blood Gems** get `gemBonus` (Agamaggan) and `gemMultiplier` (Needling
  Crone) when played.

Quoted text ('Give your minions "Deathrattle: Summon a 1/1 Murloc."') is masked while a
card is split into sections and sentences, so its header and full stop don't split it,
and restored when an action is read. "Summon a 1/1 Pirate. It attacks immediately." is
read as one action (before, the second sentence was dropped and the Pirate never
attacked).

Measured cost: about 40µs per iteration on a busy 7v7, up from 28µs before the card
work. 5000 iterations take about 200ms, half the 400ms budget, on the sim worker.

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

`BoardInput.heroPower` and `reserve.heroPower` carry the hero power's card id
(`BoardInput.turn` too, for "Unlocks on Turn 7"). `compileHeroPower(card, cards)`:

- **Start of Combat text** is parsed with the minion action templates. A hero power has
  no minion behind it, so its effects act through a stand-in minion that never joins the
  board. The effect runs before the side's minions' Start of Combat: in
  `startOfCombat()` when that isn't skipped, and in `bringInReserves()` every time,
  because a Duos reserve is captured before the fight and its hero power fires as it
  enters. Then attack-immediately minions swing.
- **All-combat effects** (`passive`, a `CardFx`): Sprout It Out!, Broodmother, Frostwolf
  Fervor / Stormpike Strength. They go on `side.hero`, a stand-in the engine includes in
  summon, Avenge and `whenSpace` processing. They act even when Start of Combat is
  skipped.
- **`HERO_POWERS`** (by **name**, so skins share a handler) for the rest: Wingmen, and
  the choice-based ones.
- **Approximated:** Deadeye's target, Glorious Gloop's and Rapid Reanimation's chosen
  minion (random), Wax Warband and Broodmother's improvements (printed numbers).
- **Murloc King** gives its Deathrattles at Start of Combat. On the first warband they
  arrive as enchantments (below); a reserve is assumed to have used it (approximated).

## Trinkets

`BoardInput.trinkets` carries each side's trinket card ids: `BATTLEGROUND_TRINKET`
entities in play for that controller (checked on real logs: both sides' are there during
a fight; the "Lesser/Greater Trinket" cards are empty slots). A reserve's trinkets aren't
known.

`compileTrinket(card, cards, afterStart)` reads them like card text, except that untimed
sentences ("Get a Titus Rivendare.") happen when the trinket is bought and are skipped.
With `afterStart` (the live path, Start of Combat already happened) the Start of Combat
section is left out too. Each trinket becomes a stand-in minion in `side.standIns`,
alongside the hero power's: never on the board, but included by `watchers(side)` in every
trigger loop (deaths, summons, Avenge, attacks, shields, stat gains, Reborn, "when you
have space"), and its auras apply to summons.

Quest rewards (`BATTLEGROUND_QUEST_REWARD`, the owner's) and the lobby's anomaly
(`BATTLEGROUND_ANOMALY`, everyone's) go through the same path. Neither has been seen in
play in a local log yet, so that part follows the card types; check it against the first
real game that has one.

## Enchantments

What a minion was given before the boards were captured (a Deathrattle from Murloc King or
Earth Invocation, a Dark Gift, Leapfrogger's) is an enchantment: a log entity `ATTACHED`
to the minion, with its own card id and text. `BgGame` passes the ids of those whose text
has a Deathrattle, Rally or Start of Combat (`MinionInput.enchantments`); the engine
compiles them like card text and gives the minion the result (`grantedDeathrattles`,
`grantedRallies`, `grantedStartOfCombat`). Stat and keyword enchantments are already in
the numbers. The lookup is one pass over the entities per sim job (under 1ms).

`npx tsx scripts/sim-coverage.ts cards.json --hero-powers` lists what's left.

## Live odds

`BgGame` simulates at the first attack of a fight (the opening `odds`), then again at the start
of every later attack, from the board as it is on screen (PowerTaskList), into
`CombatRound.liveOdds`. The Live page and the overlay show `liveOdds ?? odds`; `liveOdds` is
cleared when the fight ends and left out of the saved match, so history and the accuracy stats
keep the opening odds. The GameState stream runs ahead and isn't used, so they can't spoil the
result.

- **Where attacks resume** (`BoardInput.nextAttacker`): the minion attacking now on its side; on
  the other, the left-most of those that have attacked least (`NUM_ATTACKS_THIS_TURN`).
- **Duos:** each re-sim notes which warbands have come in, so one that's fighting isn't also
  counted as the reserve still to come.
- **What has happened so far:** minions that died this fight (`BoardInput.dead`, from moves to
  the graveyard) and Avenge progress (`MinionInput.avenge`, the log's `SCORE_VALUE_2` on Avenge
  minions, seen counting 0-3 on an Avenge (4)). Not in the log, so a re-sim starts them empty:
  "per combat" uses, Blood Gem upgrades, buffs on later summons, Eclipsion's used immunity.
- **Worker:** live jobs go in a `newestOnly` lane: while one runs, only the newest waits; the rest
  are dropped (`Superseded`).
- Measured on 78 logged fights (Brier score, lower is better): 0.454 at the first attack, 0.416 a
  quarter of the way through, 0.285 halfway, 0.152 at three quarters, 0 at the end (every fight
  ends on its real result). Carrying deaths and Avenge counts took halfway from 0.290 to 0.285
  (run-to-run noise is about 0.001): small, because few fights have the cards that use them.
  Building each job costs about 1.3ms on the main thread.

## Known limitations

- Shop auras ("Your other Murlocs have +2 Attack") are deliberately treated as no-ops,
  because the log already reports the buffed stats. The simulator is only correct when
  fed current stats — which `toInput()` does.
- Blood Gems are +1/+1 plus in-combat upgrades; game-long gem upgrades aren't visible
  (flagged approximated).
- Magnetic, "deity" text, granting poisonous or stealth via text, and windfury→mega
  upgrades are not modelled.
- `castSpell` is all-or-nothing: one unparsed sentence makes the whole cast unsupported.
- `unsupported` is computed over board and reserve minions only — not hand or teammate
  minions.
- Hard caps: 300 attack steps and 50 death-resolution passes. Hitting either truncates
  the fight (and probably reports a tie).
- Per-combat trigger limits ("Twice per combat") are enforced on generic triggers;
  manual handlers count their own.
- Enchantments whose numbers are filled in at runtime ("Copied Deathrattles from 0",
  "+0 Attack") and Deity text aren't modelled (`--enchantments` lists them).

## Checking coverage after a patch

```sh
# download cards.json from https://hearthstonejson.com first
npx tsx scripts/sim-coverage.ts cards.json                # tavern pool + Timewarped tavern
npx tsx scripts/sim-coverage.ts cards.json --all          # every BG minion: tokens, rewards, rotated
npx tsx scripts/sim-coverage.ts cards.json --hero-powers  # hero powers with combat text
npx tsx scripts/sim-coverage.ts cards.json --enchantments # enchantments that give combat text
npx tsx scripts/sim-coverage.ts cards.json --trinkets     # trinkets, quest rewards, anomalies
```

Prints one line per card (and its golden version) whose text didn't compile, with the
offending sentences (`TW` marks Timewarped), then a summary. That list is the to-do list
for `effects.ts`.

**Every unrecognised sentence is reported.** Shop-only text is recognised instead of
hidden: `SHOP_TRIGGER` (sentence openings like "At the end of your turn"), `SHOP_WORDS`
(Tavern, Gold, Refresh, sell/buy, Pass, "each turn"…), parenthesised counters, and any
sentence that directly follows shop-only text (its continuation). Timewarped cards carry
`battlegroundsTimewarpCard`, not `isBattlegroundsPoolMinion`; `slim()` keeps it as
`timewarp`.

**Approximated.** `CardFx.approximated` lists text modelled on a best guess because the
log doesn't give what it needs; it reaches the UI as an "Approximated: …" line under the
odds, separate from "Not modelled".
