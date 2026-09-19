import { describe, it, expect } from 'vitest'
import { composeHeroPrompt, composeInlinePrompt, composePhotoPrompt, composeSceneImagePrompt, composeCharacterRefPrompt } from './compose'
import type { BrandProfile } from '../types'
import { BRAND_PROFILE } from '../brand/fresh-can'

const testBrand: BrandProfile = {
  name: 'Test Brand',
  missionStatement: 'TEST MISSION STATEMENT',
  voiceGuidelines: 'TEST VOICE GUIDELINES',
  bannedWords: [],
  statistics: [],
  categoryBriefs: {},
  containerDescriptor: 'THE FIXED CONTAINER DESCRIPTION',
  interiorDescriptor: 'THE FIXED INTERIOR DESCRIPTION',
  noTextInstruction: 'NO TEXT INSTRUCTION',
  noNewTextInstruction: 'NO NEW TEXT INSTRUCTION',
  logoDescriptor: 'THE FIXED LOGO DESCRIPTOR',
  ctaBarText: 'Visit test.example.com',
  typographyDescriptor: 'THE FIXED TYPOGRAPHY DESCRIPTOR',
  ctaBarColorDescriptor: 'THE FIXED CTA BAR COLOR DESCRIPTOR',
  moods: [
    { key: 'a', detail: 'MOOD A' },
    { key: 'b', detail: 'MOOD B' },
    { key: 'c', detail: 'MOOD C' },
  ],
  // interior deliberately empty here — pickSceneType falls back to
  // exterior-only when interior has no photos, so every existing test
  // below (written before interior support existed) keeps working as-is.
  referenceImages: {
    exterior: [{ url: 'https://example.com/exterior.jpg', framing: 'FRAMING A' }],
    interior: [],
  },
}

const multiAngleBrand: BrandProfile = {
  ...testBrand,
  referenceImages: {
    exterior: [
      { url: 'https://example.com/back.jpg', framing: 'FRAMING BACK' },
      { url: 'https://example.com/arrival.jpg', framing: 'FRAMING ARRIVAL' },
      { url: 'https://example.com/standing.jpg', framing: 'FRAMING STANDING' },
    ],
    interior: [],
  },
}

const bothScenesBrand: BrandProfile = {
  ...testBrand,
  referenceImages: {
    exterior: [{ url: 'https://example.com/ext.jpg', framing: 'FRAMING EXT' }],
    interior: [{ url: 'https://example.com/int.jpg', framing: 'FRAMING INT' }],
  },
}

