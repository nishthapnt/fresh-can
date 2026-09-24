import { describe, it, expect } from 'vitest'
import {
  composeHeroPrompt,
  composeInlinePrompt,
  composePhotoPrompt,
  composeSceneImagePrompt,
  composeSceneImageEditPrompt,
  composeSceneVideoPrompt,
  composeCharacterRefPrompt,
} from './compose'
import type { BrandProfile } from '../types'
import { BRAND_PROFILE } from '../brand/fresh-can'

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
    wordmarkText: 'THE FIXED WORDMARK',
  },
  forbiddenOnUnit: [],
  forbiddenInScene: [],
  noTextInstruction: 'NO TEXT INSTRUCTION',
  noNewTextInstruction: 'NO NEW TEXT INSTRUCTION',
  ctaBarText: 'Visit test.example.com',
  typographyDescriptor: 'THE FIXED TYPOGRAPHY DESCRIPTOR',
  ctaBarColorDescriptor: 'THE FIXED CTA BAR COLOR DESCRIPTOR',
  // interior deliberately empty here — pickSceneType falls back to
  // exterior-only when interior has no photos, so every existing test
  // below (written before interior support existed) keeps working as-is.
  referenceImages: {
    exterior: [{ url: 'https://example.com/exterior.jpg', whatItShows: 'FRAMING A', disregard: [] }],
    interior: [],
  },
}

const multiAngleBrand: BrandProfile = {
  ...testBrand,
  referenceImages: {
    exterior: [
      { url: 'https://example.com/back.jpg', whatItShows: 'FRAMING BACK', disregard: [] },
      { url: 'https://example.com/arrival.jpg', whatItShows: 'FRAMING ARRIVAL', disregard: [] },
      { url: 'https://example.com/standing.jpg', whatItShows: 'FRAMING STANDING', disregard: [] },
    ],
    interior: [],
  },
}

const bothScenesBrand: BrandProfile = {
  ...testBrand,
  referenceImages: {
    exterior: [{ url: 'https://example.com/ext.jpg', whatItShows: 'FRAMING EXT', disregard: [] }],
    interior: [{ url: 'https://example.com/int.jpg', whatItShows: 'FRAMING INT', disregard: [] }],
  },
}

