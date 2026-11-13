import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BoardMinion, CombatResult, LobbyPlayer, SimOdds } from '../../shared/types'
import { reducedMotion, useAnimatedNumber, useChange, useFlip } from './anim'
import { TRIBES, artUrl, cardTextParts, ordinal, pct, placeColor, tribeLabel, type Session } from './lib'

/** Card text with Hearthstone's own keyword emphasis kept. */
export function CardText({ text }: { text?: string }) {
  const parts = cardTextParts(text)
  if (!parts.length) return null
  return (
    <>
      {parts.map((p, i) => {
        const body = p.italic ? <i>{p.text}</i> : p.text
        return p.bold ? <b key={i}>{body}</b> : <span key={i}>{body}</span>
      })}
    </>
  )
}

/** A minion as a small card: art, tier pip, attack/health gems, keyword effects. */
export function MinionCard({ m, size = 'md' }: { m: BoardMinion; size?: 'sm' | 'md' | 'lg' }) {
  const cls = [
    'minion',
    `minion-${size}`,
    m.golden && 'minion-golden',
    m.taunt && 'minion-taunt',
    m.divineShield && 'minion-shield',
    m.stealth && 'minion-stealth',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cls} title={`${m.name}  ${m.atk}/${m.health}${m.golden ? ' (golden)' : ''}`}>
      <div className="minion-art" style={{ backgroundImage: `url(${artUrl(m.cardId)})` }} />
      <div className="minion-tier">{m.tier}</div>
      <div className="minion-kw">
        {m.reborn && <span title="Reborn">✚</span>}
        {m.venomous && <span title="Venomous">☠</span>}
        {m.windfury && <span title="Windfury">≋</span>}
      </div>
      <div className="minion-atk">{m.atk}</div>
      <div className="minion-hp">{m.health}</div>
    </div>
  )
}

export function Board({ minions, size, empty = 'Empty board' }: { minions: BoardMinion[]; size?: 'sm' | 'md' | 'lg'; empty?: ReactNode }) {
  if (!minions.length) return <div className="board board-empty">{empty}</div>
  return (
    <div className={`board board-${size ?? 'md'}`}>
      {minions.map((m, i) => (
        <MinionCard key={i} m={m} size={size} />
      ))}
    </div>
  )
}

export function HeroPortrait({ cardId, size = 40, dead }: { cardId?: string; size?: number; dead?: boolean }) {
  return (
    <div
      className={`hero-portrait ${dead ? 'hero-dead' : ''}`}
      style={{ width: size, height: size, backgroundImage: cardId ? `url(${artUrl(cardId)})` : undefined }}
    />
  )
}

function AnimatedPct({ value }: { value: number }) {
  const v = useAnimatedNumber(value * 100)
  return <b>{Math.round(v)}%</b>
}

/**
 * The headline: win / tie / loss as one segmented bar with numbers.
 * `fightKey` identifies the fight, so a change within a fight (a teammate's
 * warband coming in) shows a ▲/▼ chip, but a new fight doesn't.
 */
/**
 * Win/tie/loss segments as transforms rather than widths. Each one is laid over
 * the whole bar and then slid and squashed into place, so the 0.8s glide to new
 * odds is composited instead of relaying out the bar three times a frame.
 * Values are percentages and must sum to 100.
 */
export function segments([win, tie, loss]: number[]) {
  const classes = ['seg-win', 'seg-tie', 'seg-loss']
  let offset = 0
  return [win, tie, loss].map((size, i) => {
    const style = { transform: `translateX(${offset}%) scaleX(${size / 100})` }
    offset += size
    return { cls: classes[i], style }
  })
}

export function OddsBar({ odds, compact, fightKey }: { odds: SimOdds; compact?: boolean; fightKey?: unknown }) {
  const w = odds.win * 100
  const t = odds.tie * 100
  const l = odds.loss * 100
  const change = useChange(Math.round(w), fightKey)
  // Grow the bar from empty when it first appears.
  const [shown, setShown] = useState(reducedMotion())
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return (
    <div className={`odds ${compact ? 'odds-compact' : ''}`}>
      <div className="odds-nums">
        <div className="odds-num odds-win">
          <AnimatedPct value={odds.win} />
          <span>win</span>
          {change.key > 0 && Math.abs(change.delta) >= 2 && (
            <i key={change.key} className={`odds-delta ${change.delta > 0 ? 'up' : 'down'}`}>
              {change.delta > 0 ? '▲' : '▼'} {Math.abs(change.delta)}%
            </i>
          )}
        </div>
        <div className="odds-num odds-tie">
          <AnimatedPct value={odds.tie} />
          <span>tie</span>
        </div>
        <div className="odds-num odds-loss">
          <AnimatedPct value={odds.loss} />
          <span>loss</span>
        </div>
      </div>
      <div className="odds-bar">
        {segments(shown ? [w, t, l] : [0, 0, 0]).map((s) => (
          <div key={s.cls} className={`seg ${s.cls}`} style={s.style} />
        ))}
      </div>
      <div className="odds-meta">
        {odds.win > 0 && <span>Deal ~{odds.avgDamageDealt.toFixed(1)}</span>}
        {odds.loss > 0 && <span>Take ~{odds.avgDamageTaken.toFixed(1)}</span>}
        {odds.lethalLoss > 0.005 && <span className="danger pulse">☠ {pct(odds.lethalLoss)} lethal</span>}
        {odds.lethalWin > 0.005 && <span className="good">⚔ {pct(odds.lethalWin)} kills them</span>}
      </div>
      {odds.partial && <div className="odds-warn">Only the boards fighting now: a teammate’s warband wasn’t visible yet.</div>}
      {odds.unsupported.length > 0 && <div className="odds-warn">Not modelled: {odds.unsupported.join(', ')}</div>}
    </div>
  )
}

