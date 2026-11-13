import { useEffect, useState } from 'react'
import type { BgMatch, BgSnapshot, BoardMinion, Build, CardInfo, GameMode, Settings } from '../../shared/types'

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

/** Builds, with local state kept in step so editing doesn't round-trip through disk. */
export function useBuilds() {
  const [builds, setBuilds] = useState<Build[]>([])
  useEffect(() => void window.api.builds().then(setBuilds), [])
  const save = (b: Build) => {
    setBuilds((cur) => (cur.some((x) => x.id === b.id) ? cur.map((x) => (x.id === b.id ? b : x)) : [...cur, b]))
    void window.api.saveBuild(b)
  }
  const remove = (id: string) => {
    setBuilds((cur) => cur.filter((b) => b.id !== id))
    void window.api.deleteBuild(id)
  }
  return [builds, save, remove] as const
}

/** Build stages, earliest turn first. The editor doesn't reorder while you type. */
export function sortedTargets(b: Build) {
  return [...b.targets].sort((x, y) => x.byTurn - y.byTurn)
}

/**
 * Where you are against a build on a given turn: the stage you're working
 * towards, and which of its minions you already have.
 *
 * The stage is the first one you haven't reached the deadline for; once every
 * deadline has passed you stay on the last one rather than running out of
 * advice. Golden copies count — a golden Tidecaller is still a Tidecaller, and
 * telling someone they're missing a minion they tripled would be absurd.
 */
export function buildProgress(build: Build, round: number, board: BoardMinion[]) {
  const stages = sortedTargets(build)
  const stage = stages.find((t) => t.byTurn >= round) ?? stages.at(-1)
  if (!stage) return undefined
  const owned = new Set(board.map((m) => baseCardId(m.cardId)))
  const minions = stage.cardIds.map((cardId) => ({ cardId, have: owned.has(baseCardId(cardId)) }))
  return {
    stage,
    minions,
    have: minions.filter((m) => m.have).length,
    turnsLeft: stage.byTurn - round,
    /** The last stage, i.e. there's nothing further to work towards. */
    final: stage === stages.at(-1),
  }
}

/** Golden minions carry a `_G` card id; they're the same minion for our purposes. */
const baseCardId = (id: string) => id.replace(/_G$/, '')

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
