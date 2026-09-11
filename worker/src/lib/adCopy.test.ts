import { describe, it, expect } from 'vitest'
import { parseAdCopy } from './adCopy.js'

describe('parseAdCopy', () => {
  it('extracts headline/subtitle/coreMessage from a well-formed output', () => {
    const result = parseAdCopy(
      { headline: 'Fresh Food, Closer Than You Think', subtitle: 'Every neighbourhood', coreMessage: 'A story.' },
      'fallback headline',
      'fallback subtitle',
    )
    expect(result).toEqual({
      headline: 'Fresh Food, Closer Than You Think',
      subtitle: 'Every neighbourhood',
      coreMessage: 'A story.',
    })
  })

  it('falls back to the given values when output is null (step not succeeded yet)', () => {
    const result = parseAdCopy(null, 'fallback headline', 'fallback subtitle')
    expect(result).toEqual({ headline: 'fallback headline', subtitle: 'fallback subtitle', coreMessage: '' })
  })

  it('falls back per-field when the model omits one field but not the other', () => {
    const result = parseAdCopy({ headline: 'Real Headline' }, 'fallback headline', 'fallback subtitle')
    expect(result.headline).toBe('Real Headline')
    expect(result.subtitle).toBe('fallback subtitle')
  })

  it('treats a blank/whitespace-only headline as missing', () => {
    const result = parseAdCopy({ headline: '   ', subtitle: 'Real Subtitle' }, 'fallback headline', 'fallback subtitle')
    expect(result.headline).toBe('fallback headline')
    expect(result.subtitle).toBe('Real Subtitle')
  })

  it('defaults coreMessage to an empty string when absent (generate_outline output shape)', () => {
    const result = parseAdCopy({ headline: 'H', subtitle: 'S' }, 'fh', 'fs')
    expect(result.coreMessage).toBe('')
  })
})
