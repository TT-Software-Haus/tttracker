// Extract just the cards a fixture log references, so tests don't need the network:
//   npx tsx scripts/make-card-fixture.ts <cards.json from HearthstoneJSON> <fixture.log.gz> <out.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { slim } from '../src/main/cards/cardDb'

const [cardsPath, logPath, out] = process.argv.slice(2)
const all = slim(JSON.parse(readFileSync(cardsPath, 'utf8')))
const log = gunzipSync(readFileSync(logPath)).toString()
const ids = new Set([...log.matchAll(/CardID=(\w+)|cardId=(\w+)/g)].map((m) => m[1] ?? m[2]))
const keep = all.filter((c) => ids.has(c.id) || (c.normalId && ids.has(c.normalId)) || (c.type === 'MINION' && c.set === 'BATTLEGROUNDS' && !c.pool && c.techLevel === 1))
writeFileSync(out, JSON.stringify(keep))
console.log(`${keep.length} cards -> ${out}`)
