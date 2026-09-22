import { describe, it, expect } from 'vitest'
import { normalizeCreativeBrief } from './interpretIntent'

const VALID = {
  intent: 'community story',
  coreMessage: 'A family finds fresh food close to home.',
  audience: 'General public',
  emotionalTone: 'warm, hopeful',
  desiredResponse: 'Feel that fresh groceries are within reach.',
  unitRelevance: { value: 'incidental', rationale: "The unit is parked nearby but isn't the focus." },
  improvements: 'Added a specific evening setting.',
  constraintsFromAdmin: '',
}

describe('normalizeCreativeBrief', () => {
  it('accepts a well-formed response as-is', () => {
    const result = normalizeCreativeBrief(VALID)
    expect(result).not.toBeNull()
    expect(result!.unitRelevance.value).toBe('incidental')
    expect(result!.coreMessage).toBe(VALID.coreMessage)
  })

  it('accepts each valid unitRelevance.value', () => {
    for (const value of ['central', 'incidental', 'none']) {
      const result = normalizeCreativeBrief({ ...VALID, unitRelevance: { value, rationale: 'x' } })
      expect(result?.unitRelevance.value).toBe(value)
    }
  })

  it('rejects an unknown unitRelevance.value', () => {
    const result = normalizeCreativeBrief({ ...VALID, unitRelevance: { value: 'featured', rationale: 'x' } })
    expect(result).toBeNull()
  })

  it('rejects a missing required string field', () => {
    const { coreMessage: _coreMessage, ...rest } = VALID
    const result = normalizeCreativeBrief(rest)
    expect(result).toBeNull()
  })

  it('rejects a missing unitRelevance entirely', () => {
    const { unitRelevance: _unitRelevance, ...rest } = VALID
    const result = normalizeCreativeBrief(rest)
    expect(result).toBeNull()
  })

  it('rejects non-object input (e.g. a JSON parse failure upstream)', () => {
    expect(normalizeCreativeBrief(null)).toBeNull()
    expect(normalizeCreativeBrief('not json')).toBeNull()
    expect(normalizeCreativeBrief(undefined)).toBeNull()
  })

  it('accepts empty-string optional fields (improvements/constraintsFromAdmin with nothing to say)', () => {
    const result = normalizeCreativeBrief({ ...VALID, improvements: '', constraintsFromAdmin: '' })
    expect(result).not.toBeNull()
    expect(result!.improvements).toBe('')
    expect(result!.constraintsFromAdmin).toBe('')
  })
})