describe('composeHeroPrompt / composeInlinePrompt', () => {
  it('pick the same mood for hero and inline of the same pipeline', () => {
    const job = { pipelineId: 'pipeline-1', topic: 'Winter grocery access', category: 'Food Desert Education' }
    const hero = composeHeroPrompt(testBrand, job)
    const inline = composeInlinePrompt(testBrand, job)
    const heroMood = testBrand.moods.find((m) => hero.prompt.includes(m.detail))
    const inlineMood = testBrand.moods.find((m) => inline.prompt.includes(m.detail))
    expect(heroMood).toBeDefined()
    expect(heroMood?.key).toBe(inlineMood?.key)
  })

  it('is stable across repeated calls for the same pipeline id (retry-safe)', () => {
    const job = { pipelineId: 'pipeline-2', topic: 'Community garden', category: 'Community Impact' }
    const first = composeHeroPrompt(testBrand, job)
    const second = composeHeroPrompt(testBrand, job)
    expect(first.prompt).toBe(second.prompt)
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
    // Regression test: scene_notes flipped from "For light inspiration
    // only... without contradicting or replacing" to being the thing the
    // scene is built around, with brand details reframed as constraints on
    // what must look correct if they appear.
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

  it('weaves in the dashboard keywords as themes, without forcing or overriding the scene', () => {
    const job = {
      pipelineId: 'pipeline-keywords-1',
      topic: 'Community garden fundraiser',
      category: 'Community Impact',
      keywords: 'local farmers, cashless, community',
    }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toContain('local farmers, cashless, community')
    expect(hero.prompt).toContain('never let it contradict or override the scene')
  })

  it('omits the keywords clause entirely when none is given', () => {
    const job = { pipelineId: 'pipeline-keywords-2', topic: 'Community garden fundraiser', category: 'Community Impact' }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).not.toContain('Relevant themes for this post')
  })

  it('omits the headline clause entirely when none is given (backward compatible)', () => {
    const job = { pipelineId: 'pipeline-no-headline', topic: 'Community garden', category: 'Community Impact' }
    const hero = composeHeroPrompt(testBrand, job)
    // composeBlogImage quotes the headline as `about "${headline}"` when
    // present (see the sibling test above) — assert that specific clause is
    // absent, rather than banning quote characters entirely, since other
    // brand text (e.g. a quoted wordmark) legitimately contains quotes.
    expect(hero.prompt).not.toContain('about "')
  })

  it('omits the forced reference image for a topic unrelated to visiting the unit, using a non-container scene instead', () => {
    // Reversed 2026-09-11 — blog hero/inline used to ALWAYS show the truck
    // regardless of topic, which made every image look like "the truck from
    // one of a handful of fixed angles." Now gated the same way
    // composePhotoPrompt already was (isContainerRelevant), so a topic with
    // no visit/facility signal gets a real, non-branded, topic-grounded
    // scene with no reference photo instead. The container descriptor may
    // still appear in text (see the "permits the truck/wordmark as an
    // incidental background element" test below) — that's the conditional
    // exception, not a forced reference-photo edit.
    const job = { pipelineId: 'pipeline-3', topic: 'Community garden fundraiser', category: 'Community Impact' }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.referenceImageUrl).toBeUndefined()
  })

  it('includes the container descriptor and reference image when the topic is about visiting the unit too', () => {
    const job = { pipelineId: 'pipeline-4', topic: 'Scanning in at the Fresh-CAN truck', category: 'How FreshCAN Works' }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
    expect(hero.referenceImageUrl).toBe('https://example.com/exterior.jpg')
  })

  it('uses the strict no-text instruction when no reference photos are configured at all', () => {
    // Container-relevant topic (showSubject: true) with an empty photo pool
    // — the one case that still falls through to the blanket
    // noTextInstruction, since there's no background-truck exception to
    // reconcile it with (see the non-container describe block below for
    // that case instead).
    const brandWithNoPhotos: BrandProfile = { ...testBrand, referenceImages: { exterior: [], interior: [] } }
    const job = { pipelineId: 'pipeline-5', topic: 'Scanning in at the Fresh-CAN truck', category: 'How FreshCAN Works' }
    expect(composeHeroPrompt(brandWithNoPhotos, job).prompt).toContain('NO TEXT INSTRUCTION')
    expect(composeInlinePrompt(brandWithNoPhotos, job).prompt).toContain('NO TEXT INSTRUCTION')
    expect(composeHeroPrompt(brandWithNoPhotos, job).prompt).not.toContain('NO NEW TEXT INSTRUCTION')
    expect(composeHeroPrompt(brandWithNoPhotos, job).referenceImageUrl).toBeUndefined()
  })

  it('uses the preserve-real-signage instruction instead, once a reference image is attached', () => {
    const job = { pipelineId: 'pipeline-6', topic: 'Scanning in at the Fresh-CAN truck', category: 'How FreshCAN Works' }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.referenceImageUrl).toBeDefined()
    expect(hero.prompt).toContain('NO NEW TEXT INSTRUCTION')
    expect(hero.prompt).not.toContain('NO TEXT INSTRUCTION ')
  })

  it('never mismatches a framing description with a different photo\'s URL', () => {
    // Regardless of which of the 3 real angles gets picked for hero vs.
    // inline, the framing text in the prompt must always correspond to the
    // SAME entry as referenceImageUrl — this is the exact bug class Flux
    // Kontext confusion would come from (text describing one shot, photo
    // attached being a different one).
    const byUrl = new Map(multiAngleBrand.referenceImages.exterior.map((r) => [r.url, r.framing]))
    for (let i = 0; i < 20; i++) {
      const job = { pipelineId: `pipeline-multi-${i}`, topic: 'Scanning in at the Fresh-CAN truck', category: 'How FreshCAN Works' }
      const hero = composeHeroPrompt(multiAngleBrand, job)
      expect(hero.referenceImageUrl).toBeDefined()
      const expectedFraming = byUrl.get(hero.referenceImageUrl!)
      expect(hero.prompt).toContain(expectedFraming)
    }
  })

  it('lets hero and inline land on different camera angles for the same pipeline', () => {
    // Not guaranteed for every single pipelineId (hash collisions happen),
    // but across enough distinct ids at least one should differ, proving
    // hero/inline are picked independently rather than always matching.
    let sawDifference = false
    for (let i = 0; i < 20; i++) {
      const job = { pipelineId: `pipeline-diff-${i}`, topic: 'Scanning in at the Fresh-CAN truck', category: 'How FreshCAN Works' }
      const hero = composeHeroPrompt(multiAngleBrand, job)
      const inline = composeInlinePrompt(multiAngleBrand, job)
      if (hero.referenceImageUrl !== inline.referenceImageUrl) sawDifference = true
    }
    expect(sawDifference).toBe(true)
  })

  it('never pairs the interior descriptor/photo with the exterior descriptor/photo, or vice versa', () => {
    for (let i = 0; i < 20; i++) {
      const job = { pipelineId: `pipeline-scene-${i}`, topic: 'Touring the Fresh-CAN truck', category: 'Community Impact' }
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
      const job = { pipelineId: `pipeline-scene-variety-${i}`, topic: 'Touring the Fresh-CAN truck', category: 'Community Impact' }
      const hero = composeHeroPrompt(bothScenesBrand, job)
      sceneTypesSeen.add(hero.referenceImageUrl === 'https://example.com/int.jpg' ? 'interior' : 'exterior')
    }
    expect(sceneTypesSeen.size).toBe(2)
  })

  it('falls back to exterior-only when no interior photos are configured (existing brands keep working)', () => {
    const job = { pipelineId: 'pipeline-fallback-1', topic: 'Touring the Fresh-CAN truck', category: 'Community Impact' }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
    expect(hero.referenceImageUrl).toBe('https://example.com/exterior.jpg')
  })

  it('falls back to interior-only when no exterior photos are configured', () => {
    const interiorOnlyBrand: BrandProfile = {
      ...testBrand,
      referenceImages: { exterior: [], interior: [{ url: 'https://example.com/int-only.jpg', framing: 'FRAMING INT ONLY' }] },
    }
    const job = { pipelineId: 'pipeline-fallback-2', topic: 'Touring the Fresh-CAN truck', category: 'Community Impact' }
    const hero = composeHeroPrompt(interiorOnlyBrand, job)
    expect(hero.prompt).toContain('THE FIXED INTERIOR DESCRIPTION')
    expect(hero.referenceImageUrl).toBe('https://example.com/int-only.jpg')
  })

  it('image_style "infographic" renders headline/subtitle/logo/CTA instead of the no-text instructions', () => {
    const job = {
      pipelineId: 'pipeline-info-1',
      topic: 'How to shop at Fresh-CAN',
      category: 'Community Impact',
      imageStyle: 'infographic' as const,
      headline: 'Fresh Food, Closer To Home',
      subtitle: 'A smarter way to shop',
    }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toContain('Fresh Food, Closer To Home')
    expect(hero.prompt).toContain('A smarter way to shop')
    expect(hero.prompt).toContain('THE FIXED LOGO DESCRIPTOR')
    expect(hero.prompt).toContain('Visit test.example.com')
    expect(hero.prompt).toContain('THE FIXED TYPOGRAPHY DESCRIPTOR')
    expect(hero.prompt).toContain('THE FIXED CTA BAR COLOR DESCRIPTOR')
    expect(hero.prompt).not.toContain('NO TEXT INSTRUCTION')
    expect(hero.prompt).not.toContain('NO NEW TEXT INSTRUCTION')
  })

  it('throws if image_style "infographic" is used without both headline and subtitle', () => {
    const job = {
      pipelineId: 'pipeline-info-2',
      topic: 'How to shop at Fresh-CAN',
      category: 'Community Impact',
      imageStyle: 'infographic' as const,
      headline: 'Fresh Food, Closer To Home',
      // subtitle missing
    }
    expect(() => composeHeroPrompt(testBrand, job)).toThrow()
  })

  it('defaults to "photo" style (no text) when imageStyle is omitted', () => {
    const job = { pipelineId: 'pipeline-info-3', topic: 'Scanning in at the Fresh-CAN truck', category: 'How FreshCAN Works' }
    const hero = composeHeroPrompt(testBrand, job)
    expect(hero.prompt).toMatch(/NO( NEW)? TEXT INSTRUCTION/)
  })

  describe('non-container scenes (topic not about visiting the unit)', () => {
    const hintBrand: BrandProfile = {
      ...testBrand,
      categoryVisualHints: { 'Fresh Produce & Local Farms': 'THE FIXED PRODUCE VISUAL HINT' },
    }

    it("uses the brand's category-specific visual hint when one is configured, with no forced reference image", () => {
      const job = { pipelineId: 'pipeline-hint-1', topic: 'Seasonal harvest highlights', category: 'Fresh Produce & Local Farms' }
      const hero = composeHeroPrompt(hintBrand, job)
      expect(hero.prompt).toContain('THE FIXED PRODUCE VISUAL HINT')
      expect(hero.referenceImageUrl).toBeUndefined()
    })

    it('falls back to a generic documentary-photo hint for a category with no configured visual hint', () => {
      const job = { pipelineId: 'pipeline-hint-2', topic: 'Community garden fundraiser', category: 'Community Impact' }
      const hero = composeHeroPrompt(testBrand, job) // testBrand defines no categoryVisualHints at all
      expect(hero.prompt).toContain('Photorealistic documentary-style photo')
      expect(hero.referenceImageUrl).toBeUndefined()
    })

    it('permits the Fresh-CAN truck as an incidental background element, but never as the forced main subject', () => {
      const job = { pipelineId: 'pipeline-hint-brand', topic: 'Community garden fundraiser', category: 'Community Impact' }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).toContain('Fresh-CAN truck')
      expect(hero.prompt).toContain('never the main subject')
      expect(hero.referenceImageUrl).toBeUndefined()
    })

    it('never sends the blanket "no logos anywhere" instruction alongside a hint that permits the truck in the background', () => {
      // Regression test for the actual bug: nonContainerSceneHint/
      // categoryVisualHints tells the model the truck's wordmark may
      // appear, while the OLD trailing instruction (brand.noTextInstruction)
      // unconditionally said "no logos, no watermarks... anywhere" — a
      // direct contradiction in the same prompt that left the model free to
      // invent an off-model result, e.g. putting the wordmark on the wrong
      // vehicle. The fixed prompt must never contain that blanket phrase in
      // a non-container scene, and must instead spell out the truck's
      // correct structure plus an explicit "every other vehicle stays
      // unbranded" rule.
      const job = { pipelineId: 'pipeline-no-contradiction', topic: 'Community garden fundraiser', category: 'Community Impact' }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).not.toContain('NO TEXT INSTRUCTION')
      expect(hero.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
      expect(hero.prompt).toMatch(/other vehicle.*unbranded/i)
      expect(hero.referenceImageUrl).toBeUndefined()
    })

    it('still respects mood rotation and the job-specific topic line in a non-container scene', () => {
      const job = { pipelineId: 'pipeline-hint-3', topic: 'Community garden fundraiser', category: 'Community Impact' }
      const hero = composeHeroPrompt(testBrand, job)
      expect(hero.prompt).toContain('Community garden fundraiser')
      const mood = testBrand.moods.find((m) => hero.prompt.includes(m.detail))
      expect(mood).toBeDefined()
    })
  })
})

