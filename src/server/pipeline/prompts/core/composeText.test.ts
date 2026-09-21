import { describe, it, expect } from 'vitest'
import {
  composeOutlineSystemPrompt,
  composeCopySystemPrompt,
  composeCaptionSystemPrompt,
  composeAdCopySystemPrompt,
  composeVideoScriptSystemPrompt,
  composeLocalizeScriptSystemPrompt,
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

  it('treats the scene idea as the creative brief the outline is built around, not light inspiration', () => {
    // Regression test: scene_notes flipped from "let it lightly inform...
    // without forcing it" to being the thing the outline is built around,
    // with brand mission/voice reframed as a tone/accuracy constraint.
    const prompt = composeOutlineSystemPrompt(testBrand, 'Test Category', 'A senior reaching a mobile unit at dusk')
    expect(prompt).toContain('A senior reaching a mobile unit at dusk')
    expect(prompt).toContain('decides what this post is actually about')
    expect(prompt).not.toContain('lightly inform')
    expect(prompt).not.toContain('optionally shared')
  })

  it('omits the scene-idea clause entirely when none is given (pre-existing job with no scene_notes)', () => {
    const prompt = composeOutlineSystemPrompt(testBrand, 'Test Category')
    expect(prompt).not.toContain('creative idea for the post')
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

  it('treats the scene idea as a binding brief the copy must stay true to, not light inspiration', () => {
    const prompt = composeCopySystemPrompt(testBrand, {
      language: 'EN',
      category: 'Test Category',
      sceneNotes: 'A senior reaching a mobile unit at dusk',
    })
    expect(prompt).toContain('A senior reaching a mobile unit at dusk')
    expect(prompt).toContain('must stay true to')
    expect(prompt).not.toContain('lightly inform')
    expect(prompt).not.toContain('optionally shared')
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

  it('tells the caption what specific moment the accompanying photo depicts, when given', () => {
    // Regression test: the caption used to be built from nothing but
    // topic/category/angleBrief, so it could describe a generic take while
    // the photo (built from the now-mandatory scene idea) depicted a
    // specific, different moment.
    const prompt = composeCaptionSystemPrompt(testBrand, {
      language: 'EN',
      scene: 'A senior reaching a mobile unit at dusk',
    })
    expect(prompt).toContain('A senior reaching a mobile unit at dusk')
    expect(prompt).toContain('this same moment')
  })

  it('omits the scene clause when none is given (pre-existing job with no scene_notes)', () => {
    const prompt = composeCaptionSystemPrompt(testBrand, { language: 'EN' })
    expect(prompt).not.toContain('depicts this specific moment')
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

  it('tells the model what specific moment the accompanying photo depicts, when given', () => {
    const prompt = composeAdCopySystemPrompt(testBrand, {
      category: 'Test Category',
      scene: 'A senior reaching a mobile unit at dusk',
    })
    expect(prompt).toContain('A senior reaching a mobile unit at dusk')
    expect(prompt).toContain('this same moment')
  })
})

describe('composeVideoScriptSystemPrompt', () => {
  const baseOpts = { category: 'Test Category', scriptType: 'SOLUTION', targetDurationSeconds: 36 }

  it('includes brand context, the category brief, and the target duration', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).toContain('TEST MISSION STATEMENT')
    expect(prompt).toContain('TEST CATEGORY BRIEF')
    expect(prompt).toContain('approximately 36')
  })

  it('requires the scene plan JSON shape generateScript.ts depends on', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    for (const field of ['scene_number', 'visual_description', 'shot_notes', 'narration_intent', 'target_duration_seconds']) {
      expect(prompt).toContain(field)
    }
  })

  it('tells the model narration_intent must stay semantic, never literal wording in one language', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).toContain('NEVER write it as a finished sentence in any one language')
  })

  it('unconditionally steers the video and its scenes away from reading as an ad or commercial', () => {
    // This must hold even with no scene idea given (a pre-existing job) —
    // it is the general anti-ad instruction, not scene-idea-dependent.
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).toContain('never scripted ad copy, a corporate promo, or a polished commercial')
  })

  it('requires every scene\'s setting to be physically plausible and safe — regression for a real generation showing people eating dinner in the middle of a road', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).toContain('physically plausible and safe')
    expect(prompt).toContain('middle of an active road')
  })

  it('asks for real cinematographic shot variety and camera direction, as a quality bar rather than a style directive', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).toContain('wide establishing shots, medium shots, close-ups, over-the-shoulder, tracking shots')
    expect(prompt).toContain('never a directive on what mood or overall style to use')
  })

  it('requires shot_notes to carry real camera direction, not default to empty', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).toContain('never left empty by default')
  })

  it('asks visual_description to include ambient environmental motion, not just the subject', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).toContain('steam rising, wind moving leaves or fabric, light shifting')
  })

  it('tells the model to creatively expand a brief idea instead of leaving it thin, without inventing unrelated content', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).toContain('expand it creatively into specific, vivid visual detail')
    expect(prompt).toContain('never a generic or unrelated addition')
  })

  it('forbids inventing props/vehicles/people that serve no purpose in the story', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).toContain('Do not invent a prop, vehicle, building, or person that serves no purpose')
    expect(prompt).toContain('if removing it would not harm the story, do not add it')
  })

  it('asks for continuity of characters/clothing/setting across scenes that share a moment', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).toContain('Maintain natural continuity across scenes')
  })

  it('tells the model the vehicle appearing in one scene is never a reason to carry it into a later scene, when a scene idea is given', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, {
      ...baseOpts,
      sceneNotes: 'A family discovers a mobile grocery unit, then goes home to cook dinner',
    })
    expect(prompt).toContain('never a reason to carry it into a later scene')
  })

  it('treats a given scene idea as the creative brief the story and every scene are built around, leading the prompt rather than trailing at the very end', () => {
    // Regression test: a real generation given a fully unrelated scene idea
    // (a family's cozy autumn dinner, no Fresh-CAN mention at all) ignored
    // it and wrote a generic Fresh-CAN mission/food-desert pitch instead —
    // the old wording appended the scene idea as a single sentence AFTER
    // the brand's full mission, category brief, and stats, which wasn't
    // enough to override all that priming. The idea must now appear before
    // (earlier in the string than) the brand's mission statement, and the
    // category brief/statistics must be dropped entirely rather than
    // presented as a second, competing angle.
    const prompt = composeVideoScriptSystemPrompt(testBrand, {
      ...baseOpts,
      sceneNotes: 'A senior reaching a mobile unit at dusk',
    })
    expect(prompt).toContain('A senior reaching a mobile unit at dusk')
    expect(prompt).toContain('background context for tone and brand accuracy only')
    expect(prompt.indexOf('A senior reaching a mobile unit at dusk')).toBeLessThan(prompt.indexOf('TEST MISSION STATEMENT'))
    expect(prompt).not.toContain('TEST CATEGORY BRIEF')
    expect(prompt).not.toContain('1 in 5 test subjects prefer this fixture')
  })

  it('still carries voice/tone guidance (banned words) even when the category brief and stats are dropped for a given scene idea', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, {
      ...baseOpts,
      sceneNotes: 'A senior reaching a mobile unit at dusk',
    })
    expect(prompt).toContain('TEST VOICE GUIDELINES')
    expect(prompt).toContain('synergy')
  })

  it('uses neutralIdentityLine instead of the fuller missionStatement when both a scene idea and neutralIdentityLine are given', () => {
    // Regression test: a real generation given a scene idea entirely
    // unrelated to food deserts (a family's autumn dinner) still mentioned
    // "food desert communities" — traced to missionStatement's own fuller,
    // topic-adjacent framing being quoted verbatim as "background context."
    // neutralIdentityLine exists specifically to avoid restating that kind
    // of mission/topic language when the scene idea is what actually
    // decides the story.
    const brandWithNeutralLine = { ...testBrand, neutralIdentityLine: 'TEST NEUTRAL IDENTITY LINE' }
    const prompt = composeVideoScriptSystemPrompt(brandWithNeutralLine, {
      ...baseOpts,
      sceneNotes: 'A cozy autumn family dinner',
    })
    expect(prompt).toContain('TEST NEUTRAL IDENTITY LINE')
    expect(prompt).not.toContain('TEST MISSION STATEMENT')
  })

  it('falls back to missionStatement when neutralIdentityLine is not configured for the brand', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, {
      ...baseOpts,
      sceneNotes: 'A cozy autumn family dinner',
    })
    expect(prompt).toContain('TEST MISSION STATEMENT')
  })

  it('omits the scene-idea clause entirely when none is given (pre-existing job with no scene_notes)', () => {
    const prompt = composeVideoScriptSystemPrompt(testBrand, baseOpts)
    expect(prompt).not.toContain("user's own creative idea")
  })

  it('requires BOTH a genuine connection to Fresh-CAN\'s mission AND an explicit, spoken mention of the Fresh-CAN name — regression for two real generations in a row that had no recognizable connection to the brand (first: none at all; second: the name treated as merely "ideal" and never actually said)', () => {
    // 2026-09-21, three rounds the same day: (1) pure reassurance ("warmth/
    // community already qualifies") was too soft — zero connection. (2)
    // required a connection but called the literal name merely "ideal,
    // one option among several" — still let the model satisfy it with vague
    // "fresh/local" language and never say "Fresh-CAN". (3) this version:
    // the name is now a hard requirement, layered on top of (not instead
    // of) the substantive mission connection — still distinguished from the
    // still-forbidden old bug (reciting the mission statement/statistics,
    // or forcing the vehicle into a scene it doesn't fit).
    const prompt = composeVideoScriptSystemPrompt(testBrand, {
      ...baseOpts,
      sceneNotes: 'A senior reaching a mobile unit at dusk',
    })
    expect(prompt).toContain('required, not optional')
    expect(prompt).toContain('fresh, affordable, local groceries directly into communities')
    expect(prompt).toContain('the Fresh-CAN name itself must be said explicitly, out loud')
    expect(prompt).toContain('REQUIRED, not merely ideal')
    expect(prompt).toContain('never satisfied by "fresh" or ')
    expect(prompt).toContain('never a slogan, statistic, or pitch stated on top of the scene')
    // Still coexists with (appears after, never replaces) the original
    // anti-hijack rule.
    expect(prompt.indexOf('never a reason to insert brand or mission messaging')).toBeLessThan(
      prompt.indexOf('does not mean the story can ignore Fresh-CAN'),
    )
  })
})

describe('composeLocalizeScriptSystemPrompt', () => {
  it('keeps "in {language}" so FR tracks produce a literal "in French" substring', () => {
    const prompt = composeLocalizeScriptSystemPrompt(testBrand, { language: 'French' })
    expect(prompt).toContain('in French')
  })

  it('tells the model to write natural spoken narration, never scripted ad copy', () => {
    const prompt = composeLocalizeScriptSystemPrompt(testBrand, { language: 'English' })
    expect(prompt).toContain('never as scripted ad copy or a voiceover that sounds like a commercial')
  })

  it('preserves the exact JSON schema field names localizeScript.ts depends on', () => {
    const prompt = composeLocalizeScriptSystemPrompt(testBrand, { language: 'English' })
    for (const field of ['scene_number', 'narration_text']) {
      expect(prompt).toContain(field)
    }
  })
})
