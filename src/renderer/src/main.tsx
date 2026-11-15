import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import './styles.css'
import type { BgMatch, BgSnapshot, Build, BuildTarget, CardInfo, Comp, SetupStatus } from '../../shared/types'
import { Board, CardText, HeroPortrait, LobbyList, OddsBar, Pill, ResultBadge, SessionStrip, Stat, TribeChips, segments } from './components'
import { TRIBES, artUrl, buildsByLobby, cardTextPlain, currentSession, isTopHalf, ordinal, pct, placeColor, placementStats, sortedTargets, timeAgo, tribeLabel, useBuilds, useMatches, usePool, useSettings, useSnapshot } from './lib'

type Page = 'live' | 'minions' | 'builds' | 'history' | 'stats' | 'settings'

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'live', label: 'Live game', icon: '◉' },
  { id: 'minions', label: 'Minions', icon: '❖' },
  { id: 'builds', label: 'Builds', icon: '▣' },
  { id: 'history', label: 'History', icon: '↺' },
  { id: 'stats', label: 'Stats', icon: '◔' },
  { id: 'settings', label: 'Setup', icon: '⚙' },
]

function App() {
  const [page, setPage] = useState<Page>('live')
  const snap = useSnapshot()
  const matches = useMatches()

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">
          <span className="brand-mark">◆</span> Hearth Tracker <span className="brand-sub">Battlegrounds</span>
        </span>
        <StatusChip snap={snap} />
      </div>
      <nav className="sidebar">
        {NAV.map((n) => (
          <button key={n.id} className={`nav ${page === n.id ? 'nav-active' : ''}`} onClick={() => setPage(n.id)}>
            <span className="nav-icon">{n.icon}</span>
            {n.label}
            {n.id === 'settings' && snap?.status === 'setup-needed' && <span className="nav-badge">!</span>}
          </button>
        ))}
        <div className="sidebar-foot">
          <Recent matches={matches} />
        </div>
      </nav>
      <main className="content">
        {snap?.status === 'setup-needed' && page !== 'settings' && (
          <div className="banner" onClick={() => setPage('settings')}>
            <b>One-time setup needed.</b> Hearthstone needs logging switched on before it can be tracked. <u>Fix it in Setup →</u>
          </div>
        )}
        {page === 'live' && <LivePage snap={snap} matches={matches} />}
        {page === 'minions' && <MinionsPage tribes={snap?.tribes ?? []} />}
        {page === 'builds' && <BuildsPage />}
        {page === 'history' && <HistoryPage matches={matches} />}
        {page === 'stats' && <StatsPage matches={matches} />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}

function StatusChip({ snap }: { snap?: BgSnapshot }) {
  if (!snap) return null
  const map: Record<BgSnapshot['status'], [string, string]> = {
    'setup-needed': ['Setup needed', 'warn'],
    'waiting-for-logs': ['Waiting for a game', 'idle'],
    idle: ['Ready', 'ok'],
    'not-battlegrounds': ['Not a Battlegrounds game', 'idle'],
    'in-game': [`Turn ${Math.max(1, snap.round)} · ${snap.phase === 'combat' ? 'combat' : 'shopping'}`, 'live'],
    'game-over': ['Game over', 'ok'],
  }
  const [label, tone] = map[snap.status]
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" />
      {label}
    </span>
  )
}

