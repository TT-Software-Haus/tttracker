// Hearthstone never writes the lobby's minion types to Power.log before the
// first shop — verified on a real game: zero IS_BACON_POOL_MINION markers
// appear before the hero is locked in, and only 5 of 7 tribes are known by
// round 1. The hero-select screen shows all of them in one banner
// ("Demons, Dragons, Elementals, Mechs, Pirates"), so that banner is the only
// source available at the moment we need to offer a build.
//
// This file is the pure half: OCR text in, race codes out. Kept clear of
// electron so it can be tested without a display.

/** Banner wording → the race code used by card data. */
const TRIBE_WORDS: Record<string, string> = {
  demons: 'DEMON',
  dragons: 'DRAGON',
  elementals: 'ELEMENTAL',
  mechs: 'MECHANICAL',
  murlocs: 'MURLOC',
  naga: 'NAGA',
  pirates: 'PIRATE',
  quilboar: 'QUILBOAR',
  undead: 'UNDEAD',
  beasts: 'BEAST',
  aberrations: 'ABERRATION',
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length]
}

/**
 * OCR gets a letter wrong often enough that exact matching would drop a whole
 * tribe, so each token goes to its nearest known name. The allowance scales
 * with length: "naga" can't afford two edits without colliding with noise,
 * "aberrations" can.
 */
function nearestTribe(token: string): string | undefined {
  let best: string | undefined
  let bestDist = Infinity
  for (const word of Object.keys(TRIBE_WORDS)) {
    const d = levenshtein(token, word)
    if (d < bestDist) {
      bestDist = d
      best = word
    }
  }
  if (!best) return undefined
  const allowed = best.length <= 5 ? 1 : 2
  return bestDist <= allowed ? TRIBE_WORDS[best] : undefined
}

/**
 * The race code for a single word — "Quilboar" → QUILBOAR. Also used to read
 * the tribe out of an HSReplay comp name ("Quilboar - APM Shop Buff"), which
 * happens to use the same wording as the banner.
 */
export function tribeFromWord(word: string): string | undefined {
  return nearestTribe(word.toLowerCase().replace(/[^a-z]/g, ''))
}

/**
 * Race codes read out of the hero-select banner. Returns [] when nothing in the
 * text looks like a tribe, which is how the caller tells a bad capture (wrong
 * screen, game minimised) from a real read.
 */
export function parseTribeBanner(text: string): string[] {
  const found = new Set<string>()
  for (const token of text.toLowerCase().split(/[^a-z]+/)) {
    if (token.length < 4) continue // "a", "of" — nothing real is shorter than "naga"
    const tribe = nearestTribe(token)
    if (tribe) found.add(tribe)
  }
  return [...found].sort()
}
