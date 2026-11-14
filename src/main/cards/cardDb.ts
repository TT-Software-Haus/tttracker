import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { CardInfo } from '../../shared/types'

// Card data comes from HearthstoneJSON (https://hearthstonejson.com).
// We keep a slimmed copy cached on disk.
const CARDS_URL = 'https://api.hearthstonejson.com/v1/latest/enUS/cards.json'
export const CACHE_FILE = 'cards-v2.json'
const MAX_AGE_MS = 1000 * 60 * 60 * 24 // refresh daily

interface RawCard {
  id: string
  dbfId: number
  name?: string
  cost?: number
  rarity?: string
  cardClass?: string
  type?: string
  set?: string
  text?: string
  attack?: number
  health?: number
  techLevel?: number
  races?: string[]
  mechanics?: string[]
  isBattlegroundsPoolMinion?: boolean
  battlegroundsPremiumDbfId?: number
  battlegroundsHero?: boolean
  isBattlegroundsDuosExclusive?: boolean
  battlegroundsTimewarpCard?: boolean
}

export class CardDb {
  private byId = new Map<string, CardInfo>()
  private byDbf = new Map<number, CardInfo>()
  private bgByName = new Map<string, CardInfo[]>()
  private bgSpells = new Map<string, CardInfo>()

  get size() {
    return this.byId.size
  }

  get(cardId: string | undefined): CardInfo | undefined {
    return cardId ? this.byId.get(cardId) : undefined
  }

  byDbfId(dbfId: number): CardInfo | undefined {
    return this.byDbf.get(dbfId)
  }

  /** Battlegrounds minions (pool + tokens) by exact name. */
  bgMinionsNamed(name: string): CardInfo[] {
    return this.bgByName.get(name.toLowerCase()) ?? []
  }

  /** Battlegrounds tavern spell by exact name. */
  bgSpellNamed(name: string): CardInfo | undefined {
    return this.bgSpells.get(name.toLowerCase())
  }

  /** Every Battlegrounds minion, in or out of the current pool (tokens, rewards, rotated cards). */
  bgMinions(): CardInfo[] {
    return [...this.byId.values()].filter((c) => c.type === 'MINION' && c.set === 'BATTLEGROUNDS')
  }

  /**
   * Battlegrounds minions in a stable order, so a card can be shared as a
   * small index instead of a six-digit id. Sorted by dbfId, which Hearthstone
   * allocates upwards, so new cards land at the end and existing positions
   * hold. Golden copies are excluded — a build means the minion, not a triple.
   */
  private shareIndex?: CardInfo[]
  shareList(): CardInfo[] {
    return (this.shareIndex ??= this.bgMinions()
      .filter((c) => !c.normalId)
      .sort((a, b) => a.dbfId - b.dbfId))
  }

  shareIndexOf(cardId: string): number | undefined {
    const i = this.shareList().findIndex((c) => c.id === cardId)
    return i < 0 ? undefined : i
  }

  shareCardAt(index: number): string | undefined {
    return this.shareList()[index]?.id
  }

  pool(): CardInfo[] {
    return [...this.byId.values()].filter((c) => c.pool)
  }

  load(cards: CardInfo[]) {
    this.shareIndex = undefined
    this.byId.clear()
    this.byDbf.clear()
    this.bgByName.clear()
    this.bgSpells.clear()
    for (const c of cards) {
      if (c.type === 'BATTLEGROUND_SPELL' && !this.bgSpells.has(c.name.toLowerCase())) this.bgSpells.set(c.name.toLowerCase(), c)
      this.byId.set(c.id, c)
      this.byDbf.set(c.dbfId, c)
      if (c.type === 'MINION' && c.set === 'BATTLEGROUNDS') {
        const k = c.name.toLowerCase()
        const list = this.bgByName.get(k) ?? []
        list.push(c)
        this.bgByName.set(k, list)
      }
    }
  }

  /** Load from cache, downloading a fresh copy if missing or stale. */
  async init(cacheDir: string): Promise<void> {
    const file = join(cacheDir, CACHE_FILE)
    let cached: CardInfo[] | undefined
    let stale = true
    try {
      const stat = await fs.stat(file)
      cached = JSON.parse(await fs.readFile(file, 'utf8'))
      stale = Date.now() - stat.mtimeMs > MAX_AGE_MS
    } catch {
      /* no cache yet */
    }
    if (cached) this.load(cached)
    if (!stale) return
    try {
      const fresh = slim(await download())
      this.load(fresh)
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.writeFile(file, JSON.stringify(fresh))
    } catch (err) {
      if (!cached) throw err
      console.warn('Card DB refresh failed, using cache:', err)
    }
  }
}

async function download(): Promise<RawCard[]> {
  const res = await fetch(CARDS_URL, { headers: { 'User-Agent': 'hearth-tracker' } })
  if (!res.ok) throw new Error(`HearthstoneJSON returned ${res.status}`)
  return (await res.json()) as RawCard[]
}

/** Keep only what we use. Exported for tests. */
export function slim(raw: RawCard[]): CardInfo[] {
  const byDbf = new Map(raw.map((c) => [c.dbfId, c]))
  const normalOf = new Map<string, string>()
  for (const c of raw) {
    if (c.battlegroundsPremiumDbfId) {
      const g = byDbf.get(c.battlegroundsPremiumDbfId)
      if (g) normalOf.set(g.id, c.id)
    }
  }
  return raw
    .filter((c) => c.name)
    .map((c) => {
      const out: CardInfo = { id: c.id, dbfId: c.dbfId, name: c.name!, cost: c.cost ?? 0 }
      if (c.rarity) out.rarity = c.rarity
      if (c.cardClass) out.cardClass = c.cardClass
      if (c.type) out.type = c.type
      if (c.set) out.set = c.set
      if (c.set === 'BATTLEGROUNDS' || c.isBattlegroundsPoolMinion || c.techLevel || c.type === 'BATTLEGROUND_SPELL') {
        // Battlegrounds-only details – keeps the cache small.
        if (c.text) out.text = c.text
        if (c.attack !== undefined) out.attack = c.attack
        if (c.health !== undefined) out.health = c.health
        if (c.techLevel) out.techLevel = c.techLevel
        if (c.races?.length) out.races = c.races
        if (c.mechanics?.length) out.mechanics = c.mechanics
        if (c.isBattlegroundsPoolMinion) out.pool = true
        if (c.battlegroundsHero) out.bgHero = true
        if (c.isBattlegroundsDuosExclusive) out.duosOnly = true
        if (c.battlegroundsTimewarpCard) out.timewarp = true
        const g = c.battlegroundsPremiumDbfId ? byDbf.get(c.battlegroundsPremiumDbfId) : undefined
        if (g) out.goldenId = g.id
        const n = normalOf.get(c.id)
        if (n) out.normalId = n
      }
      return out
    })
}
