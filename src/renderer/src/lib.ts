import { useEffect, useState } from 'react'
import type { BgMatch, BgSnapshot, CardInfo, GameMode, Settings } from '../../shared/types'

export const TRIBES: Record<string, { label: string; color: string }> = {
  BEAST: { label: 'Beasts', color: '#c98a3c' },
  DEMON: { label: 'Demons', color: '#9b5ad6' },
  DRAGON: { label: 'Dragons', color: '#e2523f' },
  ELEMENTAL: { label: 'Elementals', color: '#e7a03a' },
  MECHANICAL: { label: 'Mechs', color: '#7f93a8' },
  MURLOC: { label: 'Murlocs', color: '#3fb5a8' },
  NAGA: { label: 'Naga', color: '#4a8fe0' },
  PIRATE: { label: 'Pirates', color: '#d8b04a' },
  QUILBOAR: { label: 'Quilboar', color: '#d6608b' },
  UNDEAD: { label: 'Undead', color: '#8fc9a8' },
  ABERRATION: { label: 'Aberrations', color: '#b46be0' },
}

export function tribeLabel(t: string) {
  return TRIBES[t]?.label ?? t.charAt(0) + t.slice(1).toLowerCase()
}

/** Card art crop. Golden ids (…_G) share the normal card's art. */
export const artUrl = (cardId: string) => `https://art.hearthstonejson.com/v1/256x/${cardId.replace(/_G$/, '')}.jpg`
export const renderUrl = (cardId: string) => `https://art.hearthstonejson.com/v1/render/latest/enUS/256x/${cardId}.png`

export function pct(n: number | undefined, digits = 0) {
  if (n === undefined || Number.isNaN(n)) return '–'
  return `${(n * 100).toFixed(digits)}%`
}

export function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d ago` : new Date(ts).toLocaleDateString()
}

/** "Top half" finish: top 4 in solo (8 players), top 2 in duos (4 teams). */
export function isTopHalf(place: number, mode: GameMode) {
  return place > 0 && place <= (mode === 'duos' ? 2 : 4)
}

export function placeColor(place: number, mode: GameMode) {
  if (place === 1) return 'var(--gold)'
  return isTopHalf(place, mode) ? 'var(--win)' : 'var(--loss)'
}

export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

// ---------------------------------------------------------------- hooks

export function useSnapshot() {
  const [snap, setSnap] = useState<BgSnapshot>()
  useEffect(() => {
    void window.api.snapshot().then(setSnap)
    return window.api.onSnapshot(setSnap)
  }, [])
  return snap
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>()
  useEffect(() => {
    void window.api.settings().then(setSettings)
    return window.api.onSettingsChanged(setSettings)
  }, [])
  const update = async (patch: Partial<Settings>) => setSettings(await window.api.updateSettings(patch))
  return [settings, update] as const
}

export function useMatches() {
  const [matches, setMatches] = useState<BgMatch[]>([])
  useEffect(() => {
    const load = async () => setMatches(await window.api.matches())
    void load()
    return window.api.onDataChanged(load)
  }, [])
  return matches
}

let poolCache: Promise<CardInfo[]> | undefined
export function usePool() {
  const [pool, setPool] = useState<CardInfo[]>([])
  useEffect(() => {
    poolCache ??= window.api.pool()
    void poolCache.then((p) => {
      if (!p.length) poolCache = undefined
      setPool(p)
    })
  }, [])
  return pool
}

/** A gap this long between games starts a new session. */
const SESSION_GAP_MS = 2 * 60 * 60 * 1000

export interface Session {
  /** Oldest first. */
  games: BgMatch[]
  avg: number
  topRate: number
}

/** The most recent run of games without a long break. */
export function currentSession(matches: BgMatch[]): Session {
  const sorted = [...matches].sort((a, b) => a.endedAt - b.endedAt)
  let start = sorted.length
  for (let i = sorted.length - 1; i >= 0; i--) {
    const next = sorted[i + 1]
    if (next && next.startedAt - sorted[i].endedAt > SESSION_GAP_MS) break
    start = i
  }
  const games = sorted.slice(start)
  const s = placementStats(games)
  return { games, avg: s.avg, topRate: s.topRate }
}

export function placementStats(matches: BgMatch[]) {
  const n = matches.length
  const avg = n ? matches.reduce((s, m) => s + m.placement, 0) / n : 0
  const top = matches.filter((m) => isTopHalf(m.placement, m.mode)).length
  const firsts = matches.filter((m) => m.placement === 1).length
  return { games: n, avg, topRate: n ? top / n : 0, firsts }
}