function Recent({ matches }: { matches: BgMatch[] }) {
  const s = currentSession(matches)
  return (
    <div className="quick">
      <div className="quick-label">This session · {s.games.length} game{s.games.length === 1 ? '' : 's'}</div>
      <div className="quick-value">{s.games.length ? s.avg.toFixed(2) : '–'}</div>
      <div className="quick-label">avg placement</div>
      <div className="quick-places">
        {s.games.map((m) => (
          <span key={m.id} style={{ color: placeColor(m.placement, m.mode) }}>
            {m.placement}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Session panel: placements this session and the average. */
function SessionPanel({ matches }: { matches: BgMatch[] }) {
  return (
    <section className="panel">
      <div className="panel-title">This session</div>
      <SessionStrip s={currentSession(matches)} />
    </section>
  )
}

// ======================================================================= LIVE

function LivePage({ snap, matches }: { snap?: BgSnapshot; matches: BgMatch[] }) {
  const [openRow, setOpenRow] = useState<number>()
  if (!snap) return null
  const inGame = snap.status === 'in-game' || snap.status === 'game-over'
  if (!inGame) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Live</h1>
        </header>
        <div className="empty-hero">
          <div className="empty-icon">⚔</div>
          <div className="empty-title">{snap.statusDetail ?? 'Waiting for a Battlegrounds game'}</div>
          <div className="muted">Combat odds, the lobby and opponents’ boards show up here and in the overlay as soon as you queue.</div>
        </div>
        <div className="session-wrap">
          <SessionPanel matches={matches} />
        </div>
      </div>
    )
  }
  const c = snap.combat
  const me = snap.me
  return (
    <div className="page">
      <header className="page-head">
        <h1>Turn {Math.max(1, snap.round)}</h1>
        <div className="page-sub">
          {snap.mode === 'duos' ? 'Duos' : 'Solo'} · {snap.phase === 'combat' ? 'Combat' : snap.phase === 'over' ? 'Game over' : 'Shopping'}
          {snap.placement ? <Pill tone={isTopHalf(snap.placement, snap.mode ?? 'solo') ? 'win' : 'loss'}>Finished {ordinal(snap.placement)}</Pill> : null}
        </div>
        {me && (
          <div className="me-chip">
            <HeroPortrait cardId={me.heroCardId} size={30} />
            <div>
              <b>{me.heroName}</b>
              <div className="muted small">
                ★{me.tier} · {me.health}
                {me.armor ? ` +${me.armor}` : ''} health
              </div>
            </div>
          </div>
        )}
      </header>

      <BuildBar snap={snap} />

      <div className="live-grid">
        <section className="panel combat-panel">
          <div className="panel-title">
            {c ? (
              <>
                {snap.phase === 'combat' && c.round === snap.round ? 'Fighting' : `Last fight · turn ${c.round}`}
                <HeroPortrait cardId={c.opponentHeroCardId} size={22} />
                <span>{c.opponentHeroName ?? 'Opponent'}</span>
                <ResultBadge result={c.result} damage={c.damage} />
              </>
            ) : (
              'No fights yet'
            )}
          </div>
          {c?.odds ? <OddsBar key={`fight-${c.round}`} odds={c.liveOdds ?? c.odds} fightKey={c.round} /> : <div className="muted">Odds appear when the first combat starts.</div>}
          {c && (
            <div className="vs">
              <div>
                <div className="panel-label">Their board</div>
                <Board minions={c.oppBoard} size="lg" />
              </div>
              {c.oppReserve && (
                <div>
                  <div className="panel-label reserve-label">
                    <HeroPortrait cardId={c.oppReserveHeroCardId} size={18} /> Their teammate comes in next
                  </div>
                  <Board minions={c.oppReserve} size="md" />
                </div>
              )}
              <div>
                <div className="panel-label">Your board</div>
                <Board minions={c.myBoard} size="lg" />
              </div>
              {c.myReserve && (
                <div>
                  <div className="panel-label reserve-label">
                    <HeroPortrait cardId={c.myReserveHeroCardId} size={18} /> Then your team’s other warband
                  </div>
                  <Board minions={c.myReserve} size="md" />
                </div>
              )}
            </div>
          )}
          {snap.phase !== 'combat' && snap.board.length > 0 && (
            <>
              <div className="panel-label">Your warband now</div>
              <Board minions={snap.board} size="md" />
            </>
          )}
        </section>

        <section className="panel">
          <div className="panel-title">Lobby</div>
          <TribeChips tribes={snap.tribes} />
          <LobbyList players={snap.lobby} mode={snap.mode} expandedId={openRow} onToggle={(id) => setOpenRow(openRow === id ? undefined : id)} />
        </section>
      </div>

      {snap.rounds.length > 0 && (
        <section className="panel">
          <div className="panel-title">This game’s fights</div>
          <RoundsTable rounds={snap.rounds} />
        </section>
      )}
      <SessionPanel matches={matches} />
    </div>
  )
}

/**
 * Pick or change the build mid-game. The prompt only fires once, right after
 * the hero is locked in, so without this a dismissal — or the tracker being
 * restarted mid-game — leaves no way back to a build for the rest of it.
 */
function BuildBar({ snap }: { snap: BgSnapshot }) {
  const [builds] = useBuilds()
  const current = snap.selectedBuild
  const [relevant, rest] = buildsByLobby(builds, snap.tribes)
  if (!builds.length) return null
  return (
    <div className="build-bar">
      <span className="muted small">Going for</span>
      <select className="input" value={current?.id ?? ''} onChange={(e) => void window.api.selectBuild(e.target.value || null)}>
        <option value="">No build this game</option>
        {relevant.length > 0 && (
          <optgroup label="In this lobby">
            {relevant.map((b) => (
              <option key={b.id} value={b.id}>
                {b.tribe ? `${tribeLabel(b.tribe)} · ` : ''}
                {b.name}
              </option>
            ))}
          </optgroup>
        )}
        {rest.length > 0 && (
          <optgroup label="Other tribes">
            {rest.map((b) => (
              <option key={b.id} value={b.id}>
                {tribeLabel(b.tribe)} · {b.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {current && <span className="muted small">shown in the sidebar overlay and over the tavern</span>}
    </div>
  )
}

function RoundsTable({ rounds }: { rounds: BgSnapshot['rounds'] }) {
  return (
    <div className="rounds">
      {[...rounds].reverse().map((r) => (
        <div key={r.round} className="round-row">
          <span className="muted">T{r.round}</span>
          <HeroPortrait cardId={r.opponentHeroCardId} size={24} />
          <span className="round-opp">{r.opponentHeroName ?? '?'}</span>
          {r.odds ? (
            <div className="mini-odds" title={`Win ${pct(r.odds.win)} · Tie ${pct(r.odds.tie)} · Loss ${pct(r.odds.loss)}`}>
              {segments([r.odds.win * 100, r.odds.tie * 100, r.odds.loss * 100]).map((s) => (
                <div key={s.cls} className={`seg ${s.cls}`} style={s.style} />
              ))}
            </div>
          ) : (
            <span />
          )}
          <span className="muted">{r.odds ? `${pct(r.odds.win)} win` : ''}</span>
          <ResultBadge result={r.result} damage={r.damage} />
        </div>
      ))}
    </div>
  )
}

// =================================================================== MINIONS

function MinionsPage({ tribes }: { tribes: string[] }) {
  const pool = usePool()
  const [filter, setFilter] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [onlyLobby, setOnlyLobby] = useState(true)
  const lobbyKnown = tribes.length > 0
  const active = filter.length ? filter : onlyLobby && lobbyKnown ? tribes : []
  const list = useMemo(
    () =>
      pool
        .filter((c) => !active.length || !c.races?.length || c.races.includes('ALL') || c.races.some((r) => active.includes(r)))
        .filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase()) || cardTextPlain(c.text).toLowerCase().includes(query.toLowerCase())),
    [pool, active.join(), query],
  )
  const tiers = [1, 2, 3, 4, 5, 6, 7]
  return (
    <div className="page">
      <header className="page-head">
        <h1>Minions</h1>
        <input className="input search" placeholder="Search name or text…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>
      <div className="filter-row">
        {Object.keys(TRIBES).map((t) => {
          const on = active.includes(t)
          return (
            <button
              key={t}
              className={`tribe tribe-btn ${on ? '' : 'tribe-off'}`}
              style={{ ['--tc' as string]: TRIBES[t].color }}
              onClick={() => setFilter(filter.includes(t) ? filter.filter((x) => x !== t) : [...filter, t])}
            >
              {tribeLabel(t)}
            </button>
          )
        })}
        {lobbyKnown && (
          <label className="check">
            <input type="checkbox" checked={onlyLobby} onChange={(e) => setOnlyLobby(e.target.checked)} /> Only this lobby’s tribes
          </label>
        )}
        {filter.length > 0 && (
          <button className="btn" onClick={() => setFilter([])}>
            Clear
          </button>
        )}
      </div>
      {!pool.length && <div className="muted">Loading card data…</div>}
      {tiers.map((tier) => {
        const cards = list.filter((c) => c.techLevel === tier).sort((a, b) => a.name.localeCompare(b.name))
        if (!cards.length) return null
        return (
          <section key={tier} className="tier-section">
            <div className="tier-head">
              <span className="tier-star">★{tier}</span> Tier {tier} <span className="muted">· {cards.length}</span>
            </div>
            <div className="minion-grid">
              {cards.map((c) => (
                <PoolCard key={c.id} c={c} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function PoolCard({ c }: { c: CardInfo }) {
  return (
    <div className="pool-card">
      <div className="pool-art" style={{ backgroundImage: `url(${artUrl(c.id)})` }}>
        <span className="pool-stats">
          <b className="atk">{c.attack}</b>
          <b className="hp">{c.health}</b>
        </span>
      </div>
      <div className="pool-body">
        <div className="pool-name">{c.name}</div>
        <div className="pool-tribes">{(c.races ?? []).map((r) => (r === 'ALL' ? 'All' : tribeLabel(r))).join(' · ') || 'Neutral'}</div>
        <div className="pool-text">
          <CardText text={c.text} />
        </div>
      </div>
    </div>
  )
}

// ==================================================================== BUILDS

function BuildsPage() {
  const [builds, save, remove] = useBuilds()
  const [open, setOpen] = useState<string>()
  const [finding, setFinding] = useState(false)
  const [importing, setImporting] = useState(false)
  const create = () => {
    const b: Build = { id: crypto.randomUUID(), name: 'New build', tribe: 'MURLOC', targets: [{ byTurn: 6, cardIds: [] }] }
    save(b)
    setOpen(b.id)
  }
  const useComp = async (c: Comp) => {
    // Addons and the How to Play guide live on the comp's own page, so they
    // cost one extra request at the moment of picking. A failure there still
    // gives a usable build.
    const detail = await window.api.compDetail(c.url).catch(() => ({ addons: [], howToPlay: '' }))
    const b: Build = {
      id: crypto.randomUUID(),
      name: c.name,
      tribe: c.tribe,
      // The comp pages carry no turn guidance — "when to commit" is prose —
      // so the turn is a starting point you're meant to change.
      targets: [{ byTurn: 8, cardIds: c.cardIds }],
      addons: detail.addons,
      description: detail.howToPlay || undefined,
      source: { name: 'HSReplay · JeefHS', url: c.url },
    }
    save(b)
    setFinding(false)
    setOpen(b.id)
  }
  return (
    <div className="page">
      <header className="page-head">
        <h1>Builds</h1>
        <button className="btn" onClick={() => setFinding(!finding)}>
          {finding ? 'Close' : 'Find build'}
        </button>
        <button className="btn" onClick={() => setImporting(!importing)}>
          {importing ? 'Close' : 'Import'}
        </button>
        <button className="btn btn-primary" onClick={create}>
          New build
        </button>
      </header>
      {finding && <FindBuild onUse={useComp} />}
      {importing && (
        <ImportBuild
          onImport={(b) => {
            const made: Build = { ...b, id: crypto.randomUUID() }
            save(made)
            setImporting(false)
            setOpen(made.id)
          }}
        />
      )}
      {!builds.length && (
        <div className="empty-hero">
          <div className="empty-icon">▣</div>
          <div className="empty-title">No builds yet</div>
          <div className="muted">Plan a warband for a tribe — which minions you want, and the turn you want them by. When a lobby has that tribe, the tracker offers the build after you pick a hero.</div>
        </div>
      )}
      {builds.map((b) => (
        <div key={b.id} className="card-box">
          <button className="build-head" onClick={() => setOpen(open === b.id ? undefined : b.id)}>
            <span className="tribe" style={{ ['--tc' as string]: TRIBES[b.tribe]?.color ?? 'var(--accent)' }}>
              {tribeLabel(b.tribe)}
            </span>
            <b>{b.name}</b>
            <span className="muted small">
              {b.targets.length} stage{b.targets.length === 1 ? '' : 's'} · {sortedTargets(b).at(-1)?.byTurn ?? 0} turns
            </span>
            <span className="muted">{open === b.id ? '▾' : '▸'}</span>
          </button>
          {open === b.id && <BuildEditor build={b} save={save} remove={remove} />}
        </div>
      ))}
    </div>
  )
}

/** Paste a code from someone else. */
function ImportBuild({ onImport }: { onImport: (b: Omit<Build, 'id'>) => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string>()
  const go = async () => {
    try {
      const { build, missing } = await window.api.importBuild(code)
      // A missing card means the sender's card data has something ours doesn't.
      // The code can't name it — that's the cost of it being short.
      if (missing) alert(['Imported, but ' + missing + ' card' + (missing === 1 ? '' : 's') + ' in it are not in your card data, so they were left out.'].join(''))
      onImport(build)
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }
  return (
    <div className="card-box find-build">
      <div className="box-title">Import a build</div>
      <div className="build-share">
        <input
          className="input input-code"
          autoFocus
          placeholder="Paste a build code (starts with HTB)…"
          value={code}
          onChange={(e) => {
            setCode(e.target.value)
            setError(undefined)
          }}
          onKeyDown={(e) => e.key === 'Enter' && code.trim() && void go()}
        />
        <button className="btn btn-primary" disabled={!code.trim()} onClick={() => void go()}>
          Import
        </button>
      </div>
      {error && <div className="muted small">{error}</div>}
    </div>
  )
}

const TIER_LABEL: Record<number, string> = { 1: 'S', 2: 'A', 3: 'B', 4: 'C', 5: 'D' }

/** The published comps, as starting points. Not ours — credited and linked. */
function FindBuild({ onUse }: { onUse: (c: Comp) => Promise<void> }) {
  const [comps, setComps] = useState<Comp[]>()
  const [error, setError] = useState<string>()
  // Using a comp fetches its page for the addon cards, so the row says so.
  const [busy, setBusy] = useState<number>()
  useEffect(() => {
    window.api
      .comps()
      .then(setComps)
      .catch((e: Error) => setError(e.message))
  }, [])
  return (
    <div className="card-box find-build">
      <div className="box-title">
        Battlegrounds comps
        <a className="find-src" href="#" onClick={() => void window.api.openExternal('https://hsreplay.net/battlegrounds/comps/')}>
          from HSReplay, tiered by JeefHS →
        </a>
      </div>
      {error && <div className="muted">Couldn’t reach HSReplay ({error}). Open the link above to read the list instead.</div>}
      {!comps && !error && <div className="muted">Loading comps…</div>}
      {comps?.map((c) => (
        <div key={c.id} className="comp-row">
          <span className={`comp-tier comp-tier-${c.tier}`}>{TIER_LABEL[c.tier] ?? c.tier}</span>
          <div className="comp-main">
            <b>{c.name}</b>
            <div className="muted small">{c.summary}</div>
          </div>
          <div className="comp-cards">
            {c.cardIds.map((id) => (
              <span key={id} className="comp-card" style={{ backgroundImage: `url(${artUrl(id)})` }} />
            ))}
          </div>
          <a className="muted small" href="#" onClick={() => void window.api.openExternal(c.url)}>
            Guide
          </a>
          <button
            className="btn btn-sm"
            disabled={busy !== undefined}
            onClick={async () => {
              setBusy(c.id)
              try {
                await onUse(c)
              } finally {
                setBusy(undefined)
              }
            }}
          >
            {busy === c.id ? 'Adding…' : 'Use'}
          </button>
        </div>
      ))}
    </div>
  )
}

/** Shared by the stage rows and the addons row. */
function Picker({ build, pool, query, setQuery, onPick }: { build: Build; pool: CardInfo[]; query: string; setQuery: (q: string) => void; onPick: (c: CardInfo) => void }) {
  // Starts on the build's own tribe, but a build is rarely one tribe all the
  // way up — you tech in a Brann or a Baron — so the tribe is switchable here
  // without touching what the build is *for*.
  const [tribe, setTribe] = useState(build.tribe)
  const [hovered, setHovered] = useState<CardInfo>()

  const candidates = useMemo(
    () =>
      pool
        .filter((c) => !tribe || !c.races?.length || c.races.includes('ALL') || c.races.includes(tribe))
        .filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase()) || cardTextPlain(c.text).toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [pool, tribe, query],
  )
  // Grouped by tier and uncapped: the old 48-card limit quietly stopped at
  // tier 2, so two thirds of the pool — every tier 7 — could not be picked.
  const tiers = [1, 2, 3, 4, 5, 6, 7].map((t) => [t, candidates.filter((c) => c.techLevel === t)] as const).filter(([, cs]) => cs.length)

  return (
    <div className="build-picker">
      <div className="picker-head">
        <input className="input search" autoFocus placeholder="Search name or text…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="muted small">{candidates.length} minions</span>
      </div>
      <div className="picker-tribes">
        <button className={`tribe tribe-btn ${tribe ? 'tribe-off' : ''}`} onClick={() => setTribe('')}>
          All
        </button>
        {Object.keys(TRIBES).map((t) => (
          <button key={t} className={`tribe tribe-btn ${tribe === t ? '' : 'tribe-off'}`} style={{ ['--tc' as string]: TRIBES[t].color }} onClick={() => setTribe(t)}>
            {tribeLabel(t)}
          </button>
        ))}
      </div>
      <div className="picker-preview">
        {hovered ? (
          <>
            <b>{hovered.name}</b>
            <span className="muted small">
              ★{hovered.techLevel} · {hovered.attack}/{hovered.health}
              {hovered.races?.length ? ` · ${hovered.races.map((r) => (r === 'ALL' ? 'All' : tribeLabel(r))).join(', ')}` : ''}
            </span>
            <span className="small">{hovered.text ? <CardText text={hovered.text} /> : 'No card text.'}</span>
          </>
        ) : (
          <span className="muted small">Hover a minion to read it.</span>
        )}
      </div>
      {!pool.length && <div className="muted small">Loading card data…</div>}
      <div className="build-picker-grid" onMouseLeave={() => setHovered(undefined)}>
        {tiers.map(([tier, cards]) => (
          <div key={tier} className="picker-tier">
            <div className="picker-tier-head">
              <span className="tier-star">★{tier}</span>
              <span className="muted small">{cards.length}</span>
            </div>
            <div className="picker-row">
              {cards.map((c) => (
                <button key={c.id} className="build-minion" style={{ backgroundImage: `url(${artUrl(c.id)})` }} onMouseEnter={() => setHovered(c)} onFocus={() => setHovered(c)} onClick={() => onPick(c)}>
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** A build as a short code, for pasting to someone else. */
function ShareBuild({ build }: { build: Build }) {
  const [code, setCode] = useState<string>()
  const [copied, setCopied] = useState(false)
  const show = async () => {
    const c = await window.api.exportBuild(build.id)
    setCode(c)
    // Clipboard can refuse (no focus, denied permission) — the box below is
    // the fallback, so a failure here isn't worth interrupting anyone over.
    try {
      await navigator.clipboard.writeText(c)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="build-share">
      <button className="btn btn-sm" onClick={() => void show()}>
        {code ? 'Copy again' : 'Export'}
      </button>
      {code && (
        <>
          <input className="input input-code" readOnly value={code} onFocus={(e) => e.currentTarget.select()} />
          <span className="muted small">{copied ? 'Copied' : 'Select and copy'}</span>
        </>
      )}
    </div>
  )
}

function BuildEditor({ build, save, remove }: { build: Build; save: (b: Build) => void; remove: (id: string) => void }) {
  const pool = usePool()
  const [picking, setPicking] = useState<number | 'addons'>()
  const [query, setQuery] = useState('')
  const byId = useMemo(() => new Map(pool.map((c) => [c.id, c])), [pool])
  const patch = (p: Partial<Build>) => save({ ...build, ...p })
  const setTarget = (i: number, t: BuildTarget) => patch({ targets: build.targets.map((x, j) => (j === i ? t : x)) })

  return (
    <div className="build-body">
      <div className="build-meta">
        <input className="input" value={build.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Build name" />
        <select className="input" value={build.tribe} onChange={(e) => patch({ tribe: e.target.value })}>
          <option value="">Any tribe</option>
          {Object.keys(TRIBES).map((t) => (
            <option key={t} value={t}>
              {tribeLabel(t)}
            </option>
          ))}
        </select>
        <button className="btn btn-danger btn-sm" onClick={() => confirm(`Delete “${build.name}”?`) && remove(build.id)}>
          Delete build
        </button>
      </div>
      {build.source && (
        <div className="muted small">
          Started from{' '}
          <a href="#" onClick={() => void window.api.openExternal(build.source!.url)}>
            {build.source.name}
          </a>
          . {build.addons?.length ? 'Core and addon cards' : 'Core minions only'} — the turns are yours to set.
        </div>
      )}

      {build.targets.map((t, i) => (
        <div key={i} className="build-target">
          <div className="build-target-head">
            <span className="muted small">by turn</span>
            <input className="input input-num" type="number" min={1} max={30} value={t.byTurn} onChange={(e) => setTarget(i, { ...t, byTurn: Number(e.target.value) })} />
            <span className="muted small">{t.cardIds.length}/7 minions</span>
            <button className="btn btn-sm" onClick={() => patch({ targets: build.targets.filter((_, j) => j !== i) })}>
              Remove stage
            </button>
          </div>
          <div className="build-minions">
            {t.cardIds.map((id, k) => (
              <button
                key={`${id}-${k}`}
                className="build-minion"
                title={`${byId.get(id)?.name ?? id} — click to remove`}
                style={{ backgroundImage: `url(${artUrl(id)})` }}
                onClick={() => setTarget(i, { ...t, cardIds: t.cardIds.filter((_, m) => m !== k) })}
              >
                <span>{byId.get(id)?.name ?? id}</span>
              </button>
            ))}
            {t.cardIds.length < 7 && (
              <button className="build-minion build-add" onClick={() => setPicking(picking === i ? undefined : i)}>
                <span>{picking === i ? 'Close' : '+ Add'}</span>
              </button>
            )}
          </div>
          {picking === i && (
            <Picker
              build={build}
              pool={pool}
              query={query}
              setQuery={setQuery}
              onPick={(c) => {
                setTarget(i, { ...t, cardIds: [...t.cardIds, c.id] })
                if (t.cardIds.length + 1 >= 7) setPicking(undefined)
              }}
            />
          )}
        </div>
      ))}

      <button className="btn btn-sm" onClick={() => patch({ targets: [...build.targets, { byTurn: (sortedTargets(build).at(-1)?.byTurn ?? 4) + 3, cardIds: [] }] })}>
        Add stage
      </button>

      <div className="build-target">
        <div className="build-target-head">
          <b className="small">Addon cards</b>
          <span className="muted small">support picks, no turn attached</span>
        </div>
        <div className="build-minions">
          {(build.addons ?? []).map((id, k) => (
            <button
              key={`${id}-${k}`}
              className="build-minion"
              title={`${byId.get(id)?.name ?? id} — click to remove`}
              style={{ backgroundImage: `url(${artUrl(id)})` }}
              onClick={() => patch({ addons: (build.addons ?? []).filter((_, m) => m !== k) })}
            >
              <span>{byId.get(id)?.name ?? id}</span>
            </button>
          ))}
          <button className="build-minion build-add" onClick={() => setPicking(picking === 'addons' ? undefined : 'addons')}>
            <span>{picking === 'addons' ? 'Close' : '+ Add'}</span>
          </button>
        </div>
        {picking === 'addons' && (
          <Picker build={build} pool={pool} query={query} setQuery={setQuery} onPick={(c) => patch({ addons: [...(build.addons ?? []), c.id] })} />
        )}
      </div>

      <div className="build-target">
        <div className="build-target-head">
          <b className="small">Description</b>
          <span className="muted small">how to play it — shown under the minions in the build overlay</span>
        </div>
        <textarea className="input build-desc" rows={5} value={build.description ?? ''} placeholder="How to play this build…" onChange={(e) => patch({ description: e.target.value || undefined })} />
      </div>

      <ShareBuild build={build} />
    </div>
  )
}

// ==================================================================== HISTORY

function HistoryPage({ matches }: { matches: BgMatch[] }) {
  const [mode, setMode] = useState<'all' | 'solo' | 'duos'>('all')
  const [open, setOpen] = useState<string>()
  const list = [...matches].filter((m) => mode === 'all' || m.mode === mode).sort((a, b) => b.endedAt - a.endedAt)
  const s = placementStats(list)
  return (
    <div className="page">
      <header className="page-head">
        <h1>History</h1>
        <Seg value={mode} onChange={setMode} options={[['all', 'All'], ['solo', 'Solo'], ['duos', 'Duos']]} />
      </header>
      <div className="stat-row">
        <Stat label="Games" value={s.games} />
        <Stat label="Avg placement" value={s.games ? s.avg.toFixed(2) : '–'} />
        <Stat label="Top half" value={pct(s.topRate)} hint="Top 4 solo / top 2 duos" />
        <Stat label="Wins" value={s.firsts} />
      </div>
      <div className="table">
        {list.map((m) => (
          <div key={m.id} className="match">
            <div className="match-row" onClick={() => setOpen(open === m.id ? undefined : m.id)}>
              <span className="place-badge" style={{ ['--pc' as string]: placeColor(m.placement, m.mode) }}>
                {m.placement || '?'}
              </span>
              <HeroPortrait cardId={m.heroCardId} size={32} />
              <div className="match-hero">
                <b>{m.heroName}</b>
                <div className="muted small">
                  {m.mode === 'duos' ? 'Duos' : 'Solo'} · {m.rounds} turns
                </div>
              </div>
              <div className="match-board">
                <Board minions={m.finalBoard} size="sm" empty="" />
              </div>
              <span className="muted right">{timeAgo(m.endedAt)}</span>
            </div>
            {open === m.id && <MatchDetail m={m} />}
          </div>
        ))}
        {!list.length && <div className="list-empty">No games yet. Finished Battlegrounds games show up here automatically.</div>}
      </div>
    </div>
  )
}

function MatchDetail({ m }: { m: BgMatch }) {
  return (
    <div className="match-detail">
      <div className="detail-line">
        <TribeChips tribes={m.tribes} />
        <span className="muted small">{new Date(m.startedAt).toLocaleString()}</span>
        <button className="btn btn-danger btn-sm" onClick={() => confirm('Delete this game from history?') && void window.api.deleteMatch(m.id)}>
          Delete
        </button>
      </div>
      {m.combats.length > 0 ? <RoundsTable rounds={m.combats} /> : <div className="muted small">No fights recorded.</div>}
    </div>
  )
}

// ====================================================================== STATS

function StatsPage({ matches }: { matches: BgMatch[] }) {
  const [mode, setMode] = useState<'solo' | 'duos'>(() => (matches.filter((m) => m.mode === 'duos').length > matches.length / 2 ? 'duos' : 'solo'))
  const [range, setRange] = useState<'7' | '30' | 'all'>('30')
  const list = matches.filter((m) => m.mode === mode && (range === 'all' || m.endedAt > Date.now() - Number(range) * 86400000))
  const s = placementStats(list)
  const places = mode === 'duos' ? [1, 2, 3, 4] : [1, 2, 3, 4, 5, 6, 7, 8]
  const dist = places.map((p) => list.filter((m) => m.placement === p).length)
  const maxDist = Math.max(1, ...dist)

  const heroes = useMemo(() => {
    const by = new Map<string, BgMatch[]>()
    for (const m of list) by.set(m.heroCardId, [...(by.get(m.heroCardId) ?? []), m])
    return [...by.entries()].map(([id, ms]) => ({ id, name: ms[0].heroName, ...placementStats(ms) })).sort((a, b) => b.games - a.games)
  }, [list])

  const pool = usePool()
  const tribeStats = useMemo(() => {
    const tribesOf = new Map<string, string[]>()
    for (const c of pool) {
      tribesOf.set(c.id, c.races ?? [])
      if (c.goldenId) tribesOf.set(c.goldenId, c.races ?? [])
    }
    return Object.keys(TRIBES)
      .map((t) => ({ t, ...placementStats(list.filter((m) => dominantTribe(m, tribesOf) === t)) }))
      .filter((x) => x.games)
      .sort((a, b) => a.avg - b.avg)
  }, [list, pool])

  // How well-calibrated is the simulator? Bucket predicted win% vs actual outcome.
  const calib = useMemo(() => {
    const buckets = Array.from({ length: 5 }, () => ({ n: 0, wins: 0, predicted: 0 }))
    for (const m of matches)
      for (const r of m.combats) {
        if (!r.odds || !r.result || r.odds.unsupported.length) continue
        const b = buckets[Math.min(4, Math.floor(r.odds.win * 5))]
        b.n++
        b.predicted += r.odds.win
        if (r.result === 'WON') b.wins++
      }
    return buckets
  }, [matches])

  return (
    <div className="page">
      <header className="page-head">
        <h1>Stats</h1>
        <Seg value={mode} onChange={setMode} options={[['solo', 'Solo'], ['duos', 'Duos']]} />
        <Seg value={range} onChange={setRange} options={[['7', '7 days'], ['30', '30 days'], ['all', 'All time']]} />
      </header>
      <div className="stat-row">
        <Stat label="Games" value={s.games} />
        <Stat label="Avg placement" value={s.games ? s.avg.toFixed(2) : '–'} />
        <Stat label={mode === 'duos' ? 'Top 2' : 'Top 4'} value={pct(s.topRate)} />
        <Stat label="1st place" value={s.firsts} hint={s.games ? pct(s.firsts / s.games) : undefined} />
      </div>
      <div className="two-col">
        <Box title="Placements">
          <div className="dist">
            {places.map((p, i) => (
              <div key={p} className="dist-col">
                <div className="dist-n">{dist[i] || ''}</div>
                <div className="dist-bar" style={{ height: `${(dist[i] / maxDist) * 100}%`, background: placeColor(p, mode) }} />
                <div className="dist-label">{ordinal(p)}</div>
              </div>
            ))}
          </div>
        </Box>
        <Box title="Simulator accuracy">
          {calib.some((b) => b.n) ? (
            <>
              {calib.map((b, i) =>
                b.n ? (
                  <div key={i} className="calib-row">
                    <span className="muted">
                      Predicted {i * 20}–{i * 20 + 20}%
                    </span>
                    <div className="calib-bar">
                      <div className="calib-pred" style={{ left: `${(b.predicted / b.n) * 100}%` }} />
                      <div className="calib-act" style={{ width: `${(b.wins / b.n) * 100}%` }} />
                    </div>
                    <span>{pct(b.wins / b.n)}</span>
                    <span className="muted small">{b.n} fights</span>
                  </div>
                ) : null,
              )}
              <div className="muted small">Bars show how often you actually won; the tick is what was predicted.</div>
            </>
          ) : (
            <div className="muted">Play a few games to see how accurate the odds are.</div>
          )}
        </Box>
      </div>
      <div className="two-col">
        <Box title="Heroes">
          {heroes.length ? (
            heroes.map((h) => (
              <div key={h.id} className="hero-stat">
                <HeroPortrait cardId={h.id} size={28} />
                <span className="hero-stat-name">{h.name}</span>
                <span className="muted">{h.games}g</span>
                <b>{h.avg.toFixed(2)}</b>
                <span className="muted">{pct(h.topRate)} top</span>
              </div>
            ))
          ) : (
            <div className="muted">No games in this period.</div>
          )}
        </Box>
        <Box title="Final board tribe">
          {tribeStats.length ? (
            tribeStats.map((x) => (
              <div key={x.t} className="hero-stat">
                <span className="tribe" style={{ ['--tc' as string]: TRIBES[x.t].color }}>
                  {tribeLabel(x.t)}
                </span>
                <span className="hero-stat-name" />
                <span className="muted">{x.games}g</span>
                <b>{x.avg.toFixed(2)}</b>
                <span className="muted">{pct(x.topRate)} top</span>
              </div>
            ))
          ) : (
            <div className="muted">No games in this period.</div>
          )}
        </Box>
      </div>
    </div>
  )
}

/** The tribe most of a final board belongs to. */
function dominantTribe(m: BgMatch, tribesOf: Map<string, string[]>): string | undefined {
  const counts = new Map<string, number>()
  for (const b of m.finalBoard) for (const r of tribesOf.get(b.cardId) ?? []) if (r !== 'ALL') counts.set(r, (counts.get(r) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

// =================================================================== SETTINGS

function SettingsPage() {
  const [status, setStatus] = useState<SetupStatus>()
  const [settings, update] = useSettings()
  const [busy, setBusy] = useState(false)
  const refresh = () => void window.api.setupStatus().then(setStatus)
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [])
  if (!status || !settings) return null
  const o = settings.overlay
  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>Setup</h1>
      </header>
      <Box title="Connection to Hearthstone">
        <Check ok={status.installFound} label="Hearthstone installation" detail={status.hearthstonePath}>
          <button className="btn" onClick={() => void window.api.browseInstall().then(refresh)}>
            Change…
          </button>
        </Check>
        <Check ok={status.logConfigOk} label="Game logging enabled" detail={status.logConfigOk ? status.logConfigPath : 'Hearthstone must be told to write its game log. Restart Hearthstone after enabling.'}>
          {!status.logConfigOk && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                await window.api.fixLogConfig()
                setBusy(false)
                refresh()
              }}
            >
              Enable logging
            </button>
          )}
        </Check>
        <Check ok={status.powerLogFound} label="Reading game log" detail={status.powerLogFound ? status.activeLogDir : 'Appears once you start a game with logging on.'} />
        <Check ok={status.cardDbLoaded} label="Card database" detail={status.cardDbLoaded ? `${status.cardCount.toLocaleString()} cards from HearthstoneJSON` : 'Downloading card data… (needs internet the first time)'} />
      </Box>

      <Box title="Overlay">
        <Toggle label="Show overlays during games" value={o.enabled} onChange={(v) => void update({ overlay: { ...o, enabled: v } })} />
        <Toggle label="Combat odds (top of screen)" value={o.showOdds} onChange={(v) => void update({ overlay: { ...o, showOdds: v } })} />
        <Toggle label="Lobby & opponent boards (left)" value={o.showLobby} onChange={(v) => void update({ overlay: { ...o, showLobby: v } })} />
        <Toggle label="Build sidebar (right)" hint="Only appears once you've picked a build for the game." value={o.showBuild} onChange={(v) => void update({ overlay: { ...o, showBuild: v } })} />
        <Toggle
          label="Debug minion highlight"
          hint="Draws a purple box over every minion in the tavern, to check the boxes line up. Build minions stay gold."
          value={o.debugHighlights}
          onChange={(v) => void update({ overlay: { ...o, debugHighlights: v } })}
        />
        <Toggle
          label="Lock overlays"
          hint="Unlock to drag and resize the overlay windows. Locked overlays are click-through; hover a lobby row to see that player’s last board."
          value={o.locked}
          onChange={(v) => void update({ overlay: { ...o, locked: v } })}
        />
        <Slider label="Opacity" min={0.3} max={1} step={0.05} value={o.opacity} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => void update({ overlay: { ...o, opacity: v } })} />
        <Slider label="Size" min={0.7} max={1.5} step={0.05} value={o.scale} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => void update({ overlay: { ...o, scale: v } })} />
      </Box>

      <Box title="Simulator">
        <Slider
          label="Simulations per fight"
          hint="More is steadier but slower. 5,000 takes a few milliseconds on most boards."
          min={1000}
          max={20000}
          step={1000}
          value={settings.simIterations}
          fmt={(v) => v.toLocaleString()}
          onChange={(v) => void update({ simIterations: v })}
        />
      </Box>
      <p className="muted small">
        Card data and art from{' '}
        <a href="#" onClick={() => void window.api.openExternal('https://hearthstonejson.com')}>
          HearthstoneJSON
        </a>
        . Not affiliated with Blizzard Entertainment.
      </p>
    </div>
  )
}

// ================================================================== bits

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card-box">
      <div className="box-title">{title}</div>
      {children}
    </div>
  )
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => (
        <button key={v} className={value === v ? 'seg-on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  )
}

function Check({ ok, label, detail, children }: { ok: boolean; label: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="check-row">
      <span className={`check-icon ${ok ? 'ok' : 'bad'}`}>{ok ? '✓' : '!'}</span>
      <div className="check-text">
        <div>{label}</div>
        {detail && <div className="muted small">{detail}</div>}
      </div>
      {children}
    </div>
  )
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <div>
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <button type="button" className={`toggle ${value ? 'toggle-on' : ''}`} onClick={() => onChange(!value)}>
        <span />
      </button>
    </label>
  )
}

function Slider({ label, hint, value, min, max, step, fmt, onChange }: { label: string; hint?: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="toggle-row">
      <div>
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="slider">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span>{fmt(value)}</span>
      </div>
    </label>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
