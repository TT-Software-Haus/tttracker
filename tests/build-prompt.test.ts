import { describe, expect, it } from 'vitest'
import { buildsToOffer, canPickBuild } from '../src/main/tracker'
import type { Build } from '../src/shared/types'

/**
 * This gate runs on every published snapshot (~17/second), and it's the only
 * thing standing between the player and a prompt appearing over a live fight.
 * Each case here is a way that could go wrong in a real game.
 */
describe('deciding whether to offer a build', () => {
  const murlocs: Build = { id: 'b1', name: 'Scam murlocs', tribe: 'MURLOC', targets: [] }
  const demons: Build = { id: 'b2', name: 'Big demons', tribe: 'DEMON', targets: [] }
  const builds = [murlocs, demons]
  const ready = { heroPicked: true, answered: false, hasSelection: false, inGame: true }

  it('offers only the builds whose tribe is in this lobby', () => {
    expect(buildsToOffer(builds, ['MURLOC', 'PIRATE'], ready)).toEqual([murlocs])
  })

  it('says nothing before the hero is locked in', () => {
    expect(buildsToOffer(builds, ['MURLOC'], { ...ready, heroPicked: false })).toBeUndefined()
  })

  it('never asks twice — dismissing is a real answer', () => {
    expect(buildsToOffer(builds, ['MURLOC'], { ...ready, answered: true })).toBeUndefined()
  })

  it('stops asking once a build is being followed', () => {
    expect(buildsToOffer(builds, ['MURLOC'], { ...ready, hasSelection: true })).toBeUndefined()
  })

  it('stays quiet out of game, so it cannot appear over the menu', () => {
    expect(buildsToOffer(builds, ['MURLOC'], { ...ready, inGame: false })).toBeUndefined()
  })

  it('stays quiet when no build matches, rather than offering everything', () => {
    expect(buildsToOffer(builds, ['BEAST', 'NAGA'], ready)).toBeUndefined()
  })

  it('stays quiet when the tribes are not known yet', () => {
    expect(buildsToOffer(builds, [], ready)).toBeUndefined()
  })

  it('offers every matching build when two share a tribe', () => {
    const other: Build = { id: 'b3', name: 'Murloc tempo', tribe: 'MURLOC', targets: [] }
    expect(buildsToOffer([...builds, other], ['MURLOC'], ready)).toEqual([murlocs, other])
  })
})

/**
 * The way back to a build from the lobby overlay. It has to appear after a
 * dismissal (or a lobby nothing matched) and stay out of the way otherwise.
 */
describe('offering "Pick a build" on the lobby overlay', () => {
  const b: Build = { id: 'b1', name: 'Scam murlocs', tribe: 'MURLOC', targets: [] }
  const ready = { heroPicked: true, hasSelection: false, inGame: true }

  it('appears once the prompt has been answered with no build', () => {
    expect(canPickBuild([b], undefined, ready)).toBe(true)
  })

  it('stays hidden while the prompt is still asking', () => {
    expect(canPickBuild([b], [b], ready)).toBe(false)
  })

  it('stays hidden during hero select', () => {
    expect(canPickBuild([b], undefined, { ...ready, heroPicked: false })).toBe(false)
  })

  it('stays hidden when a build is already being followed — that has its own Change button', () => {
    expect(canPickBuild([b], undefined, { ...ready, hasSelection: true })).toBe(false)
  })

  it('stays hidden with no saved builds, and outside a game', () => {
    expect(canPickBuild([], undefined, ready)).toBe(false)
    expect(canPickBuild([b], undefined, { ...ready, inGame: false })).toBe(false)
  })
})