describe('composePhotoPrompt', () => {
  const baseJob = {
    pipelineId: 'pipeline-photo-1',
    topic: 'Grocery access in Kincora',
    category: 'Community Impact',
  }

  it('defaults to showing the container for a generic grocery-access topic', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic })
    expect(photo.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
    expect(photo.referenceImageUrl).toBe('https://example.com/exterior.jpg')
  })

  it('omits the container for a scene that is purely about produce', () => {
    const photo = composePhotoPrompt(testBrand, {
      ...baseJob,
      topic: 'Sweet PEI summer strawberries and corn',
      scene: 'fresh strawberries and corn from local farms',
    })
    expect(photo.prompt).not.toContain('THE FIXED CONTAINER DESCRIPTION')
    expect(photo.referenceImageUrl).toBeUndefined()
  })

  it('splices in regen instructions', () => {
    const photo = composePhotoPrompt(testBrand, {
      ...baseJob,
      scene: baseJob.topic,
      regenInstructions: 'warmer colors, more optimistic tone',
    })
    expect(photo.prompt).toContain('warmer colors, more optimistic tone')
  })

  it('image_style "infographic" renders headline/subtitle/logo/CTA instead of the no-text instructions', () => {
    const photo = composePhotoPrompt(testBrand, {
      ...baseJob,
      scene: baseJob.topic,
      imageStyle: 'infographic',
      headline: 'Fresh Food, Closer To Home',
      subtitle: 'A smarter way to shop',
    })
    expect(photo.prompt).toContain('Fresh Food, Closer To Home')
    expect(photo.prompt).toContain('A smarter way to shop')
    expect(photo.prompt).toContain('THE FIXED LOGO DESCRIPTOR')
    expect(photo.prompt).toContain('Visit test.example.com')
    expect(photo.prompt).not.toContain('NO TEXT INSTRUCTION')
    expect(photo.prompt).not.toContain('NO NEW TEXT INSTRUCTION')
  })

  it('tells the model the reference photo is a shape/color guide, never a literal copy', () => {
    // Regression test: composePhotoPrompt's showSubject branch always
    // attaches a real reference photo as a Flux Kontext edit source, which
    // defaults toward reproducing its input verbatim unless told otherwise.
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic })
    expect(photo.prompt).toContain('only as a guide')
    expect(photo.prompt).toContain('never as a literal photo to copy')
  })

  it('tells the model brand details are constraints, not the point of the photo, so it does not read as an ad', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic })
    expect(photo.prompt).toContain('never as the reason this scene exists')
    expect(photo.prompt).toContain('never a posed, polished advertisement')
  })

  it('requires any food/produce/groceries shown to look clean and fresh, never dirty', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic })
    expect(photo.prompt).toContain('clean, fresh, tidy, and appetizing')
    expect(photo.prompt).toContain('Never render food looking dirty, rotten, messy, or unappetizing')
  })

  it('weaves in the dashboard keywords as themes, without forcing or overriding the scene', () => {
    const photo = composePhotoPrompt(testBrand, {
      ...baseJob,
      scene: baseJob.topic,
      keywords: 'local farmers, cashless, community',
    })
    expect(photo.prompt).toContain('local farmers, cashless, community')
    expect(photo.prompt).toContain('never let it contradict or override the scene')
  })

  it('omits the keywords clause entirely when none is given', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic })
    expect(photo.prompt).not.toContain('Relevant themes for this post')
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

  it('always attaches the character-ref photo as the edit source', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.referenceImageUrl).toBe('https://example.com/character-ref.jpg')
  })

  it('tells the model the character-ref photo is a guide, not a literal copy — every scene reuses the same photo', () => {
    // Regression test: every scene in a video reuses the SAME characterRefUrl
    // as its edit source, so without this instruction the model has nothing
    // pushing it to build THIS scene's actual visual_description instead of
    // just reproducing the character-ref's own plain reference shot.
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('only as a guide')
    expect(scene.prompt).toContain('never as a literal photo to copy')
    expect(scene.prompt).toContain(baseJob.visualDescription)
  })

  it('includes shot notes and regen instructions when given', () => {
    const scene = composeSceneImagePrompt(testBrand, { ...baseJob, regenInstructions: 'warmer lighting' })
    expect(scene.prompt).toContain('Slow push-in')
    expect(scene.prompt).toContain('warmer lighting')
  })

  it('requires any food/produce/groceries shown to look clean and fresh, never dirty', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('clean, fresh, tidy, and appetizing')
    expect(scene.prompt).toContain('Never render food looking dirty, rotten, messy, or unappetizing')
  })
})

describe('composeCharacterRefPrompt', () => {
  it('attaches an exterior reference photo when one is configured', () => {
    const ref = composeCharacterRefPrompt(testBrand, { pipelineId: 'pipeline-char-ref-1' })
    expect(ref.referenceImageUrl).toBe('https://example.com/exterior.jpg')
    expect(ref.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
  })
})

describe('Fresh-CAN brand containerDescriptor', () => {
  it('explicitly forbids doors on the sides of the truck, not just a buried mention', () => {
    // The old wording ("no external staircase, no doors on the sides")
    // was a trailing clause inside a much longer descriptive sentence —
    // easy for the model to under-weight. This locks in the standalone,
    // emphatic "NEVER render a door... on either side" rewrite.
    expect(BRAND_PROFILE.containerDescriptor).toMatch(/NEVER render a door.*either side/i)
    expect(BRAND_PROFILE.containerDescriptor).toContain('ONLY entrance')
  })
})
