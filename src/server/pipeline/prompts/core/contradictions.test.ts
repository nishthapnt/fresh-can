import { describe, it, expect } from 'vitest'
import { assertNoContradiction, PromptContradictionError } from './contradictions'
import type { BrandProfile } from '../types'

const testBrand: BrandProfile = {
  name: 'Test Brand',
  missionStatement: 'TEST MISSION STATEMENT',
  voiceGuidelines: 'TEST VOICE GUIDELINES',
  bannedWords: [],
  statistics: [],
  journey: [],
  positiveVisualTruths: [],
  businessModelNegatives: [],
  unit: {
    identity: 'THE FIXED IDENTITY DESCRIPTION',
    full: 'THE FIXED CONTAINER DESCRIPTION',
    interior: 'THE FIXED INTERIOR DESCRIPTION',
  },
  forbiddenOnUnit: [],
  forbiddenInScene: [],
  noTextInstruction: 'NO TEXT INSTRUCTION',
  noNewTextInstruction: 'NO NEW TEXT INSTRUCTION',
  ctaBarText: 'Visit test.example.com',
  typographyDescriptor: 'THE FIXED TYPOGRAPHY DESCRIPTOR',
  ctaBarColorDescriptor: 'THE FIXED CTA BAR COLOR DESCRIPTOR',
  referenceImages: { exterior: [], interior: [] },
}

describe('assertNoContradiction', () => {
  it('does not throw for a prompt with neither the no-text nor the unit-structure text', () => {
    expect(() => assertNoContradiction('A photo of a park bench.', testBrand)).not.toThrow()
  })

  it('does not throw for the no-text instruction alone (unitPresence: none)', () => {
    const prompt = `A photo of a park bench. ${testBrand.noTextInstruction}`
    expect(() => assertNoContradiction(prompt, testBrand)).not.toThrow()
  })

  it('does not throw for the full unit structure alone (unitPresence: featured, real photo attached)', () => {
    const prompt = `${testBrand.unit.full} ${testBrand.noNewTextInstruction}`
    expect(() => assertNoContradiction(prompt, testBrand)).not.toThrow()
  })

  it('does not throw for the identity descriptor alone (unitPresence: background, real photo attached)', () => {
    const prompt = `${testBrand.unit.identity} ${testBrand.noNewTextInstruction}`
    expect(() => assertNoContradiction(prompt, testBrand)).not.toThrow()
  })

  it('throws when the blanket no-text instruction co-occurs with the full unit structure — brief §12\'s historical bug class', () => {
    const prompt = `${testBrand.unit.full} ${testBrand.noTextInstruction}`
    expect(() => assertNoContradiction(prompt, testBrand)).toThrow(PromptContradictionError)
  })

  it('throws when the blanket no-text instruction co-occurs with the identity descriptor', () => {
    const prompt = `${testBrand.unit.identity} ${testBrand.noTextInstruction}`
    expect(() => assertNoContradiction(prompt, testBrand)).toThrow(PromptContradictionError)
  })

  it('error message cites the actual rule (§12), not a generic failure', () => {
    const prompt = `${testBrand.unit.full} ${testBrand.noTextInstruction}`
    expect(() => assertNoContradiction(prompt, testBrand)).toThrow(/§12/)
  })
})
