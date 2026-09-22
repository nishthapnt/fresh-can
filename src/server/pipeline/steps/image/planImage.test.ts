import { describe, it, expect } from 'vitest'
import { normalizeImagePostPlan } from './planImage'

const VALID_PHOTO = {
  designIntent: 'Show a family finding fresh produce easily.',
  subject: 'A mother and daughter picking fruit.',
  composition: 'Medium shot, warm natural light, negative space upper-right.',
  unitPresence: 'background',
  setting: 'exterior',
  containsFood: true,
  textPlan: null,
}

const VALID_INFOGRAPHIC = {
  ...VALID_PHOTO,
  textPlan: { headline: 'Fresh Food, Closer Than Ever', subtitle: 'Find a unit near you' },
}

describe('normalizeImagePostPlan', () => {
  it('accepts a well-formed photo-style plan (textPlan null)', () => {
    const result = normalizeImagePostPlan(VALID_PHOTO)
    expect(result).not.toBeNull()
    expect(result!.textPlan).toBeNull()
    expect(result!.safeZone).toBe('top-right')
  })

  it('accepts a well-formed infographic-style plan (textPlan populated)', () => {
    const result = normalizeImagePostPlan(VALID_INFOGRAPHIC)
    expect(result).not.toBeNull()
    expect(result!.textPlan).toEqual({ headline: 'Fresh Food, Closer Than Ever', subtitle: 'Find a unit near you' })
  })

  it('accepts each valid unitPresence/setting value', () => {
    for (const unitPresence of ['none', 'background', 'featured']) {
      expect(normalizeImagePostPlan({ ...VALID_PHOTO, unitPresence })?.unitPresence).toBe(unitPresence)
    }
    for (const setting of ['exterior', 'interior', 'unrelated']) {
      expect(normalizeImagePostPlan({ ...VALID_PHOTO, setting })?.setting).toBe(setting)
    }
  })

  it('rejects an unknown unitPresence/setting value', () => {
    expect(normalizeImagePostPlan({ ...VALID_PHOTO, unitPresence: 'featured_always' })).toBeNull()
    expect(normalizeImagePostPlan({ ...VALID_PHOTO, setting: 'outer_space' })).toBeNull()
  })

  it('rejects a missing required field', () => {
    const { subject: _subject, ...rest } = VALID_PHOTO
    expect(normalizeImagePostPlan(rest)).toBeNull()
  })

  it('rejects containsFood as a non-boolean', () => {
    expect(normalizeImagePostPlan({ ...VALID_PHOTO, containsFood: 'yes' })).toBeNull()
  })

  it('treats a malformed textPlan object (missing headline/subtitle) as null rather than failing the whole plan', () => {
    const result = normalizeImagePostPlan({ ...VALID_PHOTO, textPlan: { headline: 'Only headline' } })
    expect(result).not.toBeNull()
    expect(result!.textPlan).toBeNull()
  })

  it('omits castDescription when empty or absent, keeps it when present', () => {
    expect(normalizeImagePostPlan(VALID_PHOTO)?.castDescription).toBeUndefined()
    expect(normalizeImagePostPlan({ ...VALID_PHOTO, castDescription: '' })?.castDescription).toBeUndefined()
    expect(normalizeImagePostPlan({ ...VALID_PHOTO, castDescription: 'A mother and daughter' })?.castDescription).toBe(
      'A mother and daughter',
    )
  })

  it('rejects non-object input', () => {
    expect(normalizeImagePostPlan(null)).toBeNull()
    expect(normalizeImagePostPlan('not json')).toBeNull()
  })
})