describe('composeHeroPrompt / composeInlinePrompt', () => {
  it('uses the same neutral default mood for hero and inline (no per-brand mood rotation — PROMPT_REFACTOR_BRIEF.md §6.3)', () => {
    const job = { pipelineId: 'pipeline-1', topic: 'Winter grocery access', category: 'Food Desert Education' }
    const hero = composeHeroPrompt(testBrand, job)
    const inline = composeInlinePrompt(testBrand, job)
    expect(hero.prompt).toContain('If unspecified, default mood:')
    expect(inline.prompt).toContain('If unspecified, default mood:')
  })

  it('is stable across repeated calls for the same pipeline id (retry-safe)', () => {
    const job = { pipelineId: 'pipeline-2', topic: 'Community garden', category: 'Community Impact' }
    const first = composeHeroPrompt(testBrand, job)
    const second = composeHeroPrompt(testBrand, job)
    expect(first.prompt).toBe(second.prompt)
  })

  it('includes the shared photorealistic-quality floor, same as every other image composer', () => {
    const job = { pipelineId: 'pipeline-quality', topic: 'Community garden', category: 'Community Impact' }
    const hero = composeHeroPrompt(testBrand, job)
    const inline = composeInlinePrompt(testBrand, job)
    expect(hero.prompt).toContain('Premium photorealistic commercial photography')
    expect(inline.prompt).toContain('Premium photorealistic commercial photography')
  })

  it('folds the outline\'s headline into the scene description when given, for photo style too', () => {
    const job = {
      pipelineId: 'pipeline-headline',
      topic: 'Community garden',
      category: 'Community Impact',
      headline: 'Neighbours Grow Together',
    }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toContain('Neighbours Grow Together')
  })

  it('treats the scene idea as the creative brief the image is built around, not light inspiration', () => {
    const job = {
      pipelineId: 'pipeline-scene-brief',
      topic: 'Community garden fundraiser',
      category: 'Community Impact',
      sceneNotes: 'A senior reaching a mobile unit at dusk',
    }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toContain('A senior reaching a mobile unit at dusk')
    expect(hero.prompt).toContain('creative direction for the image')
    expect(hero.prompt).toContain('never as the reason this scene exists')
    expect(hero.prompt).not.toContain('For light inspiration only')
  })

  it('requires any food/produce/groceries shown to look clean and fresh, never dirty', () => {
    const job = { pipelineId: 'pipeline-food-clean', topic: 'Community garden fundraiser', category: 'Community Impact' }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toContain('clean, fresh, tidy, and appetizing')
    expect(hero.prompt).toContain('Never render food looking dirty, rotten, messy, or unappetizing')
  })

  it('omits the headline clause entirely when none is given (backward compatible)', () => {
    const job = { pipelineId: 'pipeline-no-headline', topic: 'Community garden', category: 'Community Impact' }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).not.toContain('about "')
  })

  it('reserves the top-right watermark safe zone (PROMPT_REFACTOR_BRIEF.md §10)', () => {
    const job = { pipelineId: 'pipeline-safe-zone', topic: 'Community garden', category: 'Community Impact' }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toContain('top-right corner')
    expect(hero.prompt).toContain('logo is composited into that corner')
  })

  describe('referenceCopy (PROMPT_REFACTOR_BRIEF.md §9.3)', () => {
    const referenceCopy = {
      coreMessage: 'A mobile grocery store makes fresh food genuinely reachable, no matter the neighbourhood.',
      inlineHighlight: {
        heading: 'A Real Family',
        visualMoment: 'A mother and her two kids carrying grocery bags out the rear doors at golden hour.',
      },
    }

    it('grounds the hero image in the whole article\'s core message', () => {
      const job = { pipelineId: 'pipeline-ref-hero', topic: 'Community garden', category: 'Community Impact', referenceCopy }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).toContain(referenceCopy.coreMessage)
      expect(hero.prompt).not.toContain(referenceCopy.inlineHighlight.visualMoment)
    })

    it('grounds the inline image in its own section\'s visual moment, never the hero\'s core message', () => {
      const job = { pipelineId: 'pipeline-ref-inline', topic: 'Community garden', category: 'Community Impact', referenceCopy }
      const inline = composeInlinePrompt(testBrand, job)
      expect(inline.prompt).toContain(referenceCopy.inlineHighlight.visualMoment)
      expect(inline.prompt).toContain(referenceCopy.inlineHighlight.heading)
      expect(inline.prompt).not.toContain(referenceCopy.coreMessage)
    })

    it('omits the reference-copy line entirely when none is given (legacy caller predating Phase 6)', () => {
      const job = { pipelineId: 'pipeline-ref-none', topic: 'Community garden', category: 'Community Impact' }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).not.toContain('core message')
    })

    it('omits the inline reference-copy line when the fallback left no real visual moment (no-sections case)', () => {
      const job = {
        pipelineId: 'pipeline-ref-empty',
        topic: 'Community garden',
        category: 'Community Impact',
        referenceCopy: { coreMessage: 'A Pre-existing Post', inlineHighlight: { heading: '', visualMoment: '' } },
      }
      const inline = composeInlinePrompt(testBrand, job)
      expect(inline.prompt).not.toContain('visual moment')
    })
  })

  describe('unitPresence: none (default when omitted)', () => {
    it('omits the reference image and uses the generic non-unit hint', () => {
      const job = { pipelineId: 'pipeline-3', topic: 'Community garden fundraiser', category: 'Community Impact' }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.referenceImageUrl).toBeUndefined()
      expect(hero.prompt).toContain('does not involve the Test Brand unit')
    })

    it('uses the strict no-text instruction (no unit branding text to reconcile with)', () => {
      const job = { pipelineId: 'pipeline-none-text', topic: 'Community garden', category: 'Community Impact' }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).toContain('NO TEXT INSTRUCTION')
      expect(hero.prompt).not.toContain('NO NEW TEXT INSTRUCTION')
    })
  })

  describe('unitPresence: background', () => {
    it('permits the brand vehicle as an incidental background element, but never as the compositional focus, using the identity tier and no reference photo pool switch to interior', () => {
      const job = {
        pipelineId: 'pipeline-hint-brand',
        topic: 'Community garden fundraiser',
        category: 'Community Impact',
        unitPresence: 'background' as const,
      }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).toContain('THE FIXED IDENTITY DESCRIPTION')
      expect(hero.prompt).toContain('never as the compositional focus')
      expect(hero.prompt).not.toContain('THE FIXED INTERIOR DESCRIPTION')
    })

    it('never sends the blanket no-text instruction alongside text that permits the vehicle in the background — no contradiction (brief §12)', () => {
      const job = {
        pipelineId: 'pipeline-no-contradiction',
        topic: 'Community garden fundraiser',
        category: 'Community Impact',
        unitPresence: 'background' as const,
      }
      const brandNoPhotos: BrandProfile = { ...testBrand, referenceImages: { exterior: [], interior: [] } }
      const hero = composeHeroPrompt(brandNoPhotos, job)
      expect(hero.prompt).not.toContain('NO TEXT INSTRUCTION')
      expect(hero.prompt).toMatch(/never place the .* wordmark or logo on any other vehicle or object/i)
      expect(hero.referenceImageUrl).toBeUndefined()
    })

    it('still includes the default mood clause and the job-specific topic line', () => {
      const job = {
        pipelineId: 'pipeline-hint-3',
        topic: 'Community garden fundraiser',
        category: 'Community Impact',
        unitPresence: 'background' as const,
      }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).toContain('Community garden fundraiser')
      expect(hero.prompt).toContain('If unspecified, default mood:')
    })

    it('attaches an exterior reference photo (background never picks interior)', () => {
      const job = {
        pipelineId: 'pipeline-bg-exterior',
        topic: 'Community garden fundraiser',
        category: 'Community Impact',
        unitPresence: 'background' as const,
      }
      const hero = composeHeroPrompt(bothScenesBrand, job)
      expect(hero.referenceImageUrl).toBe('https://example.com/ext.jpg')
    })
  })

  describe('unitPresence: featured', () => {
    it('includes the full container descriptor and attaches a reference image', () => {
      const job = {
        pipelineId: 'pipeline-4',
        topic: 'Scanning in at the unit',
        category: 'How FreshCAN Works',
        unitPresence: 'featured' as const,
      }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
      expect(hero.referenceImageUrl).toBe('https://example.com/exterior.jpg')
    })

    it('uses the unit-branding-exception no-text instruction when no reference photos are configured at all — avoids contradicting its own "must be built to this structure" text (brief §12)', () => {
      const brandWithNoPhotos: BrandProfile = { ...testBrand, referenceImages: { exterior: [], interior: [] } }
      const job = {
        pipelineId: 'pipeline-5',
        topic: 'Scanning in at the unit',
        category: 'How FreshCAN Works',
        unitPresence: 'featured' as const,
      }
      const hero = composeHeroPrompt(brandWithNoPhotos, job)
      expect(hero.prompt).toContain("the unit's own real wordmark, exactly as described above")
      expect(hero.prompt).not.toContain('NO TEXT INSTRUCTION')
      expect(hero.prompt).not.toContain('NO NEW TEXT INSTRUCTION')
      expect(hero.referenceImageUrl).toBeUndefined()
    })

    it('uses the preserve-real-signage instruction instead, once a reference image is attached', () => {
      const job = {
        pipelineId: 'pipeline-6',
        topic: 'Scanning in at the unit',
        category: 'How FreshCAN Works',
        unitPresence: 'featured' as const,
      }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.referenceImageUrl).toBeDefined()
      expect(hero.prompt).toContain('NO NEW TEXT INSTRUCTION')
      expect(hero.prompt).not.toContain('NO TEXT INSTRUCTION ')
    })

    it('never mismatches a framing description with a different photo\'s URL', () => {
      const byUrl = new Map(multiAngleBrand.referenceImages.exterior.map((r) => [r.url, r.whatItShows]))
      for (let i = 0; i < 20; i++) {
        const job = {
          pipelineId: `pipeline-multi-${i}`,
          topic: 'Scanning in at the unit',
          category: 'How FreshCAN Works',
          unitPresence: 'featured' as const,
        }
        const hero = composeHeroPrompt(multiAngleBrand, job)
        expect(hero.referenceImageUrl).toBeDefined()
        const expectedFraming = byUrl.get(hero.referenceImageUrl!)
        expect(hero.prompt).toContain(expectedFraming)
      }
    })

    it('lets hero and inline land on different camera angles for the same pipeline', () => {
      let sawDifference = false
      for (let i = 0; i < 20; i++) {
        const job = {
          pipelineId: `pipeline-diff-${i}`,
          topic: 'Scanning in at the unit',
          category: 'How FreshCAN Works',
          unitPresence: 'featured' as const,
        }
        const hero = composeHeroPrompt(multiAngleBrand, job)
        const inline = composeInlinePrompt(multiAngleBrand, job)
        if (hero.referenceImageUrl !== inline.referenceImageUrl) sawDifference = true
      }
      expect(sawDifference).toBe(true)
    })

    it('never pairs the interior descriptor/photo with the exterior descriptor/photo, or vice versa', () => {
      for (let i = 0; i < 20; i++) {
        const job = {
          pipelineId: `pipeline-scene-${i}`,
          topic: 'Touring the unit',
          category: 'Community Impact',
          unitPresence: 'featured' as const,
        }
        const hero = composeHeroPrompt(bothScenesBrand, job)
        const isInterior = hero.referenceImageUrl === 'https://example.com/int.jpg'
        const isExterior = hero.referenceImageUrl === 'https://example.com/ext.jpg'
        expect(isInterior || isExterior).toBe(true)
        if (isInterior) {
          expect(hero.prompt).toContain('THE FIXED INTERIOR DESCRIPTION')
          expect(hero.prompt).toContain('FRAMING INT')
          expect(hero.prompt).not.toContain('THE FIXED CONTAINER DESCRIPTION')
          expect(hero.prompt).not.toContain('FRAMING EXT')
        } else {
          expect(hero.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
          expect(hero.prompt).toContain('FRAMING EXT')
          expect(hero.prompt).not.toContain('THE FIXED INTERIOR DESCRIPTION')
          expect(hero.prompt).not.toContain('FRAMING INT')
        }
      }
    })

    it('picks both exterior and interior scenes across enough pipelines (not stuck on one)', () => {
      const sceneTypesSeen = new Set<string>()
      for (let i = 0; i < 30; i++) {
        const job = {
          pipelineId: `pipeline-scene-variety-${i}`,
          topic: 'Touring the unit',
          category: 'Community Impact',
          unitPresence: 'featured' as const,
        }
        const hero = composeHeroPrompt(bothScenesBrand, job)
        sceneTypesSeen.add(hero.referenceImageUrl === 'https://example.com/int.jpg' ? 'interior' : 'exterior')
      }
      expect(sceneTypesSeen.size).toBe(2)
    })

    it('falls back to exterior-only when no interior photos are configured (existing brands keep working)', () => {
      const job = {
        pipelineId: 'pipeline-fallback-1',
        topic: 'Touring the unit',
        category: 'Community Impact',
        unitPresence: 'featured' as const,
      }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
      expect(hero.referenceImageUrl).toBe('https://example.com/exterior.jpg')
    })

    it('falls back to interior-only when no exterior photos are configured', () => {
      const interiorOnlyBrand: BrandProfile = {
        ...testBrand,
        referenceImages: {
          exterior: [],
          interior: [{ url: 'https://example.com/int-only.jpg', whatItShows: 'FRAMING INT ONLY', disregard: [] }],
        },
      }
      const job = {
        pipelineId: 'pipeline-fallback-2',
        topic: 'Touring the unit',
        category: 'Community Impact',
        unitPresence: 'featured' as const,
      }
      const hero = composeHeroPrompt(interiorOnlyBrand, job)
      expect(hero.prompt).toContain('THE FIXED INTERIOR DESCRIPTION')
      expect(hero.referenceImageUrl).toBe('https://example.com/int-only.jpg')
    })
  })

  it('image_style "infographic" renders headline/subtitle/CTA instead of the no-text instructions', () => {
    const job = {
      pipelineId: 'pipeline-info-1',
      topic: 'How to shop at the unit',
      category: 'Community Impact',
      imageStyle: 'infographic' as const,
      headline: 'Fresh Food, Closer To Home',
      subtitle: 'A smarter way to shop',
    }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toContain('Fresh Food, Closer To Home')
    expect(hero.prompt).toContain('A smarter way to shop')
    expect(hero.prompt).toContain('Visit test.example.com')
    expect(hero.prompt).toContain('THE FIXED TYPOGRAPHY DESCRIPTOR')
    expect(hero.prompt).toContain('THE FIXED CTA BAR COLOR DESCRIPTOR')
    expect(hero.prompt).not.toContain('NO TEXT INSTRUCTION')
    expect(hero.prompt).not.toContain('NO NEW TEXT INSTRUCTION')
  })

  it('throws if image_style "infographic" is used without both headline and subtitle', () => {
    const job = {
      pipelineId: 'pipeline-info-2',
      topic: 'How to shop at the unit',
      category: 'Community Impact',
      imageStyle: 'infographic' as const,
      headline: 'Fresh Food, Closer To Home',
      // subtitle missing
    }
    expect(() => composeHeroPrompt(testBrand, job)).toThrow()
  })

  it('defaults to "photo" style (no text) when imageStyle is omitted', () => {
    const job = {
      pipelineId: 'pipeline-info-3',
      topic: 'Scanning in at the unit',
      category: 'How FreshCAN Works',
      unitPresence: 'featured' as const,
    }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toMatch(/NO( NEW)? TEXT INSTRUCTION/)
  })

  describe('non-container scenes (no per-category canned direction)', () => {
    // categoryVisualHints (per-category canned creative direction) was
    // removed (PROMPT_REFACTOR_BRIEF.md §6.2) — every non-container scene
    // now gets the same brand-agnostic hint regardless of category.
    it('gives every category the same generic documentary-photo hint', () => {
      const job = { pipelineId: 'pipeline-hint-2', topic: 'Community garden fundraiser', category: 'Community Impact' }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).toContain('Photorealistic documentary-style photo')
      expect(hero.referenceImageUrl).toBeUndefined()
    })
  })
})

