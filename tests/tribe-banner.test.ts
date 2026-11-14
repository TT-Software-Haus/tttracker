import { describe, expect, it } from 'vitest'
import { parseTribeBanner } from '../src/main/vision/tribeNames'

/**
 * The banner is the only place the lobby's minion types exist before the first
 * shop, so a misread here picks the wrong build for a whole game. OCR output is
 * messy by nature: these are the shapes it actually produces — wrapped lines,
 * the odd wrong letter, and the surrounding UI text bleeding into the crop.
 */
describe('reading the hero-select tribe banner', () => {
  it('reads a clean two-line banner', () => {
    expect(parseTribeBanner('Demons, Dragons, Elementals,\nMechs, Pirates')).toEqual(['DEMON', 'DRAGON', 'ELEMENTAL', 'MECHANICAL', 'PIRATE'])
  })

  it('recovers from the odd wrong letter', () => {
    // 'Murlocs'→'Murlocs', 'Quilboar'→'Ouilboar', 'Undead'→'Undeed' are all
    // single-substitution errors tesseract makes on this font.
    expect(parseTribeBanner('Murlocs, Ouilboar, Undeed, Naqa')).toEqual(['MURLOC', 'NAGA', 'QUILBOAR', 'UNDEAD'])
  })

  it('ignores surrounding UI text caught by a loose crop', () => {
    expect(parseTribeBanner('Choose a Hero\nBeasts, Aberrations\nConfirm')).toEqual(['ABERRATION', 'BEAST'])
  })

  it('returns nothing when the banner is not on screen', () => {
    expect(parseTribeBanner('')).toEqual([])
    expect(parseTribeBanner('Waiting For Combat...')).toEqual([])
  })

  it('does not invent a tribe from unrelated words', () => {
    // 'Reroll' and 'Tavern' are on screen at hero select; neither is a tribe.
    expect(parseTribeBanner('Reroll Tavern Tier Confirm Hero Power')).toEqual([])
  })
})
