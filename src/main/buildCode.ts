import type { Build, BuildTarget } from '../shared/types'

/**
 * Builds as a short shareable code:
 *
 *   HTB Scam murlocs [m]|4:AHAJAPAfAtBB c:KYUr +Aq#3f
 *
 * Cards are indices into the Battlegrounds minion list sorted by dbfId — about
 * 1260 entries — written as two characters each from a 64-symbol alphabet.
 * Fixed width means no separators between cards, which is most of the saving.
 * A 26-card build lands near 90 characters, against ~160 as base64 and ~480
 * written out in card names.
 *
 * The structure stays visible on purpose: `4:` `8:` `c:` are the stage turns,
 * `+` starts the addons, `#` is a checksum. You can see the shape of a build
 * without being able to read the minions.
 *
 * The index depends on that card list only ever growing at the end, which is
 * how dbfIds are allocated. If it ever doesn't, the checksum catches it: a
 * decode that doesn't match refuses rather than quietly handing over a build
 * made of the wrong minions.
 */
const HEADER = /^HTB\b/

/** Single-letter tribe codes, so a tribe costs three characters, not nine. */
const TRIBE_CODES: Record<string, string> = {
  b: 'BEAST',
  d: 'DEMON',
  g: 'DRAGON',
  e: 'ELEMENTAL',
  h: 'MECHANICAL',
  m: 'MURLOC',
  n: 'NAGA',
  p: 'PIRATE',
  q: 'QUILBOAR',
  u: 'UNDEAD',
  a: 'ABERRATION',
}
const codeForTribe = (t: string) => Object.keys(TRIBE_CODES).find((k) => TRIBE_CODES[k] === t)

/**
 * Indices are two characters from a 64-symbol alphabet: 4096 slots for a list
 * currently at ~1260, and fixed width so no separator is needed between cards.
 *
 * The first attempt here used base36 and capitalised each number's last digit
 * to mark where it ended. That silently fails: "7".toUpperCase() is "7", so
 * every index ending in a digit ran into the next one.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const WIDTH = 2
const CAPACITY = ALPHABET.length ** WIDTH

function packNum(n: number): string {
  if (n < 0 || n >= CAPACITY) throw new Error(`Card index ${n} is out of range for a build code`)
  return ALPHABET[Math.floor(n / ALPHABET.length)] + ALPHABET[n % ALPHABET.length]
}

function unpackNums(s: string): number[] {
  if (s.length % WIDTH) throw new Error('That build code is cut short')
  const out: number[] = []
  for (let i = 0; i < s.length; i += WIDTH) {
    const hi = ALPHABET.indexOf(s[i])
    const lo = ALPHABET.indexOf(s[i + 1])
    if (hi < 0 || lo < 0) throw new Error(`Unexpected character in a build code`)
    out.push(hi * ALPHABET.length + lo)
  }
  return out
}

/** Cheap, order-sensitive, and only two characters on the wire. */
function checksum(ids: number[]): string {
  let h = 7
  for (const n of ids) h = (h * 31 + n) % 1296
  return h.toString(36).padStart(2, '0')
}

export interface Codec {
  /** Position of a card in the dbfId-sorted Battlegrounds minion list. */
  indexOf: (cardId: string) => number | undefined
  cardAt: (index: number) => string | undefined
}

export function encodeBuild(build: Build, codec: Codec): string {
  const seen: number[] = []
  const pack = (ids: string[]) =>
    ids
      .map(codec.indexOf)
      .filter((i): i is number => i !== undefined)
      .map((i) => {
        seen.push(i)
        return packNum(i)
      })
      .join('')

  const tribe = codeForTribe(build.tribe)
  const parts: string[] = []
  for (const t of [...build.targets].sort((a, b) => a.byTurn - b.byTurn)) {
    if (t.cardIds.length) parts.push(`${t.byTurn.toString(36)}:${pack(t.cardIds)}`)
  }
  if (build.addons?.length) parts.push(`+${pack(build.addons)}`)
  // HSReplay comps are reconstructed from the id alone rather than a whole URL.
  const comp = build.source?.url.match(/\/comps\/(\d+)\//)
  if (comp) parts.push(`@${comp[1]}`)
  return `HTB ${build.name}${tribe ? ` [${tribe}]` : ''}|${parts.join(' ')}#${checksum(seen)}`
}

export interface Decoded {
  /** Everything but the id — the importer assigns a fresh one. */
  build: Omit<Build, 'id'>
  /** Indices no card could be found for. */
  missing: number
}

export function decodeBuild(code: string, codec: Codec): Decoded {
  const text = code.trim()
  if (!HEADER.test(text)) throw new Error('A build code starts with "HTB" — check you copied the whole thing')
  const bar = text.indexOf('|')
  if (bar < 0) throw new Error('That build code is damaged — the part after the name is missing')

  const head = text.slice(3, bar).trim()
  const tribeMatch = head.match(/\[([a-z])\]\s*$/)
  const name = (tribeMatch ? head.slice(0, tribeMatch.index).trim() : head) || 'Imported build'
  const tribe = tribeMatch ? (TRIBE_CODES[tribeMatch[1]] ?? '') : ''

  let body = text.slice(bar + 1).trim()
  let stated: string | undefined
  const hash = body.lastIndexOf('#')
  if (hash >= 0) {
    stated = body.slice(hash + 1).trim()
    body = body.slice(0, hash)
  }

  const seen: number[] = []
  let missing = 0
  const cards = (packed: string) =>
    unpackNums(packed)
      .map((i) => {
        seen.push(i)
        const id = codec.cardAt(i)
        if (!id) missing++
        return id
      })
      .filter((id): id is string => !!id)

  const targets: BuildTarget[] = []
  let addons: string[] = []
  let source: Build['source']
  for (const part of body.split(/\s+/).filter(Boolean)) {
    const stage = part.match(/^([0-9a-z]+):(.*)$/)
    if (stage) {
      targets.push({ byTurn: parseInt(stage[1], 36), cardIds: cards(stage[2]) })
      continue
    }
    if (part.startsWith('+')) {
      addons = cards(part.slice(1))
      continue
    }
    const comp = part.match(/^@(\d+)$/)
    if (comp) source = { name: 'HSReplay · JeefHS', url: `https://hsreplay.net/battlegrounds/comps/${comp[1]}/` }
  }
  if (!targets.length && !addons.length) throw new Error('That build code has no minions in it')

  // The index list shifting under us would otherwise produce a plausible build
  // made of the wrong cards, which is far worse than refusing to import.
  if (stated && stated !== checksum(seen)) {
    throw new Error("That build code doesn't match your card data — it may be from a newer version of the tracker")
  }

  const build: Omit<Build, 'id'> = { name, tribe, targets, addons }
  if (source) build.source = source
  return { build, missing }
}
