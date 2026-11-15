import { net } from 'electron'
import type { CardDb } from './cards/cardDb'
import { tribeFromWord } from './vision/tribeNames'
import type { Comp } from '../shared/types'

const COMPS_URL = 'https://hsreplay.net/battlegrounds/comps/'
/** Everything the page needs is server-rendered into this one script tag. */
const BLOB_RE = /<script[^>]*id="react_context"[^>]*>([\s\S]*?)<\/script>/

interface RawComp {
  comp_id: number
  comp_name: string
  comp_slug: string
  comp_tier: number
  comp_difficulty: number
  comp_summary: string
  comp_core_cards: number[]
  /** Detail pages only — the list page doesn't carry these. */
  comp_addon_cards?: number[]
  /** Detail pages only. One paragraph; card names as `[[Name||dbfId]]`. */
  comp_how_to_play?: string
}

/**
 * The published Battlegrounds comps, as starting points for a build.
 *
 * Two things make this less obvious than it looks. HSReplay has no public API
 * for the comps list, and Cloudflare answers 403 to anything that isn't a
 * browser — node:fetch is refused whatever headers you give it, because the
 * block is on the TLS fingerprint rather than the user agent. Electron's `net`
 * module goes through Chromium's network stack, so it gets a 200 where
 * node:fetch cannot. The page then server-renders everything into a JSON
 * script tag, so there's no DOM to scrape and no hidden window needed.
 *
 * Expect this to break when HSReplay restructures the page; it throws with
 * something readable so the UI can say so and offer the link instead.
 */
export async function fetchComps(cards: CardDb): Promise<Comp[]> {
  const res = await net.fetch(COMPS_URL)
  if (!res.ok) throw new Error(`HSReplay returned ${res.status}`)
  return parseCompsPage(await res.text(), (dbf) => cards.byDbfId(dbf)?.id)
}

export interface CompDetail {
  addons: string[]
  /** The How to Play paragraph, card links intact; '' if the comp has none. */
  howToPlay: string
}

/**
 * A single comp's page, which carries what the list page doesn't: addon cards
 * and the How to Play guide. Fetched only when someone actually uses a comp —
 * pulling all 33 up front would be 33 requests to serve a list most of which
 * never gets picked.
 */
export async function fetchCompDetail(url: string, cardIdOf: (dbfId: number) => string | undefined): Promise<CompDetail> {
  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`HSReplay returned ${res.status}`)
  return parseCompDetail(await res.text(), cardIdOf)
}

/** The parsing half of a comp page, so the contract can be tested. */
export function parseCompDetail(html: string, cardIdOf: (dbfId: number) => string | undefined): CompDetail {
  const blob = html.match(BLOB_RE)
  if (!blob) throw new Error('HSReplay has changed its page layout')
  const raw = JSON.parse(blob[1]) as RawComp
  return {
    // A comp with no addons or guide is normal, not a failure.
    addons: (raw.comp_addon_cards ?? []).map(cardIdOf).filter((id): id is string => !!id),
    // Kept verbatim: the [[Name||dbfId]] links are resolved at display time,
    // against whatever card data is loaded then.
    howToPlay: (raw.comp_how_to_play ?? '').trim(),
  }
}

/** The parsing half, separated so the page contract can be tested. */
export function parseCompsPage(html: string, cardIdOf: (dbfId: number) => string | undefined): Comp[] {
  const blob = html.match(BLOB_RE)
  if (!blob) throw new Error('HSReplay has changed its page layout')
  const raw = (JSON.parse(blob[1]) as { comps?: RawComp[] }).comps ?? []
  return raw.map((c) => ({
    id: c.comp_id,
    name: c.comp_name,
    // Names read "Quilboar - APM Shop Buff"; "Menagerie" has no tribe at all.
    tribe: tribeFromWord(c.comp_name.split('-')[0] ?? '') ?? '',
    summary: c.comp_summary,
    tier: c.comp_tier,
    difficulty: c.comp_difficulty,
    // A card we don't know about is dropped rather than faked.
    cardIds: c.comp_core_cards.map(cardIdOf).filter((id): id is string => !!id),
    url: `${COMPS_URL}${c.comp_id}/${c.comp_slug}`,
  }))
}
