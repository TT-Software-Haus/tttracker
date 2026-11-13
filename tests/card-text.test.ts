import { describe, expect, it } from 'vitest'
import { cardTextParts, cardTextPlain, parseCardLinks } from '../src/renderer/src/lib'

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

/** HSReplay's How to Play names cards as [[Name||dbfId]]; real text, trimmed. */
describe('reading card links in a build description', () => {
  it('splits text from the cards it names', () => {
    expect(parseCardLinks('Allowing [[Felboar||110664]] or [[Twisted Wrathguard||130662]] to eat.')).toEqual([
      { text: 'Allowing ' },
      { text: 'Felboar', dbfId: 110664 },
      { text: ' or ' },
      { text: 'Twisted Wrathguard', dbfId: 130662 },
      { text: ' to eat.' },
    ])
  })

  it('handles a link at the very start and end', () => {
    expect(parseCardLinks('[[Brann Bronzebeard||96786]]')).toEqual([{ text: 'Brann Bronzebeard', dbfId: 96786 }])
  })

  it('leaves typed text, and brackets that are not links, alone', () => {
    expect(parseCardLinks('Hold [[two]] Brann.\nThen roll.')).toEqual([{ text: 'Hold [[two]] Brann.\nThen roll.' }])
    expect(parseCardLinks('')).toEqual([])
  })
})
