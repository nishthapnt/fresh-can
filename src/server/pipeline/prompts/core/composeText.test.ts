import { describe, it, expect } from 'vitest'
import {
  composeOutlineSystemPrompt,
  composeCopySystemPrompt,
  composeCaptionSystemPrompt,
  composeAdCopySystemPrompt,
} from './composeText'
import type { BrandProfile } from '../types'

const testBrand: BrandProfile = {
  name: 'Test Brand',
  missionStatement: 'TEST MISSION STATEMENT',
  voiceGuidelines: 'TEST VOICE GUIDELINES',
  bannedWords: ['synergy', 'disrupt'],
  statistics: ['1 in 5 test subjects prefer this fixture'],
  categoryBriefs: { 'Test Category': 'TEST CATEGORY BRIEF' },
  containerDescriptor: 'CONTAINER',
  interiorDescriptor: 'INTERIOR',
  noTextInstruction: 'NO TEXT',
  noNewTextInstruction: 'NO NEW TEXT',
  logoDescriptor: 'LOGO DESCRIPTOR',
  ctaBarText: 'Visit test.example.com',
  typographyDescriptor: 'TYPOGRAPHY DESCRIPTOR',
  ctaBarColorDescriptor: 'CTA BAR COLOR DESCRIPTOR',
  adAngleBriefs: { test_angle: 'TEST ANGLE BRIEF' },
  moods: [{ key: 'a', detail: 'MOOD A' }],
  referenceImages: { exterior: [], interior: [] },
}

describe('composeOutlineSystemPrompt', () => {
  it('keeps the literal phrase "content strategist" (blogPipeline e2e test routes mocks on it)', () => {
    expect(composeOutlineSystemPrompt(testBrand, 'Test Category')).toContain('content strategist')
  })

  it('includes brand mission, voice, banned words, and the category brief', () => {
    const prompt = composeOutlineSystemPrompt(testBrand, 'Test Category')
    expect(prompt).toContain('TEST MISSION STATEMENT')
    expect(prompt).toContain('TEST VOICE GUIDELINES')
    expect(prompt).toContain('synergy')
    expect(prompt).toContain('TEST CATEGORY BRIEF')
  })

  it('omits the category-brief line for a category with no brief configured', () => {
    const prompt = composeOutlineSystemPrompt(testBrand, 'Unknown Category')
    expect(prompt).not.toContain('TEST CATEGORY BRIEF')
    expect(prompt).toContain('TEST MISSION STATEMENT')
  })

  it('bounds section count and requires concrete, non-generic headings/summaries', () => {
    const prompt = composeOutlineSystemPrompt(testBrand, 'Test Category')
    expect(prompt).toContain('exactly 3 to 5 section headings')
    expect(prompt).toContain('concrete and specific to this exact topic')
  })
})

describe('composeCopySystemPrompt', () => {
  it('keeps the literal phrase "from the given outline"', () => {
    const prompt = composeCopySystemPrompt(testBrand, { language: 'EN', category: 'Test Category' })
    expect(prompt).toContain('from the given outline')
  })

  it('preserves the exact JSON schema field names blogEditFromDraft() depends on', () => {
    const prompt = composeCopySystemPrompt(testBrand, { language: 'EN', category: 'Test Category' })
    for (const field of ['post_title', 'post_slug', 'has_inline_image', 'secondary_keywords', 'button_url']) {
      expect(prompt).toContain(field)
    }
  })

  it('includes brand context and the real-stats line', () => {
    const prompt = composeCopySystemPrompt(testBrand, { language: 'EN', category: 'Test Category' })
    expect(prompt).toContain('TEST MISSION STATEMENT')
    expect(prompt).toContain('1 in 5 test subjects prefer this fixture')
  })

  it('splices in regen instructions when present', () => {
    const prompt = composeCopySystemPrompt(testBrand, {
      language: 'EN',
      category: 'Test Category',
      regenInstructions: 'make it punchier',
    })
    expect(prompt).toContain('make it punchier')
  })

  it('gives concrete length targets for introduction/paragraphs/conclusion', () => {
    const prompt = composeCopySystemPrompt(testBrand, { language: 'EN', category: 'Test Category' })
    expect(prompt).toContain('2-4 sentences each')
    expect(prompt).toContain('2-4 paragraphs of 2-4 sentences each')
    expect(prompt).toContain('1-2 short paragraphs')
  })

  it('requires a concrete detail per section and varied sentence openers', () => {
    const prompt = composeCopySystemPrompt(testBrand, { language: 'EN', category: 'Test Category' })
    expect(prompt).toContain('concrete, specific detail')
    expect(prompt).toContain('Do not open consecutive paragraphs the same way')
  })

  it('gives SEO length/placement guidance for meta_description and focus_keyword', () => {
    const prompt = composeCopySystemPrompt(testBrand, { language: 'EN', category: 'Test Category' })
    expect(prompt).toContain('140-160 characters')
    expect(prompt).toContain('focus_keyword must appear in post_title')
  })
})

