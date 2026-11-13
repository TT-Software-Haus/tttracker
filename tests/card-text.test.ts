import { describe, expect, it } from 'vitest'
import { cardTextParts, cardTextPlain } from '../src/renderer/src/lib'

/**
 * Hearthstone marks its own keywords up, so the emphasis is real data rather
 * than something to guess at. These are the shapes the card file actually
 * contains — checked against the live card data, not invented.
 */
describe('reading card text', () => {
  it('bolds the keywords Hearthstone marks', () => {
    expect(cardTextParts('<b>Battlecry:</b> Get 2 <b>Blood Gems</b>.')).toEqual([
      { text: 'Battlecry:', bold: true, italic: false },
      { text: ' Get 2 ', bold: false, italic: false },
      { text: 'Blood Gems', bold: true, italic: false },
      { text: '.', bold: false, italic: false },
    ])
  })

  it('keeps nested bold bold', () => {
    // Real text: "<b><b>Bonus Keyword</b>s</b>". Matching tags in pairs
    // un-bolds the trailing "s"; counting depth doesn't.
    const parts = cardTextParts('This keeps <b><b>Bonus Keyword</b>s</b> and stats.')
    expect(parts.filter((p) => p.bold).map((p) => p.text)).toEqual(['Bonus Keyword', 's'])
    expect(cardTextPlain('This keeps <b><b>Bonus Keyword</b>s</b> and stats.')).toBe('This keeps Bonus Keywords and stats.')
  })

  it('carries italics through as well', () => {
    expect(cardTextParts('<i>Flavour.</i>')).toEqual([{ text: 'Flavour.', bold: false, italic: true }])
  })

  it('drops the [x] layout marker and folds newlines into spaces', () => {
    expect(cardTextPlain('[x]<b>Taunt</b>. After you play a\nDemon, consume a\nminion.')).toBe('Taunt. After you play a Demon, consume a minion.')
  })

  it('handles text with no markup at all', () => {
    expect(cardTextParts('When you sell this, get a random Murloc.')).toEqual([{ text: 'When you sell this, get a random Murloc.', bold: false, italic: false }])
  })

  it('returns nothing for a card with no text', () => {
    expect(cardTextParts(undefined)).toEqual([])
    expect(cardTextParts('')).toEqual([])
    expect(cardTextPlain(undefined)).toBe('')
  })

  it('survives a stray closing tag rather than going negative', () => {
    const parts = cardTextParts('Odd</b> text')
    expect(parts.every((p) => !p.bold)).toBe(true)
    expect(cardTextPlain('Odd</b> text')).toBe('Odd text')
  })
})
