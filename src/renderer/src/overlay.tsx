import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent } from 'react'
import './styles.css'
import { CardText, HeroPortrait, LobbyList, OddsBar, ResultBadge, SessionStrip, TribeChips } from './components'
import { TRIBES, artUrl, buildProgress, buildsByLobby, parseCardLinks, currentSession, sortedTargets, tribeLabel, useBuilds, useMatches, usePool, useSettings, useSnapshot } from './lib'
import type { BgSnapshot, Build, CardInfo } from '../../shared/types'

const param = new URLSearchParams(location.search).get('kind')
const kind = param === 'lobby' ? 'lobby' : param === 'build' ? 'build' : param === 'slots' ? 'slots' : 'odds'

function Overlay() {
  const snap = useSnapshot()
  const [settings] = useSettings()
  const locked = settings?.overlay.locked ?? true
  const scale = settings?.overlay.scale ?? 1
  // The highlight layer is positioned over the game by the main process and
  // draws in game coordinates, so it gets none of the usual card chrome.
  if (kind === 'slots') return <Highlights boxes={snap?.shopHighlights ?? []} />
  return (
    <div className={`overlay ${locked ? 'locked' : 'unlocked'}`} style={{ zoom: scale }}>
      {!locked && <div className="ov-drag">Drag to position · lock in Setup</div>}
      {snap?.buildPrompt?.length && kind === 'odds' ? <BuildPrompt builds={snap.buildPrompt} /> : null}
      {snap && (kind === 'odds' ? <OddsOverlay snap={snap} /> : kind === 'lobby' ? <LobbyOverlay snap={snap} /> : <BuildOverlay snap={snap} />)}
    </div>
  )
}

/** Boxes drawn straight onto the game, marking tavern cards the build wants. */
function Highlights({ boxes }: { boxes: BgSnapshot['shopHighlights'] }) {
  return (
    <div className="hl-layer">
      {boxes.map((b, i) => (
        <div key={`${b.x}-${b.y}-${i}`} className="hl-box" style={{ left: b.x, top: b.y, width: b.width, height: b.height }} />
      ))}
    </div>
  )
}