describe('composePhotoPrompt', () => {
  const baseJob = {
    pipelineId: 'pipeline-photo-1',
    topic: 'Grocery access in Kincora',
    category: 'Community Impact',
  }

  it('shows the container when the plan says unitPresence: featured', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic, unitPresence: 'featured' })
    expect(photo.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
    expect(photo.referenceImageUrl).toBe('https://example.com/exterior.jpg')
  })

  it('omits the container when the plan says unitPresence: none (default when omitted)', () => {
    const photo = composePhotoPrompt(testBrand, {
      ...baseJob,
      topic: 'Sweet PEI summer strawberries and corn',
      scene: 'fresh strawberries and corn from local farms',
    })
    expect(photo.prompt).not.toContain('THE FIXED CONTAINER DESCRIPTION')
    expect(photo.prompt).toContain('does not involve the Test Brand unit')
    expect(photo.referenceImageUrl).toBeUndefined()
  })

  it('includes the shared photorealistic-quality floor, same as every other image composer', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic, unitPresence: 'none' })
    expect(photo.prompt).toContain('Premium photorealistic commercial photography')
  })

  it('image_style "infographic" renders headline/subtitle/CTA instead of the no-text instructions', () => {
    const photo = composePhotoPrompt(testBrand, {
      ...baseJob,
      scene: baseJob.topic,
      imageStyle: 'infographic',
      headline: 'Fresh Food, Closer To Home',
      subtitle: 'A smarter way to shop',
    })
    expect(photo.prompt).toContain('Fresh Food, Closer To Home')
    expect(photo.prompt).toContain('A smarter way to shop')
    expect(photo.prompt).toContain('Visit test.example.com')
    expect(photo.prompt).not.toContain('NO TEXT INSTRUCTION')
    expect(photo.prompt).not.toContain('NO NEW TEXT INSTRUCTION')
  })

  it('tells the model the reference photo is a shape/color guide, never a literal copy', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic, unitPresence: 'featured' })
    expect(photo.prompt).toContain('only as a guide')
    expect(photo.prompt).toContain('never as a literal photo to copy')
  })

  it('tells the model brand details are constraints, not the point of the photo, and never dictate style/mood/composition', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic })
    expect(photo.prompt).toContain('never as the reason this scene exists')
    expect(photo.prompt).toContain('never as a directive about the overall photographic style, mood, or composition')
  })

  it('requires any food/produce/groceries shown to look clean and fresh, never dirty (containsFood defaults to true when the plan is absent/unsure)', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic })
    expect(photo.prompt).toContain('clean, fresh, tidy, and appetizing')
    expect(photo.prompt).toContain('Never render food looking dirty, rotten, messy, or unappetizing')
  })

  it('omits the food-quality block when the plan says containsFood: false', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic, containsFood: false })
    expect(photo.prompt).not.toContain('clean, fresh, tidy, and appetizing')
  })

  it('folds in the plan\'s castDescription when given', () => {
    const photo = composePhotoPrompt(testBrand, {
      ...baseJob,
      scene: baseJob.topic,
      castDescription: 'a mother and her young daughter',
    })
    expect(photo.prompt).toContain('The people in this scene: a mother and her young daughter.')
  })

  it('reserves the top-right watermark safe zone', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic })
    expect(photo.prompt).toContain('top-right corner')
  })

  it('picks the interior pool only when setting is interior AND presence is featured', () => {
    const interior = composePhotoPrompt(bothScenesBrand, {
      ...baseJob,
      scene: baseJob.topic,
      unitPresence: 'featured',
      setting: 'interior',
    })
    expect(interior.referenceImageUrl).toBe('https://example.com/int.jpg')
    expect(interior.prompt).toContain('THE FIXED INTERIOR DESCRIPTION')

    // background + interior is not a real combination (brief §8) — stays exterior.
    const background = composePhotoPrompt(bothScenesBrand, {
      ...baseJob,
      scene: baseJob.topic,
      unitPresence: 'background',
      setting: 'interior',
    })
    expect(background.referenceImageUrl).toBe('https://example.com/ext.jpg')
  })
})

