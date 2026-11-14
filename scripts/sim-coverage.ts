// List Battlegrounds cards whose text the simulator doesn't understand.
//   npx tsx scripts/sim-coverage.ts <cards.json from https://api.hearthstonejson.com/v1/latest/enUS/cards.json> [--all | --hero-powers | --enchantments | --trinkets]
// By default checks what can be offered now: the tavern pool and the Timewarped
// tavern. --all checks every Battlegrounds minion (tokens, hero rewards,
// rotated-out cards) that could still show up. --hero-powers checks hero powers;
// --enchantments the enchantments that give a minion combat text (Dark Gifts, Murloc King...);
// --trinkets what trinkets do during combat (their Start of Combat has happened before the boards are captured).
import { readFileSync } from 'node:fs'
import { CardDb, slim } from '../src/main/cards/cardDb'
import { compileFx, compileHeroPower, compileTrinket } from '../src/main/bg/sim/effects'
import type { CardInfo } from '../src/shared/types'

const db = new CardDb()
const raw = slim(JSON.parse(readFileSync(process.argv[2], 'utf8')))
db.load(raw)
const byTier = (a: CardInfo, b: CardInfo) => (a.techLevel ?? 0) - (b.techLevel ?? 0) || a.id.localeCompare(b.id)

if (process.argv.includes('--hero-powers')) {
  const powers = raw.filter((c) => c.type === 'HERO_POWER' && c.set === 'BATTLEGROUNDS').sort((a, b) => a.name.localeCompare(b.name))
  const names = new Set<string>()
  for (const p of powers) {
    if (names.has(p.name)) continue // skins share a handler
    const fx = compileHeroPower(p, db)
    if (!fx.unsupported.length) continue
    names.add(p.name)
    console.log(`${p.id.padEnd(28)} ${p.name}: ${fx.unsupported.join(' | ')}`)
  }
  console.log(`\n${new Set(powers.map((p) => p.name)).size} hero powers checked; ${names.size} have unmodelled combat text.`)
} else if (process.argv.includes('--trinkets')) {
  // Quest rewards and anomalies are passive cards too, and go through the same path.
  const passive = ['BATTLEGROUND_TRINKET', 'BATTLEGROUND_QUEST_REWARD', 'BATTLEGROUND_ANOMALY']
  const trinkets = raw.filter((c) => passive.includes(c.type ?? '') && c.set === 'BATTLEGROUNDS')
  let bad = 0
  for (const c of trinkets) {
    const fx = compileTrinket(c, db, true)
    if (!fx.unsupported.length) continue
    bad++
    console.log(`${c.id.padEnd(24)} ${c.name}: ${fx.unsupported.join(' | ')}`)
  }
  console.log(`\n${trinkets.length} trinkets, quest rewards and anomalies checked; ${bad} have unmodelled combat text.`)
} else if (process.argv.includes('--enchantments')) {
  let n = 0
  let bad = 0
  for (const c of raw.filter((x) => x.type === 'ENCHANTMENT' && x.set === 'BATTLEGROUNDS' && /Deathrattle|Rally|Start of Combat/i.test(x.text ?? ''))) {
    n++
    const fx = compileFx(c, db)
    if (!fx.unsupported.length) continue
    bad++
    console.log(`${c.id.padEnd(30)} ${c.name}: ${fx.unsupported.join(' | ')}`)
  }
  console.log(`\n${n} combat enchantments checked; ${bad} have unmodelled text.`)
} else {
  const all = process.argv.includes('--all')
  const cards = (all ? db.bgMinions() : raw.filter((c) => c.type === 'MINION' && (c.pool || c.timewarp) && !c.normalId)).sort(byTier)
  const seen = new Set<string>()
  let unsupported = 0
  for (const c of cards) {
    for (const card of [c, db.get(c.goldenId)]) {
      if (!card || seen.has(card.id)) continue
      seen.add(card.id)
      const fx = compileFx(card, db)
      if (!fx.unsupported.length) continue
      unsupported++
      console.log(`T${c.techLevel ?? '-'} ${card.timewarp ? 'TW ' : ''}${card.id.padEnd(18)} ${card.name}: ${fx.unsupported.join(' | ')}`)
    }
  }
  console.log(`\n${seen.size} minions checked; ${unsupported} have unmodelled text.`)
}
