// List Battlegrounds minions whose text the simulator doesn't understand.
//   npx tsx scripts/sim-coverage.ts <cards.json from https://api.hearthstonejson.com/v1/latest/enUS/cards.json> [--all]
// By default checks the current tavern pool; --all checks every Battlegrounds
// minion (tokens, hero rewards, rotated-out cards) that could still show up.
import { readFileSync } from 'node:fs'
import { CardDb, slim } from '../src/main/cards/cardDb'
import { compileFx } from '../src/main/bg/sim/effects'

const db = new CardDb()
db.load(slim(JSON.parse(readFileSync(process.argv[2], 'utf8'))))
const all = process.argv.includes('--all')
const cards = (all ? db.bgMinions() : db.pool()).sort((a, b) => (a.techLevel ?? 0) - (b.techLevel ?? 0) || a.id.localeCompare(b.id))
const seen = new Set<string>()
let unsupported = 0
for (const c of cards) {
  for (const card of [c, db.get(c.goldenId)]) {
    if (!card || seen.has(card.id)) continue
    seen.add(card.id)
    const fx = compileFx(card, db)
    if (!fx.unsupported.length) continue
    unsupported++
    console.log(`T${c.techLevel ?? '-'} ${card.id.padEnd(18)} ${card.name}: ${fx.unsupported.join(' | ')}`)
  }
}
console.log(`\n${seen.size} minions checked; ${unsupported} have unmodelled text.`)