describe('composeSceneImagePrompt', () => {
  const baseJob = {
    pipelineId: 'pipeline-scene-image-1',
    sceneNumber: 1,
    visualDescription: 'A family unloading groceries from the Fresh-CAN truck at dusk',
    shotNotes: 'Slow push-in',
    characterRefUrl: 'https://example.com/character-ref.jpg',
  }

  it('attaches the character-ref photo as the edit source when the plan says unitPresence: featured', () => {
    const scene = composeSceneImagePrompt(testBrand, { ...baseJob, unitPresence: 'featured' })
    expect(scene.referenceImageUrl).toBe('https://example.com/character-ref.jpg')
    expect(scene.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
  })

  it('attaches the character-ref photo for unitPresence: background too, but with the never-the-focus caveat', () => {
    const scene = composeSceneImagePrompt(testBrand, { ...baseJob, unitPresence: 'background' })
    expect(scene.referenceImageUrl).toBe('https://example.com/character-ref.jpg')
    expect(scene.prompt).toContain('THE FIXED IDENTITY DESCRIPTION')
    expect(scene.prompt).toContain('never as the compositional focus')
  })

  it('does NOT attach the character-ref photo for unitPresence: none (default when omitted) — replaces the old isVideoSceneAboutUnit keyword-regex gate', () => {
    const scene = composeSceneImagePrompt(testBrand, {
      ...baseJob,
      visualDescription: 'A family is at home in their kitchen, finding the cupboards empty.',
      shotNotes: 'medium close-up, natural light, focus on their worried expressions',
    })
    expect(scene.referenceImageUrl).toBeUndefined()
    expect(scene.prompt).not.toContain('THE FIXED CONTAINER DESCRIPTION')
    expect(scene.prompt).not.toContain('NO NEW TEXT INSTRUCTION')
    expect(scene.prompt).toContain('does not involve the Test Brand unit')
    expect(scene.prompt).toContain('NO TEXT INSTRUCTION')
  })

  it('limits the frame to the people, objects, and setting the scene describes, regardless of unit presence — one positive rule, not a list of "never add X" negations', () => {
    const featured = composeSceneImagePrompt(testBrand, { ...baseJob, unitPresence: 'featured' })
    const none = composeSceneImagePrompt(testBrand, {
      ...baseJob,
      visualDescription: 'A family cooks dinner together at home.',
      shotNotes: null,
    })
    for (const { prompt } of [featured, none]) {
      expect(prompt).toContain('Show only the people, objects, and setting this scene describes or clearly implies')
      expect(prompt).toContain('Every visible hand belongs to one of those people, with natural anatomy')
    }
  })

  it('keeps scene-specific content (description, shot notes, cast, look) a meaningful share of the prompt — regression for a real run where the scene was only 9-12% of each prompt, the rest fixed guard text', () => {
    // Real scene + plan values from that run (5ba554e7, scene 2).
    const visualDescription =
      "The student's gaze lands on a handwritten recipe note on the counter, igniting a glimmer of hope and excitement."
    const shotNotes = 'Close-up on the note, then rack focus to her face'
    const cast = [
      {
        id: 'student',
        role: 'busy student',
        wardrobe: 'comfortable home attire, hint of study wear',
        age_range: '18-25',
        appearance: 'casual, slightly disheveled hair, youthful energy',
      },
    ]
    const look = { palette: 'earthy tones with pops of color', lighting: 'soft, warm', time_of_day: 'evening', style_direction: 'uplifting and homey' }
    const scene = composeSceneImagePrompt(BRAND_PROFILE, {
      pipelineId: 'pipeline-share-1',
      sceneNumber: 2,
      visualDescription,
      shotNotes,
      characterRefUrl: 'https://example.com/character-ref.jpg',
      unitPresence: 'none',
      cast,
      look,
    })
    const sceneSpecific = scene.prompt
      .split(/(?<=\.) /)
      .filter((part) => /student|recipe|rack focus|earthy|Recurring|Visual look/.test(part))
      .join(' ').length
    expect(sceneSpecific / scene.prompt.length).toBeGreaterThan(0.35)
  })

  it('includes shot notes and regen instructions when given', () => {
    const scene = composeSceneImagePrompt(testBrand, { ...baseJob, regenInstructions: 'warmer lighting' })
    expect(scene.prompt).toContain('Slow push-in')
    expect(scene.prompt).toContain('warmer lighting')
  })

  it('requires any food/produce/groceries shown to look clean and fresh, never dirty (containsFood defaults to true)', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('clean, fresh, tidy, and appetizing')
    expect(scene.prompt).toContain('Never render food looking dirty, rotten, messy, or unappetizing')
  })

  it('omits the food-quality block when the plan says containsFood: false (brief §4.4\'s own example)', () => {
    const scene = composeSceneImagePrompt(testBrand, { ...baseJob, containsFood: false })
    expect(scene.prompt).not.toContain('clean, fresh, tidy, and appetizing')
  })

  it('requires the depicted setting to be physically plausible and safe — regression for a real generation showing people eating dinner in the middle of a road', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('physically plausible and safe')
    expect(scene.prompt).toContain('middle of a road')
  })

  it('asks for premium photorealistic commercial-photography quality as a rendering floor, without dictating a specific style', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('Premium photorealistic commercial photography')
  })

  it('names the rendering failure modes to avoid (oversharpening, plastic/CGI texture, oversaturation) without spamming resolution buzzwords like "4K"/"8K"/"ultra HD"', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('never oversharpened, plastic/CGI-looking, or oversaturated')
    expect(scene.prompt.toLowerCase()).not.toMatch(/\b(4k|8k|ultra ?hd)\b/)
  })

  it('keeps the quality floor a rendering-fidelity instruction, never a composition dictate — the scene\'s own visual_description still decides framing/subject/style', () => {
    const visualDescription = 'A tight, graphic close-up on a single tomato, harsh studio lighting, high contrast'
    const scene = composeSceneImagePrompt(testBrand, { ...baseJob, visualDescription })
    expect(scene.prompt).toContain(visualDescription)
    // The quality floor names material/optics qualities only — no framing,
    // subject, or mood words that could override a scene's own choices.
    const qualityFloor = 'Premium photorealistic commercial photography'
    const qualityClauseText = scene.prompt.slice(scene.prompt.indexOf(qualityFloor))
    for (const styleWord of ['close-up', 'wide shot', 'graphic', 'studio lighting', 'high contrast']) {
      expect(qualityClauseText.toLowerCase()).not.toContain(styleWord.toLowerCase())
    }
  })

  it('does not frame the scene as "a marketing video" — that framing itself primed a staged/ad look', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).not.toContain('marketing video')
    expect(scene.prompt).toContain(`Scene ${baseJob.sceneNumber}: ${baseJob.visualDescription}`)
  })

  it('treats brand/vehicle details as a fixed constraint, never a directive on style — never the reason the scene exists', () => {
    const scene = composeSceneImagePrompt(testBrand, { ...baseJob, unitPresence: 'featured' })
    expect(scene.prompt).toContain('never as the reason this scene exists')
  })

  it('omits the brand-details-are-constraints clause for a unitPresence: none scene, which carries no brand details for it to govern', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).not.toContain('never as the reason this scene exists')
  })

  it("splices in the locked cast_bible description for the scene's people, right after the scene itself", () => {
    const scene = composeSceneImagePrompt(testBrand, {
      ...baseJob,
      cast: [
        {
          id: 'student',
          role: 'busy student',
          age_range: '18-25',
          appearance: 'curly dark hair, round glasses',
          wardrobe: 'a mustard hoodie',
        },
      ],
    })
    expect(scene.prompt).toContain(
      'the busy student (18-25, curly dark hair, round glasses, wearing a mustard hoodie)',
    )
    expect(scene.prompt).toContain('same face, hair, and clothing as every other scene')
    expect(scene.prompt.indexOf('busy student')).toBeGreaterThan(scene.prompt.indexOf(baseJob.visualDescription))
    expect(scene.prompt.indexOf('busy student')).toBeLessThan(scene.prompt.indexOf('Show only the people'))
  })

  it('adds no cast clause when the scene lists no cast', () => {
    const scene = composeSceneImagePrompt(testBrand, { ...baseJob, cast: [] })
    expect(scene.prompt).not.toContain('Recurring people')
  })

  it("uses the plan's look instead of the neutral daylight default", () => {
    const withLook = composeSceneImagePrompt(testBrand, {
      ...baseJob,
      look: { time_of_day: 'evening', lighting: 'soft, warm', palette: 'earthy tones', style_direction: 'homey' },
    })
    expect(withLook.prompt).toContain(
      'Visual look shared by every scene of this video: evening; soft, warm lighting; palette: earthy tones; homey feel.',
    )
    expect(withLook.prompt).not.toContain('Natural daylight')

    const withoutLook = composeSceneImagePrompt(testBrand, baseJob)
    expect(withoutLook.prompt).toContain('If unspecified, default mood: Natural daylight')
  })

  it('drops the cast clause before ever truncating the scene description, and stays within budget', () => {
    const longText = 'a very long descriptive sentence about the scene and its surroundings '.repeat(30)
    const visualDescription = `The student reads the note. ${longText}`.slice(0, 600).trimEnd()
    const scene = composeSceneImagePrompt(BRAND_PROFILE, {
      pipelineId: 'pipeline-cast-budget',
      sceneNumber: 2,
      visualDescription,
      shotNotes: longText,
      characterRefUrl: 'https://example.com/character-ref.jpg',
      unitPresence: 'featured',
      cast: [{ id: 'student', role: 'student', appearance: longText, wardrobe: longText }],
    })
    expect(scene.prompt.length).toBeLessThanOrEqual(3000)
    expect(scene.prompt).toContain(visualDescription)
    expect(scene.prompt).not.toContain('Recurring people')
  })

  it("never exceeds KieImageGenerator's real ~3000-char prompt cap, even with a maximally long visual_description/shot_notes/regenInstructions — regression for \"The prompt word cannot exceed 3000 characters\" (confirmed live against KIE.ai, recurred 3 times before this guard was added)", () => {
    // Against the REAL BRAND_PROFILE, not testBrand's short placeholders —
    // the fixed overhead that matters in production is Fresh-CAN's real,
    // already-hand-trimmed prose.
    const longText = 'a very long descriptive sentence about the scene and its surroundings '.repeat(30)
    const scene = composeSceneImagePrompt(BRAND_PROFILE, {
      pipelineId: 'pipeline-length-guard',
      sceneNumber: 3,
      visualDescription: `The family approaches the unit. ${longText}`,
      shotNotes: longText,
      characterRefUrl: 'https://example.com/character-ref.jpg',
      regenInstructions: longText,
      unitPresence: 'featured',
    })
    // featured (the larger-fixed-overhead branch) — confirms this exercised
    // the full-structure path, not the cheaper 'none' one.
    expect(scene.referenceImageUrl).toBeDefined()
    expect(scene.prompt.length).toBeLessThanOrEqual(3000)
    // The fixed safety/brand clauses must survive truncation fully intact —
    // only the free-text fields are ever allowed to shrink.
    expect(scene.prompt).toContain('clean, fresh, tidy, and appetizing')
    expect(scene.prompt).toContain('ONLY entrance')
    expect(scene.prompt).toContain('Premium photorealistic commercial photography')
  })

  it('does not truncate a normal, realistic scene at all', () => {
    const visualDescription =
      'A family unloading groceries from the Fresh-CAN truck at dusk, warm light spilling from the open rear doors'
    const shotNotes = 'Slow push-in, shallow depth of field'
    const scene = composeSceneImagePrompt(BRAND_PROFILE, {
      pipelineId: 'pipeline-length-guard-3',
      sceneNumber: 1,
      visualDescription,
      shotNotes,
      characterRefUrl: 'https://example.com/character-ref.jpg',
      unitPresence: 'featured',
    })
    expect(scene.prompt).toContain(visualDescription)
    expect(scene.prompt).toContain(shotNotes)
  })

  it('always includes the hands/skin realism rule — it is part of the fixed scene-contents rule now, never dropped', () => {
    const scene = composeSceneImagePrompt(BRAND_PROFILE, {
      pipelineId: 'pipeline-realism-1',
      sceneNumber: 1,
      visualDescription: 'A woman smiles at the camera.',
      shotNotes: null,
      characterRefUrl: 'https://example.com/character-ref.jpg',
      unitPresence: 'featured',
    })
    expect(scene.prompt).toContain('with natural anatomy; skin looks real')
  })

  it('keeps a short featured scene AND the hands/skin realism rule within budget', () => {
    // Measured headroom for the featured branch against the real
    // BRAND_PROFILE: the guardrail survives up to roughly 150 characters of
    // scene content. Phase 4's consolidated unit-branding block costs ~85
    // characters more than the bare descriptor the old code pushed (the
    // "never on any other vehicle" rule now ships on this path too), so the
    // window is tighter than it was after Phase 1 — see
    // docs/PROMPT_ARCHITECTURE.md's Phase 4 note on why that's accepted
    // here and left for Phase 5's real budget config to resolve.
    const visualDescription = 'A woman lifts a crate of apples into the open rear doors at dusk.'
    const scene = composeSceneImagePrompt(BRAND_PROFILE, {
      pipelineId: 'pipeline-realism-2',
      sceneNumber: 1,
      visualDescription,
      shotNotes: null,
      characterRefUrl: 'https://example.com/character-ref.jpg',
      unitPresence: 'featured',
    })
    expect(scene.prompt).toContain(visualDescription)
    expect(scene.prompt).toContain('with natural anatomy; skin looks real')
    expect(scene.prompt.length).toBeLessThanOrEqual(3000)
  })

  it('gets materially more room for scene content when the unit is absent (unitPresence: none) — the conditional-inclusion payoff brief §4.4 is after', () => {
    const visualDescription =
      'A family unloading groceries at dusk, warm light spilling from the open doors, the parents carrying ' +
      'reusable bags while their two children run ahead toward the front porch'
    const withUnit = composeSceneImagePrompt(BRAND_PROFILE, {
      pipelineId: 'p', sceneNumber: 1, visualDescription, shotNotes: null,
      characterRefUrl: 'https://example.com/character-ref.jpg', unitPresence: 'featured',
    })
    const withoutUnit = composeSceneImagePrompt(BRAND_PROFILE, {
      pipelineId: 'p', sceneNumber: 1, visualDescription, shotNotes: null,
      characterRefUrl: 'https://example.com/character-ref.jpg', unitPresence: 'none',
    })
    // The same scene text survives untruncated in both, but the no-unit
    // prompt is far shorter — that saved budget is what Phase 5 gets to
    // spend on continuity/realism blocks instead of dropping them.
    expect(withUnit.prompt).toContain(visualDescription)
    expect(withoutUnit.prompt).toContain(visualDescription)
    expect(withoutUnit.prompt.length).toBeLessThan(withUnit.prompt.length - 500)
  })

  it('keeps long real scene content AND the hands/skin realism rule intact', () => {
    const visualDescription =
      'A family unloading groceries from the Fresh-CAN truck at dusk, warm light spilling from the open rear ' +
      'doors, the parents carrying reusable bags while their two children run ahead toward the front porch, ' +
      'a neighbour waving hello from across the quiet residential street as the golden evening light catches ' +
      'the steam rising gently from a nearby chimney'
    const shotNotes = 'Slow push-in, shallow depth of field, warm handheld camera movement following the family'
    const scene = composeSceneImagePrompt(BRAND_PROFILE, {
      pipelineId: 'pipeline-realism-3',
      sceneNumber: 1,
      visualDescription,
      shotNotes,
      characterRefUrl: 'https://example.com/character-ref.jpg',
      unitPresence: 'featured',
    })
    expect(scene.prompt).toContain(visualDescription)
    expect(scene.prompt).toContain(shotNotes)
    expect(scene.prompt).toContain('with natural anatomy; skin looks real')
    expect(scene.prompt.length).toBeLessThanOrEqual(3000)
  })
})

