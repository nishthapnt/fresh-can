import { describe, it, expect } from 'vitest'
import { normalizeReferenceCopyOutput, deriveFromOutline, type ReferenceCopyInput } from './generateReferenceCopy'

const INPUT: ReferenceCopyInput = {
  title: 'How Fresh-CAN Brings Groceries to Your Street',
  sections: [
    { heading: 'The Problem', summary: 'Many neighbourhoods lack easy access to fresh food.' },
    { heading: 'How It Works', summary: 'Scan in with the app, take what you need, and go.' },
    { heading: 'A Real Family', summary: 'The Okafors now shop three times a week.' },
  ],
}

const VALID = {
  coreMessage: 'Fresh-CAN brings a full grocery store to streets that need one, with no lines and no cashier.',
  inlineHighlight: {
    heading: 'A Real Family',
    visualMoment: 'A mother and her two kids carrying grocery bags out the rear doors at golden hour.',
  },
}

describe('normalizeReferenceCopyOutput', () => {
  it('accepts a well-formed response whose inlineHighlight.heading matches a real section', () => {
    const result = normalizeReferenceCopyOutput(VALID, INPUT)
    expect(result).not.toBeNull()
    expect(result!.coreMessage).toBe(VALID.coreMessage)
    expect(result!.inlineHighlight.heading).toBe('A Real Family')
  })

  it('rejects an inlineHighlight.heading that does not match any real outline section', () => {
    const result = normalizeReferenceCopyOutput(
      { ...VALID, inlineHighlight: { ...VALID.inlineHighlight, heading: 'A Section That Does Not Exist' } },
      INPUT,
    )
    expect(result).toBeNull()
  })

  it('rejects a missing coreMessage', () => {
    const { coreMessage: _coreMessage, ...rest } = VALID
    expect(normalizeReferenceCopyOutput(rest, INPUT)).toBeNull()
  })

  it('rejects an empty-string coreMessage', () => {
    expect(normalizeReferenceCopyOutput({ ...VALID, coreMessage: '' }, INPUT)).toBeNull()
  })

  it('rejects a missing inlineHighlight entirely', () => {
    const { inlineHighlight: _inlineHighlight, ...rest } = VALID
    expect(normalizeReferenceCopyOutput(rest, INPUT)).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(normalizeReferenceCopyOutput(null, INPUT)).toBeNull()
    expect(normalizeReferenceCopyOutput('not json', INPUT)).toBeNull()
  })
})

describe('deriveFromOutline (the no-LLM-call fallback — failure path and no-sections path)', () => {
  it('uses the title as coreMessage and the first section\'s own heading/summary verbatim as the inline highlight', () => {
    const result = deriveFromOutline(INPUT)
    expect(result.coreMessage).toBe(INPUT.title)
    expect(result.inlineHighlight.heading).toBe(INPUT.sections[0].heading)
    expect(result.inlineHighlight.visualMoment).toBe(INPUT.sections[0].summary)
  })

  it('returns an empty inlineHighlight (never throws) when there are no sections at all — a pre-existing job predating the parseable outline schema', () => {
    const result = deriveFromOutline({ title: 'A Pre-existing Post', sections: [] })
    expect(result.coreMessage).toBe('A Pre-existing Post')
    expect(result.inlineHighlight).toEqual({ heading: '', visualMoment: '' })
  })
})