/** Offered once, right after the hero is locked in. Dismissing is a real answer. */
function BuildPrompt({ builds }: { builds: Build[] }) {
  return (
    <div className="ov-card ov-enter ov-prompt">
      <div className="ov-head">
        <b>Going for a build?</b>
        <button className="btn btn-sm ov-prompt-skip" onClick={() => void window.api.selectBuild(null)}>
          Not this game
        </button>
      </div>
      <div className="ov-prompt-list">
        {builds.map((b) => (
          <button key={b.id} className="ov-prompt-build" onClick={() => void window.api.selectBuild(b.id)}>
            <span className="tribe" style={{ ['--tc' as string]: TRIBES[b.tribe]?.color ?? 'var(--accent)' }}>
              {tribeLabel(b.tribe)}
            </span>
            <b>{b.name}</b>
            <span className="muted small">{sortedTargets(b).at(-1)?.byTurn ?? 0} turns</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function OddsOverlay({ snap }: { snap: BgSnapshot }) {
  const c = snap.combat
  if (c?.odds) {
    // Stays up for the whole fight and through the next shop phase, until the next fight replaces it.
    const fighting = snap.phase === 'combat' && c.round === snap.round
    return (
      // Keyed by fight: a new fight remounts the card, replaying the slide-in.
      <div key={`fight-${c.round}`} className={`ov-card ov-enter ${fighting ? 'ov-live' : 'ov-card-past'}`}>
        <div className="ov-head">
          {!fighting && <span className="muted">Last fight ·</span>}
          <HeroPortrait cardId={c.opponentHeroCardId} size={22} />
          <span>vs {c.opponentHeroName ?? 'opponent'}</span>
          <ResultBadge result={c.result} damage={c.damage} />
        </div>
        <OddsBar odds={c.odds} compact fightKey={c.round} />
      </div>
    )
  }
  return snap.status === 'in-game' ? <div className="ov-card ov-card-quiet muted">Odds appear when combat starts</div> : null
}

/** What you're building towards: the current stage, ticked off against your board. */
/**
 * Pointer handlers that make this overlay take clicks while the pointer is
 * inside. A locked overlay is otherwise click-through, and only mouse moves
 * reach it. Unmounting while inside clears it too, because an element that
 * disappears from under the pointer never gets its mouseleave.
 */
function useClickZone() {
  const inside = useRef(false)
  const set = (on: boolean) => {
    inside.current = on
    void window.api.setInteractive(on)
  }
  useEffect(() => () => void (inside.current && window.api.setInteractive(false)), [])
  return { onMouseEnter: () => set(true), onMouseLeave: () => set(false) }
}

function OvButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} {...useClickZone()} />
}

/**
 * Every saved build, this lobby's tribes first. Builds are fetched when it
 * opens, since saving one in the main window doesn't broadcast.
 */
function BuildPicker({ snap, onClose }: { snap: BgSnapshot; onClose: () => void }) {
  const [builds] = useBuilds()
  const zone = useClickZone()
  const [relevant, rest] = buildsByLobby(builds, snap.tribes)
  const row = (b: Build) => (
    <button
      key={b.id}
      className={`ov-prompt-build ${b.id === snap.selectedBuild?.id ? 'current' : ''}`}
      onClick={() => {
        void window.api.selectBuild(b.id)
        onClose()
      }}
    >
      {b.tribe && (
        <span className="tribe" style={{ ['--tc' as string]: TRIBES[b.tribe]?.color ?? 'var(--accent)' }}>
          {tribeLabel(b.tribe)}
        </span>
      )}
      <b>{b.name}</b>
    </button>
  )
  return (
    <div className="ov-card ov-prompt ov-picker" {...zone}>
      <div className="ov-head">
        <b>Pick a build</b>
        <button className="btn btn-sm ov-prompt-skip" onClick={onClose}>
          Cancel
        </button>
      </div>
      <div className="ov-prompt-list">
        {relevant.map(row)}
        {rest.length > 0 && <div className="ov-build-sub">Other tribes</div>}
        {rest.map(row)}
        {!builds.length && <span className="muted small">No builds yet. Make one on the Builds page.</span>}
      </div>
    </div>
  )
}

function BuildOverlay({ snap }: { snap: BgSnapshot }) {
  const build = snap.selectedBuild
  const pool = usePool()
  const cards = useMemo(() => new Map(pool.map((c) => [c.id, c])), [pool])
  const byDbf = useMemo(() => new Map(pool.map((c) => [c.dbfId, c])), [pool])
  const [picking, setPicking] = useState(false)
  const [tip, setTip] = useState<{ card: CardInfo; style: CSSProperties }>()
  if (!build) return null
  if (picking) return <BuildPicker snap={snap} onClose={() => setPicking(false)} />
  const p = buildProgress(build, Math.max(1, snap.round), snap.board, snap.shop)
  if (!p) return null
  const done = p.have === p.minions.length
  /**
   * Card detail for a minion row or a card named in the description. The
   * tooltip lives in the card (the scroll container), placed from the hovered
   * element's layout offset rather than its screen rect, which keeps it right
   * under the overlay's `zoom` scale. Anything in the lower half of the visible
   * card gets it above, via a transform, since its own height isn't known yet.
   */
  const showTip = (e: MouseEvent<HTMLElement>, card: CardInfo | undefined) => {
    const el = e.currentTarget
    const box = el.closest<HTMLElement>('.ov-build')
    if (!card || !box) return setTip(undefined)
    const below = el.offsetTop - box.scrollTop + el.offsetHeight / 2 < box.clientHeight / 2
    setTip({ card, style: below ? { top: el.offsetTop + el.offsetHeight + 4 } : { top: el.offsetTop - 4, transform: 'translateY(-100%)' } })
  }
  const row = (m: (typeof p.minions)[number], key: string) => (
    <div key={key} className={`ov-build-minion ${m.have ? 'have' : ''} ${m.inShop ? 'in-shop' : ''}`} onMouseEnter={(e) => showTip(e, cards.get(m.cardId))} onMouseLeave={() => setTip(undefined)}>
      <span className="ov-build-art" style={{ backgroundImage: `url(${artUrl(m.cardId)})` }} />
      <span className="ov-build-name">{cards.get(m.cardId)?.name ?? m.cardId}</span>
      {m.have ? <span className="ov-build-tick">✓</span> : m.inShop ? <span className="ov-build-shop">in shop</span> : null}
    </div>
  )
  return (
    <div className="ov-card ov-build" onScroll={() => setTip(undefined)}>
      <div className="ov-head">
        <b>{build.name}</b>
        <span className="muted small">
          {p.have}/{p.minions.length}
        </span>
        <OvButton className="btn btn-sm" onClick={() => setPicking(true)}>
          Change
        </OvButton>
      </div>
      <div className={`ov-build-turn ${!done && p.turnsLeft < 0 ? 'danger' : ''}`}>
        {done ? 'Stage complete' : p.turnsLeft > 0 ? `by turn ${p.stage.byTurn} · ${p.turnsLeft} to go` : p.turnsLeft === 0 ? `by turn ${p.stage.byTurn} · this turn` : `${-p.turnsLeft} turn${p.turnsLeft === -1 ? '' : 's'} overdue`}
      </div>
      <div className="ov-build-list">
        {p.minions.map((m, i) => row(m, `${m.cardId}-${i}`))}
        {p.addons.length > 0 && (
          <>
            <div className="ov-build-sub">Addons</div>
            {p.addons.map((m, i) => row(m, `a-${m.cardId}-${i}`))}
          </>
        )}
      </div>
      {build.description && (
        <div className="ov-build-desc">
          <div className="ov-build-sub">How to play</div>
          <p>
            {parseCardLinks(build.description).map((part, i) => {
              if (part.dbfId === undefined) return <span key={i}>{part.text}</span>
              const card = byDbf.get(part.dbfId)
              return (
                <b key={i} className={card ? 'ov-card-link' : undefined} onMouseEnter={(e) => showTip(e, card)} onMouseLeave={() => setTip(undefined)}>
                  {part.text}
                </b>
              )
            })}
          </p>
        </div>
      )}
      {tip && (
        <div className="ov-tip" style={tip.style}>
          <b>{tip.card.name}</b>
          <div className="ov-tip-meta">
            Tier {tip.card.techLevel ?? '?'} · {(tip.card.races ?? []).map((r) => (r === 'ALL' ? 'All' : tribeLabel(r))).join(' · ') || 'Neutral'}
          </div>
          {tip.card.text && (
            <div className="ov-tip-text">
              <CardText text={tip.card.text} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function LobbyOverlay({ snap }: { snap: BgSnapshot }) {
  // Locked overlays are click-through, but mouse movement still arrives, so
  // hovering a row shows that player's last board; otherwise the next opponent's.
  const [hover, setHover] = useState<number>()
  const matches = useMatches()
  const session = currentSession(matches)
  const next = snap.lobby.find((p) => p.isNextOpponent && !p.dead && p.lastBoard) ?? snap.lobby.find((p) => p.isNextOpponent && !p.dead)
  const [picking, setPicking] = useState(false)
  return (
    <>
      {picking && snap.buildPickable && <BuildPicker snap={snap} onClose={() => setPicking(false)} />}
      <div className="ov-card ov-lobby">
        <div className="ov-head">
          <b>Turn {Math.max(1, snap.round)}</b>
          <span className="muted">{snap.mode === 'duos' ? 'Duos' : 'Solo'}</span>
          {snap.buildPickable && !picking && (
            <OvButton className="btn btn-sm ov-pick-build" onClick={() => setPicking(true)}>
              Pick a build
            </OvButton>
          )}
        </div>
        <SessionStrip s={session} compact />
        <TribeChips tribes={snap.tribes} />
        <LobbyList players={snap.lobby} mode={snap.mode} expandedId={hover ?? next?.playerId} onHover={setHover} />
      </div>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Overlay />)