describe('composeSceneImageEditPrompt', () => {
  it('edits the rejected image itself, asking for only the flagged fix and nothing else', () => {
    const edit = composeSceneImageEditPrompt(testBrand, {
      rejectedImageUrl: 'https://example.com/rejected.png',
      issues: ['disembodied hand above the counter'],
    })
    expect(edit.referenceImageUrl).toBe('https://example.com/rejected.png')
    expect(edit.prompt).toContain('fix only this defect: disembodied hand above the counter.')
    expect(edit.prompt).toContain('Keep everything else exactly as it is')
    // Never re-sends the scene/brand structure — that invites a re-render
    // instead of an edit.
    expect(edit.prompt).not.toContain('THE FIXED CONTAINER DESCRIPTION')
    expect(edit.prompt).toContain('NO TEXT INSTRUCTION')
  })

  it("keeps the vehicle's real signage when the unit is in the image", () => {
    const edit = composeSceneImageEditPrompt(testBrand, {
      rejectedImageUrl: 'https://example.com/rejected.png',
      issues: ['extra person behind the counter', 'floating crate'],
      unitPresence: 'featured',
    })
    expect(edit.prompt).toContain('fix only these defects: extra person behind the counter; floating crate.')
    expect(edit.prompt).toContain('NO NEW TEXT INSTRUCTION')
  })

  // Deliberately excluded — this is a short, surgical "fix only this
  // defect, keep everything else exactly as it is" edit against the
  // rejected image itself (this describe block's first test, above); the
  // image's existing rendering quality is already part of what "keep
  // everything else exactly as it is" preserves, and re-asserting a broad
  // quality floor here would only compete with the narrow, targeted fix
  // for the model's attention.
  it('does not include the shared photorealistic-quality floor — a targeted fix has no room for a broad style/quality restatement', () => {
    const edit = composeSceneImageEditPrompt(testBrand, {
      rejectedImageUrl: 'https://example.com/rejected.png',
      issues: ['disembodied hand above the counter'],
    })
    expect(edit.prompt).not.toContain('Premium photorealistic commercial photography')
  })
})

