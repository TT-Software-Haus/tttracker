import type { Build, BuildTarget } from '../shared/types'
import { tribeFromWord } from './vision/tribeNames'

/**
 * Builds as text you can read, paste and edit by hand:
 *
 *   HTB Scam murlocs [Murlocs]
 *   T4: Murloc Tidecaller; Murloc Tidehunter
 *   T9: Primalfin Lookout; Primalfin Totem; Bloodlust Warleader
 *   +: Zapp Slywick
 *
 * Minions are separated by `;` rather than the obvious comma because 51 card
 * names contain one ("Agamaggan, the Great Boar"). `;` appears in no card name
 * at all, nor does `|`, which is why a build can also be pasted on a single
 * line with `|` between the rows for chats that eat newlines.
 *
 * Names are safe as identifiers here: across the 303 buyable pool minions, no
 * two share a name. The payoff for using them is that a build nobody can
 * resolve fails by *naming what it couldn't find*, and the recipient can fix
 * the line themselves — which a base64 blob can never offer.
 */
const HEADER = /^HTB\b/

export function encodeBuild(build: Build, nameOf: (cardId: string) => string | undefined): string {
  const named = (ids: string[]) => ids.map((id) => nameOf(id) ?? id).join('; ')
  const rows = [`HTB ${build.name}${build.tribe ? ` [${tribeLabel(build.tribe)}]` : ''}`]
  for (const t of [...build.targets].sort((a, b) => a.byTurn - b.byTurn)) {
    if (t.cardIds.length) rows.push(`T${t.byTurn}: ${named(t.cardIds)}`)
  }
  if (build.addons?.length) rows.push(`+: ${named(build.addons)}`)
  if (build.source) rows.push(`from: ${build.source.name} ${build.source.url}`)
  return rows.join('\n')
}

export interface Decoded {
  /** Everything but the id — the importer assigns a fresh one. */
  build: Omit<Build, 'id'>
  /** Names no card could be found for, so the recipient can correct them. */
  missing: string[]
}

export function decodeBuild(code: string, idOf: (name: string) => string | undefined): Decoded {
  const text = code.trim()
  if (!HEADER.test(text)) throw new Error('A build starts with "HTB" — check you copied the whole thing')

  // `|` is accepted as a row separator so a build survives being pasted into
  // something that strips newlines.
  const rows = text
    .split(/[\n|]+/)
    .map((r) => r.trim())
    .filter(Boolean)

  const missing: string[] = []
  const resolve = (list: string) =>
    list
      .split(';')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => {
        const id = idOf(n)
        if (!id) missing.push(n)
        return id
      })
      .filter((id): id is string => !!id)

  const head = rows[0].replace(HEADER, '').trim()
  const tribeMatch = head.match(/\[([^\]]+)\]\s*$/)
  const name = (tribeMatch ? head.slice(0, tribeMatch.index).trim() : head) || 'Imported build'
  const tribe = tribeMatch ? (tribeFromWord(tribeMatch[1]) ?? '') : ''

  const targets: BuildTarget[] = []
  let addons: string[] = []
  let source: Build['source']
  for (const row of rows.slice(1)) {
    const turn = row.match(/^T(\d+)\s*:\s*(.*)$/i)
    if (turn) {
      targets.push({ byTurn: Number(turn[1]), cardIds: resolve(turn[2]) })
      continue
    }
    const addon = row.match(/^\+\s*:\s*(.*)$/)
    if (addon) {
      addons = resolve(addon[1])
      continue
    }
    const from = row.match(/^from:\s*(.*?)\s*(https:\/\/\S+)\s*$/i)
    if (from) source = { name: from[1], url: from[2] }
    // Anything else is a comment someone added; ignoring it is kinder than failing.
  }
  if (!targets.length && !addons.length) throw new Error("That build has no minions in it — rows look like \"T4: Murloc Tidecaller; Murloc Tidehunter\"")

  const build: Omit<Build, 'id'> = { name, tribe, targets, addons }
  if (source) build.source = source
  return { build, missing }
}

/** Mirrors the renderer's labels, so what you read is what you'd see in the app. */
const TRIBE_LABELS: Record<string, string> = {
  BEAST: 'Beasts',
  DEMON: 'Demons',
  DRAGON: 'Dragons',
  ELEMENTAL: 'Elementals',
  MECHANICAL: 'Mechs',
  MURLOC: 'Murlocs',
  NAGA: 'Naga',
  PIRATE: 'Pirates',
  QUILBOAR: 'Quilboar',
  UNDEAD: 'Undead',
  ABERRATION: 'Aberrations',
}
const tribeLabel = (t: string) => TRIBE_LABELS[t] ?? t
