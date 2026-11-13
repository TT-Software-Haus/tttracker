// Turn a real Power.log into a small, anonymised test fixture:
//   npx tsx scripts/make-fixture.ts <Power.log> tests/fixtures/<name>.log.gz
// Keeps only GameState lines (what the tracker reads) and replaces every
// player name and account id with placeholders.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { gzipSync } from 'node:zlib'

const [src, out] = process.argv.slice(2)
const lines = readFileSync(src, 'utf8')
  .split(/\r?\n/)
  .filter((l) => / (GameState|PowerTaskList)\.(DebugPrintPower|DebugPrintGame)\(\) - /.test(l))

const names = new Map<string, string>()
const alias = (n: string) => {
  if (!names.has(n)) names.set(n, `Player${names.size + 1}`)
  return names.get(n)!
}
for (const l of lines) {
  const m = /PlayerName=(.+)$/.exec(l)
  if (m) alias(m[1].trim())
}
// Bare entity names in TAG_CHANGE / BLOCK_START (anything that isn't a number, GameEntity or [..]).
for (const l of lines) {
  const m = /Entity=([^\[\d][^=]*?) (?:tag|EffectCardId)=/.exec(l)
  if (m && m[1] !== 'GameEntity') alias(m[1])
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const nameRe = new RegExp([...names.keys()].sort((a, b) => b.length - a.length).map(esc).join('|'), 'g')
const cleaned = lines.map((l) =>
  l
    .replace(/GameAccountId=\[hi=(\d+) lo=\d+\]/, (_m, hi: string) => `GameAccountId=[hi=${hi === '0' ? 0 : 1} lo=${hi === '0' ? 0 : 1}]`)
    .replace(nameRe, (n) => names.get(n)!),
)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, gzipSync(cleaned.join('\n')))
console.log(`${cleaned.length} lines, ${names.size} names replaced -> ${out}`)