describe('composeSceneVideoPrompt', () => {
  it("holds the plan's lighting steady when a look is given, and adds nothing without one", () => {
    const withLook = composeSceneVideoPrompt({
      visualDescription: 'X',
      shotNotes: null,
      look: { lighting: 'soft, warm', time_of_day: 'evening' },
    })
    expect(withLook).toContain("Keep the frame's soft, warm, evening lighting and color steady for the whole shot")
    expect(composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null })).not.toContain("Keep the frame's")
  })

  it('includes the visual description and shot notes', () => {
    const prompt = composeSceneVideoPrompt({
      visualDescription: 'A family unloading groceries from the Fresh-CAN truck at dusk',
      shotNotes: 'Slow push-in',
    })
    expect(prompt).toContain('A family unloading groceries from the Fresh-CAN truck at dusk')
    expect(prompt).toContain('Slow push-in')
  })

  it('steers camera motion away from staged product-reveal moves like orbits or hero push-ins', () => {
    const prompt = composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null })
    expect(prompt).toContain('never a staged product-reveal move like a slow orbit or a dramatic hero push-in')
  })

  it('gives real cinematographic technique explicit positive permission, not just "subtle" motion', () => {
    const prompt = composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null })
    expect(prompt).toContain('pans, tilts, tracking, slow dolly, rack focus')
  })

  it('animates subject action, ambient environmental motion, and camera motion as three distinct layers, never camera as a substitute for scene action', () => {
    const prompt = composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null })
    expect(prompt).toContain('three distinct layers')
    expect(prompt).toContain('steam, smoke, wind moving hair, fabric, or leaves, water, shifting light')
    expect(prompt).toContain('Camera movement is never a substitute for actual subject or environmental motion')
  })

  it('forbids illogical motion on static objects (e.g. produce) with no visible cause — regression for real Seedance renders showing vegetables/groceries drifting on their own', () => {
    const prompt = composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null })
    expect(prompt).toContain('never motion with no real cause')
    expect(prompt).toContain('produce, packaged goods, and other solid objects at rest must stay completely still')
    expect(prompt).toContain('unless a visible hand, wind, or other real force is actually moving them')
  })

  it('guards against frame-to-frame flicker and warped motion blur, regardless of look/isFinalScene', () => {
    const prompt = composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null })
    expect(prompt).toContain('textures, packaging details, and lighting stable and flicker-free across every frame')
    expect(prompt).toContain('natural, non-warped motion blur')
  })

  it('adds a photographic quality-floor clause regardless of look/isFinalScene, without dictating any camera movement', () => {
    const prompt = composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null })
    expect(prompt).toContain('premium, photorealistic cinematic smartphone footage')
    expect(prompt).toContain('polished commercial quality, never oversaturated, over-sharpened, or CGI-looking')
  })

  it("never exceeds Seedance's real ~2500-char video prompt cap, even with a maximally long visual_description/shot_notes", () => {
    const longText = 'a very long descriptive sentence about the scene and its surroundings '.repeat(40)
    const prompt = composeSceneVideoPrompt({ visualDescription: longText, shotNotes: longText })
    expect(prompt.length).toBeLessThanOrEqual(2500)
    expect(prompt).toContain('never motion with no real cause')
    expect(prompt).toContain('never a staged product-reveal move')
  })

  it('does not truncate a normal, realistic scene at all', () => {
    const visualDescription = 'A family unloading groceries from the Fresh-CAN truck at dusk, warm light spilling from the open rear doors'
    const shotNotes = 'Slow push-in, shallow depth of field'
    const prompt = composeSceneVideoPrompt({ visualDescription, shotNotes })
    expect(prompt).toContain(visualDescription)
    expect(prompt).toContain(shotNotes)
  })

  it('adds no settle-the-motion instruction for a non-final scene', () => {
    const prompt = composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null, isFinalScene: false })
    expect(prompt).not.toContain('FINAL shot')
  })

  it('asks the FINAL scene to settle its motion into a held ending instead of getting cut off mid-movement — regression for a real render ending abruptly', () => {
    const prompt = composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null, isFinalScene: true })
    expect(prompt).toContain('FINAL shot')
    expect(prompt).toContain('settled, held final beat')
    expect(prompt).toContain('not get cut off mid-motion')
  })

  it('never exceeds the char cap even for the FINAL scene with maximally long visual_description/shot_notes', () => {
    const longText = 'a very long descriptive sentence about the scene and its surroundings '.repeat(40)
    const prompt = composeSceneVideoPrompt({ visualDescription: longText, shotNotes: longText, isFinalScene: true })
    expect(prompt.length).toBeLessThanOrEqual(2500)
    expect(prompt).toContain('FINAL shot')
  })
})

