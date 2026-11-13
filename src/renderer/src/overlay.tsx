import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import './styles.css'
import { HeroPortrait, LobbyList, OddsBar, ResultBadge, SessionStrip, TribeChips } from './components'
import { TRIBES, currentSession, sortedTargets, tribeLabel, useMatches, useSettings, useSnapshot } from './lib'
import type { BgSnapshot, Build } from '../../shared/types'

const kind = new URLSearchParams(location.search).get('kind') === 'lobby' ? 'lobby' : 'odds'

function Overlay() {
  const snap = useSnapshot()
  const [settings] = useSettings()
  const locked = settings?.overlay.locked ?? true
  const scale = settings?.overlay.scale ?? 1
  return (
    <div className={`overlay ${locked ? 'locked' : 'unlocked'}`} style={{ zoom: scale }}>
      {!locked && <div className="ov-drag">Drag to position · lock in Setup</div>}
      {snap?.buildPrompt?.length && kind === 'odds' ? <BuildPrompt builds={snap.buildPrompt} /> : null}
      {snap && (kind === 'odds' ? <OddsOverlay snap={snap} /> : <LobbyOverlay snap={snap} />)}
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

function LobbyOverlay({ snap }: { snap: BgSnapshot }) {
  // Locked overlays are click-through, but mouse movement still arrives, so
  // hovering a row shows that player's last board; otherwise the next opponent's.
  const [hover, setHover] = useState<number>()
  const matches = useMatches()
  const session = currentSession(matches)
  const next = snap.lobby.find((p) => p.isNextOpponent && !p.dead && p.lastBoard) ?? snap.lobby.find((p) => p.isNextOpponent && !p.dead)
  return (
    <div className="ov-card ov-lobby">
      <div className="ov-head">
        <b>Turn {Math.max(1, snap.round)}</b>
        <span className="muted">{snap.mode === 'duos' ? 'Duos' : 'Solo'}</span>
      </div>
      <SessionStrip s={session} compact />
      <TribeChips tribes={snap.tribes} />
      <LobbyList players={snap.lobby} mode={snap.mode} expandedId={hover ?? next?.playerId} onHover={setHover} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Overlay />)