describe('composeCaptionSystemPrompt', () => {
  it('keeps "caption in {language}" so FR jobs produce a literal "in FR" substring', () => {
    const prompt = composeCaptionSystemPrompt(testBrand, { language: 'FR' })
    expect(prompt).toContain('in FR')
  })

  it('does not include location guidance', () => {
    const prompt = composeCaptionSystemPrompt(testBrand, { language: 'EN' })
    expect(prompt).not.toContain('locally relevant')
    expect(prompt).not.toContain('location-relevant')
  })

  it('splices in the angle brief when the job has a selected content_angle', () => {
    const prompt = composeCaptionSystemPrompt(testBrand, { language: 'EN', angleBrief: 'TEST ANGLE BRIEF' })
    expect(prompt).toContain('TEST ANGLE BRIEF')
  })

  it('tells the caption what the image already renders, and asks it to reinforce rather than repeat it', () => {
    const prompt = composeCaptionSystemPrompt(testBrand, {
      language: 'EN',
      imageHeadline: 'FRESH FOOD NEARBY',
      imageSubtitle: 'Every neighbourhood deserves it',
      imageCoreMessage: 'A family finds fresh produce close to home.',
    })
    expect(prompt).toContain('FRESH FOOD NEARBY')
    expect(prompt).toContain('Every neighbourhood deserves it')
    expect(prompt).toContain('A family finds fresh produce close to home.')
    expect(prompt).toContain('do not simply repeat the headline verbatim')
  })

  it('omits all image-cohesion guidance for a plain "photo"-style job (no imageHeadline given)', () => {
    const prompt = composeCaptionSystemPrompt(testBrand, { language: 'EN' })
    expect(prompt).not.toContain('already has this text rendered')
  })
})

describe('composeAdCopySystemPrompt', () => {
  it('asks for the exact headline/subtitle/coreMessage JSON shape generateAdCopy.ts depends on', () => {
    const prompt = composeAdCopySystemPrompt(testBrand, { category: 'Test Category' })
    for (const field of ['headline', 'subtitle', 'coreMessage']) {
      expect(prompt).toContain(field)
    }
  })

  it('includes brand context and the category brief', () => {
    const prompt = composeAdCopySystemPrompt(testBrand, { category: 'Test Category' })
    expect(prompt).toContain('TEST MISSION STATEMENT')
    expect(prompt).toContain('TEST CATEGORY BRIEF')
  })

  it('splices in the angle brief when given', () => {
    const prompt = composeAdCopySystemPrompt(testBrand, { category: 'Test Category', angleBrief: 'TEST ANGLE BRIEF' })
    expect(prompt).toContain('TEST ANGLE BRIEF')
  })

  it('omits any angle-focus line when no angle brief is given', () => {
    const prompt = composeAdCopySystemPrompt(testBrand, { category: 'Test Category' })
    expect(prompt).not.toContain('This specific post should focus on')
  })
})