describe('composeCharacterRefPrompt', () => {
  it('attaches an exterior reference photo when one is configured', () => {
    const ref = composeCharacterRefPrompt(testBrand, { pipelineId: 'pipeline-char-ref-1' })
    expect(ref.referenceImageUrl).toBe('https://example.com/exterior.jpg')
    expect(ref.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
  })

  it('always uses the FIRST exterior reference photo — the one shared reference every scene locks onto, so cleanliness of the source matters more than per-pipeline variety', () => {
    const refA = composeCharacterRefPrompt(multiAngleBrand, { pipelineId: 'pipeline-aaaa' })
    const refB = composeCharacterRefPrompt(multiAngleBrand, { pipelineId: 'pipeline-zzzz-different' })
    expect(refA.referenceImageUrl).toBe('https://example.com/back.jpg')
    expect(refB.referenceImageUrl).toBe('https://example.com/back.jpg')
  })

  it('states there must be exactly one wordmark (the brand\'s own wordmarkText, never hardcoded), no second or duplicate decal', () => {
    const ref = composeCharacterRefPrompt(testBrand, { pipelineId: 'pipeline-char-ref-2' })
    expect(ref.prompt).toContain(`Exactly one "${testBrand.unit.wordmarkText}" wordmark total`)
    expect(ref.prompt).toContain('no second or duplicate wordmark, decal, or graphic')
  })

  it('includes the shared photorealistic-quality floor, same as every other image composer', () => {
    const ref = composeCharacterRefPrompt(testBrand, { pipelineId: 'pipeline-char-ref-quality' })
    expect(ref.prompt).toContain('Premium photorealistic commercial photography')
  })

  it('is always treated as unitPresence: featured — the full structural descriptor, not the identity tier', () => {
    const ref = composeCharacterRefPrompt(testBrand, { pipelineId: 'pipeline-char-ref-3' })
    expect(ref.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
    expect(ref.prompt).not.toContain('THE FIXED IDENTITY DESCRIPTION')
  })

  it('Phase 5 fix: never falls back to the blanket no-text instruction when no reference photo is configured — that would contradict its own "must be built to this structure" text (brief §12)', () => {
    const brandWithNoPhotos: BrandProfile = { ...testBrand, referenceImages: { exterior: [], interior: [] } }
    const ref = composeCharacterRefPrompt(brandWithNoPhotos, { pipelineId: 'pipeline-char-ref-no-photos' })
    expect(ref.referenceImageUrl).toBeUndefined()
    expect(ref.prompt).not.toContain('NO TEXT INSTRUCTION')
    expect(ref.prompt).toContain("the unit's own real wordmark, exactly as described above")
  })

})

// Phase 1 (PROMPT_REFACTOR_BRIEF.md): containerDescriptor was restructured
// into brand.unit.{identity,full,interior} plus atomic forbiddenOnUnit/
// forbiddenInScene arrays. These assertions were updated to the new field
// locations only — full structural coverage of the tiered/atomic shape is
// Phase 8's job (§13), not a Phase 1 rewrite.
describe('Fresh-CAN brand unit descriptor', () => {
  it('explicitly forbids doors on the sides of the truck, not just a buried mention', () => {
    expect(BRAND_PROFILE.unit.full).toMatch(/NEVER render a door.*either side/i)
    expect(BRAND_PROFILE.unit.full).toContain('ONLY entrance')
  })

  it('explicitly forbids doors/openings on the front face too — regression for a real generation showing a door there', () => {
    expect(BRAND_PROFILE.unit.full).toContain('front face')
    expect(BRAND_PROFILE.unit.full).toMatch(/NEVER render a door.*front face/i)
  })

  it('explicitly names a service window/hatch as forbidden — regression for a real generation showing an open service hatch to a customer', () => {
    expect(BRAND_PROFILE.unit.full).toContain('service window')
    expect(BRAND_PROFILE.unit.full).toContain('only place customers are ever served')
  })

  it('confines the logo to the side panels only, and explicitly rules out the front/rear/duplicates — regression for real reference photos actually showing it in 2-3 places at once', () => {
    expect(BRAND_PROFILE.unit.full).toMatch(/wordmark.*appears once, centered, on each of\s+the two side panels/i)
    expect(BRAND_PROFILE.unit.full).toContain('nowhere else on the vehicle')
    expect(BRAND_PROFILE.forbiddenOnUnit.join(' ')).toContain('No wordmark, logo, signage, or QR code on the front or rear faces')
  })

  it('the first exterior reference photo (character-ref\'s fixed source) shows the logo in exactly that correct side-only location', () => {
    const first = BRAND_PROFILE.referenceImages.exterior[0]
    expect(first.whatItShows).toContain('full profile view')
    expect(first.whatItShows).toContain('reproduce that exact wordmark faithfully, once')
  })
})

// Phase 8 (PROMPT_REFACTOR_BRIEF.md §13/G4) — proves composer/step files are
// brand-agnostic: swapping the brand profile changes the output with no
// code edits, and — the actual regression this describe block exists to
// catch — no Fresh-CAN-specific literal string survives the swap. This is
// the test that would have caught composeCharacterRefPrompt's
// ONE_WORDMARK_ONLY constant hardcoding "Fresh CAN" instead of reading
// brand.unit.wordmarkText (found and fixed this same phase).
describe('brand-agnosticism (G4 — swapping the brand profile changes the output with no code edits)', () => {
  const acmeBrand: BrandProfile = {
    name: 'Acme Fresh Mart',
    missionStatement: 'ACME MISSION STATEMENT',
    voiceGuidelines: 'ACME VOICE GUIDELINES',
    bannedWords: [],
    statistics: [],
    journey: [],
    positiveVisualTruths: [],
    businessModelNegatives: [],
    unit: {
      identity: 'ACME IDENTITY DESCRIPTION',
      full: 'ACME FULL STRUCTURAL DESCRIPTION',
      interior: 'ACME INTERIOR DESCRIPTION',
      wordmarkText: 'Acme Mart',
    },
    forbiddenOnUnit: [],
    forbiddenInScene: [],
    noTextInstruction: 'ACME NO TEXT INSTRUCTION',
    noNewTextInstruction: 'ACME NO NEW TEXT INSTRUCTION',
    ctaBarText: 'Visit acmefreshmart.example',
    typographyDescriptor: 'ACME TYPOGRAPHY DESCRIPTOR',
    ctaBarColorDescriptor: 'ACME CTA BAR COLOR DESCRIPTOR',
    referenceImages: {
      exterior: [{ url: 'https://example.com/acme-exterior.jpg', whatItShows: 'ACME FRAMING', disregard: [] }],
      interior: [],
    },
  }

  // Any of these appearing in Acme's output would mean a composer baked in
  // a Fresh-CAN-specific literal instead of reading it from the brand
  // profile — the actual class of bug this test suite exists to catch.
  const FRESH_CAN_LEAKS = ['Fresh-CAN', 'Fresh CAN', 'Fresh [maple leaf icon]']

  function assertNoFreshCanLeak(prompt: string) {
    for (const leak of FRESH_CAN_LEAKS) {
      expect(prompt).not.toContain(leak)
    }
  }

  it('composeCharacterRefPrompt: no Fresh-CAN leak, and Acme\'s own wordmark/structure appear', () => {
    const ref = composeCharacterRefPrompt(acmeBrand, { pipelineId: 'pipeline-acme-1' })
    assertNoFreshCanLeak(ref.prompt)
    expect(ref.prompt).toContain('Acme Mart')
    expect(ref.prompt).toContain('ACME FULL STRUCTURAL DESCRIPTION')
  })

  it('composeHeroPrompt/composeInlinePrompt: no Fresh-CAN leak across every unitPresence tier', () => {
    for (const unitPresence of ['none', 'background', 'featured'] as const) {
      const job = { pipelineId: `pipeline-acme-blog-${unitPresence}`, topic: 'Weekly savings', category: 'Deals', unitPresence }
      const hero = composeHeroPrompt(acmeBrand, job)
      const inline = composeInlinePrompt(acmeBrand, job)
      assertNoFreshCanLeak(hero.prompt)
      assertNoFreshCanLeak(inline.prompt)
    }
  })

  it('composePhotoPrompt: no Fresh-CAN leak, Acme\'s own structure appears when featured', () => {
    const photo = composePhotoPrompt(acmeBrand, {
      pipelineId: 'pipeline-acme-photo',
      topic: 'Weekly savings',
      category: 'Deals',
      scene: 'Shoppers browsing the aisle',
      unitPresence: 'featured',
    })
    assertNoFreshCanLeak(photo.prompt)
    expect(photo.prompt).toContain('ACME FULL STRUCTURAL DESCRIPTION')
  })

  it('composeSceneImagePrompt: no Fresh-CAN leak across every unitPresence tier', () => {
    for (const unitPresence of ['none', 'background', 'featured'] as const) {
      const scene = composeSceneImagePrompt(acmeBrand, {
        pipelineId: 'pipeline-acme-scene',
        sceneNumber: 1,
        visualDescription: 'A shopper picks up a basket.',
        shotNotes: null,
        characterRefUrl: 'https://example.com/acme-character-ref.jpg',
        unitPresence,
      })
      assertNoFreshCanLeak(scene.prompt)
    }
  })

  it('the SAME job composed against two different brands produces genuinely different prompts', () => {
    const job = { pipelineId: 'pipeline-diff-brand', topic: 'Weekly savings', category: 'Deals', unitPresence: 'featured' as const }
    const freshCan = composeHeroPrompt(testBrand, job)
    const acme = composeHeroPrompt(acmeBrand, job)
    expect(freshCan.prompt).not.toBe(acme.prompt)
  })
})
