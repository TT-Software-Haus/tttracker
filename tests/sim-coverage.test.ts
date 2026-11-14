// What counts as "Not modelled". Unrecognised text used to be reported only if it
// mentioned a combat keyword, so anything phrased otherwise vanished silently;
// now everything unrecognised is reported, and shop-only text is recognised as
// such instead. Card texts below are real (HearthstoneJSON, 2026-11-14).
import { describe, expect, it } from 'vitest'
import { compileFx, compileHeroPower } from '../src/main/bg/sim/effects'
import type { CardSource } from '../src/main/bg/sim/engine'
import type { CardInfo } from '../src/shared/types'

const none: CardSource = { get: () => undefined, bgMinionsNamed: () => [], bgSpellNamed: () => undefined, pool: () => [] }
const card = (text: string, extra: Partial<CardInfo> = {}): CardInfo => ({ id: 'TEST', dbfId: 1, name: 'Test', cost: 0, type: 'MINION', text, ...extra })
const unsupported = (text: string) => compileFx(card(text), none).unsupported

describe('shop-only text is not "Not modelled"', () => {
  it.each([
    ['counters', 'After you spend 5 Gold, get a Lockbox. <i>(5 Gold left!)</i>'],
    ['"each turn" triggers', 'At the start of each turn, gain +1 Attack.'],
    ['what follows a shop trigger', '[x]When you sell this, give\nyour minions +1 Attack.\nImprove your future\nBallers.'],
    ['end-of-turn text with a follow-on', '[x]At the end of your turn, give\nadjacent minions +1 Attack.\nRepeat for each friendly\nGolden minion.'],
    ['Passing', 'The first time your team <b>Passes</b> each turn, gain +1/+2.'],
    ['placeholder cards', 'This has a different <b>Dark Gift</b>, stats, and Tier each game!'],
    ['tavern text in a Deathrattle', '<b>Deathrattle:</b> Minions in the Tavern have +1/+1 this game.'],
  ])('%s', (_what, text) => {
    expect(unsupported(text)).toEqual([])
  })
})

describe('unrecognised combat text is reported', () => {
  it('even without a combat keyword in it', () => {
    // Real text (Balinda Stonehearth). Spells cast in combat would be doubled.
    expect(unsupported('[x]Your spells that target\nfriendly minions cast\ntwice.')).toEqual(['Your spells that target friendly minions cast twice.'])
  })
})

describe('hero powers', () => {
  it('reports Start of Combat ones without a handler', () => {
    const power = card('<b>Start of Combat:</b> Teleport every minion to the moon.', { type: 'HERO_POWER', name: 'Not A Real Power' })
    expect(compileHeroPower(power, none).unsupported).toHaveLength(1)
  })

  it('ignores the rest: they act in the shop', () => {
    expect(compileHeroPower(card('Refresh the Tavern.', { type: 'HERO_POWER', name: 'Shop Thing' }), none).unsupported).toEqual([])
  })

  it('knows Wingmen', () => {
    expect(compileHeroPower(card('Start of Combat: ...', { type: 'HERO_POWER', name: 'Wingmen' }), none).startOfCombat).toBeTypeOf('function')
  })
})
