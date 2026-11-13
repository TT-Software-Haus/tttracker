import { createRoot } from 'react-dom/client'
import { useMemo, useState } from 'react'
import './styles.css'
import { HeroPortrait, LobbyList, OddsBar, ResultBadge, SessionStrip, TribeChips } from './components'
import { TRIBES, artUrl, buildProgress, currentSession, sortedTargets, tribeLabel, useMatches, usePool, useSettings, useSnapshot } from './lib'
import type { BgSnapshot, Build } from '../../shared/types'

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
function BuildOverlay({ snap }: { snap: BgSnapshot }) {
  const build = snap.selectedBuild
  const pool = usePool()
  const names = useMemo(() => new Map(pool.map((c) => [c.id, c.name])), [pool])
  if (!build) return null
  const p = buildProgress(build, Math.max(1, snap.round), snap.board, snap.shop)
  if (!p) return null
  const done = p.have === p.minions.length
  return (
    <div className="ov-card ov-build">
      <div className="ov-head">
        <b>{build.name}</b>
        <span className="muted small">
          {p.have}/{p.minions.length}
        </span>
      </div>
      <div className={`ov-build-turn ${!done && p.turnsLeft < 0 ? 'danger' : ''}`}>
        {done ? 'Stage complete' : p.turnsLeft > 0 ? `by turn ${p.stage.byTurn} · ${p.turnsLeft} to go` : p.turnsLeft === 0 ? `by turn ${p.stage.byTurn} · this turn` : `${-p.turnsLeft} turn${p.turnsLeft === -1 ? '' : 's'} overdue`}
      </div>
      <div className="ov-build-list">
        {p.minions.map((m, i) => (
          <div key={`${m.cardId}-${i}`} className={`ov-build-minion ${m.have ? 'have' : ''} ${m.inShop ? 'in-shop' : ''}`}>
            <span className="ov-build-art" style={{ backgroundImage: `url(${artUrl(m.cardId)})` }} />
            <span className="ov-build-name">{names.get(m.cardId) ?? m.cardId}</span>
            {m.have ? <span className="ov-build-tick">✓</span> : m.inShop ? <span className="ov-build-shop">in shop</span> : null}
          </div>
        ))}
        {p.addons.length > 0 && (
          <>
            <div className="ov-build-sub">Addons</div>
            {p.addons.map((m, i) => (
              <div key={`a-${m.cardId}-${i}`} className={`ov-build-minion ${m.have ? 'have' : ''} ${m.inShop ? 'in-shop' : ''}`}>
                <span className="ov-build-art" style={{ backgroundImage: `url(${artUrl(m.cardId)})` }} />
                <span className="ov-build-name">{names.get(m.cardId) ?? m.cardId}</span>
                {m.have ? <span className="ov-build-tick">✓</span> : m.inShop ? <span className="ov-build-shop">in shop</span> : null}
              </div>
            ))}
          </>
        )}
      </div>
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