export function ResultBadge({ result, damage }: { result?: CombatResult; damage?: number }) {
  if (!result) return null
  const label = result === 'WON' ? 'Won' : result === 'LOST' ? 'Lost' : 'Tied'
  return (
    <span className={`result-badge rb-${result.toLowerCase()} rb-pop`}>
      {label}
      {damage ? ` · ${damage} dmg` : ''}
    </span>
  )
}

/** Remembers a value across renders and reports drops, e.g. a hero losing health. */
function useDrop(value: number) {
  const prev = useRef(value)
  const [drop, setDrop] = useState<{ n: number; key: number }>({ n: 0, key: 0 })
  useEffect(() => {
    if (value < prev.current) setDrop((d) => ({ n: prev.current - value, key: d.key + 1 }))
    prev.current = value
  }, [value])
  return drop
}

/** The lobby list. Rows slide into place when the leaderboard order changes. */
export function LobbyList({ players, mode, expandedId, onToggle, onHover }: { players: LobbyPlayer[]; mode?: 'solo' | 'duos'; expandedId?: number; onToggle?: (id: number) => void; onHover?: (id: number | undefined) => void }) {
  const ref = useFlip<HTMLDivElement>(players.map((p) => p.playerId).join(','))
  return (
    <div className="lobby" ref={ref} onMouseLeave={() => onHover?.(undefined)}>
      {players.map((p) => (
        <div key={p.playerId} data-flip-id={p.playerId} onMouseEnter={() => onHover?.(p.playerId)}>
          <LobbyRow p={p} mode={mode} expanded={expandedId === p.playerId} onToggle={onToggle ? () => onToggle(p.playerId) : undefined} />
        </div>
      ))}
    </div>
  )
}

export function LobbyRow({ p, expanded, onToggle, mode }: { p: LobbyPlayer; expanded?: boolean; onToggle?: () => void; mode?: 'solo' | 'duos' }) {
  const cls = ['lobby-row', p.isMe && 'lobby-me', p.isTeammate && 'lobby-mate', p.isNextOpponent && 'lobby-next', p.dead && 'lobby-dead'].filter(Boolean).join(' ')
  const hit = useDrop(p.health + p.armor)
  return (
    <div className={cls}>
      <div className="lobby-main" onClick={onToggle}>
        <div className="lobby-place">{p.place || '–'}</div>
        <HeroPortrait cardId={p.heroCardId} size={34} dead={p.dead} />
        <div className="lobby-text">
          <div className="lobby-name">
            {p.heroName}
            {p.isMe && <span className="tag tag-me">you</span>}
            {p.isTeammate && <span className="tag tag-mate">mate</span>}
            {p.isNextOpponent && <span className="tag tag-next">next</span>}
          </div>
          <div className="lobby-sub">
            <span className="tier-pip" title="Tavern tier">
              ★{p.tier}
            </span>
            {p.triples > 0 && <span title="Triples">◆{p.triples}</span>}
            {p.lastResult && <span className={`lr lr-${p.lastResult.toLowerCase()}`}>{p.lastResult === 'WON' ? 'beat them' : p.lastResult === 'LOST' ? 'lost to' : 'tied'}</span>}
            {mode === 'duos' && p.team !== undefined && <span className="muted">team {p.team}</span>}
          </div>
        </div>
        <div className={`lobby-hp ${hit.key ? 'lobby-hp-hit' : ''}`} key={`hp-${hit.key}`}>
          <b>{p.health}</b>
          {p.armor > 0 && <span className="armor">+{p.armor}</span>}
          {hit.key > 0 && <i className="dmg-float">-{hit.n}</i>}
        </div>
      </div>
      {expanded && (
        <div className="lobby-board">
          {p.lastBoard ? (
            <>
              <div className="muted small">Board seen in round {p.lastBoard.round}</div>
              <Board minions={p.lastBoard.minions} size="sm" />
            </>
          ) : (
            <div className="muted small">Haven’t fought them yet.</div>
          )}
        </div>
      )}
    </div>
  )
}

export function TribeChips({ tribes, all }: { tribes: string[]; all?: boolean }) {
  const list = all ? Object.keys(TRIBES) : tribes
  if (!list.length) return <span className="muted small">No tribes seen yet</span>
  return (
    <div className="tribes">
      {list.map((t) => (
        <span key={t} className={`tribe ${all && !tribes.includes(t) ? 'tribe-off' : ''}`} style={{ ['--tc' as string]: TRIBES[t]?.color ?? '#888' }}>
          {tribeLabel(t)}
        </span>
      ))}
    </div>
  )
}

/** Compact session summary: placement chips and average placement. */
export function SessionStrip({ s, compact }: { s: Session; compact?: boolean }) {
  if (!s.games.length) return <div className="session session-empty muted small">No games this session yet</div>
  return (
    <div className={`session ${compact ? 'session-compact' : ''}`}>
      <div className="session-places">
        {s.games.map((m) => (
          <span key={m.id} className="session-place" style={{ ['--pc' as string]: placeColor(m.placement, m.mode) }} title={`${m.heroName} · ${ordinal(m.placement)}`}>
            {m.placement || '?'}
          </span>
        ))}
      </div>
      <div className="session-meta">
        <span>
          avg <b>{s.avg.toFixed(1)}</b>
        </span>
        <span>
          <b>{Math.round(s.topRate * 100)}%</b> top half
        </span>
      </div>
    </div>
  )
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'win' | 'loss' | 'accent' }) {
  return <span className={`pill pill-${tone}`}>{children}</span>
}
