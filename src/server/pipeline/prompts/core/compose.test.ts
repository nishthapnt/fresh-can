import { describe, it, expect } from 'vitest'
import {
  composeHeroPrompt,
  composeInlinePrompt,
  composePhotoPrompt,
  composeSceneImagePrompt,
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
  categoryBriefs: {},
  containerDescriptor: 'THE FIXED CONTAINER DESCRIPTION',
  interiorDescriptor: 'THE FIXED INTERIOR DESCRIPTION',
  noTextInstruction: 'NO TEXT INSTRUCTION',
  noNewTextInstruction: 'NO NEW TEXT INSTRUCTION',
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

  it('image_style "infographic" renders headline/subtitle/CTA instead of the no-text instructions', () => {
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
    // Regression test: composePhotoPrompt's showSubject branch always
    // attaches a real reference photo as a Flux Kontext edit source, which
    // defaults toward reproducing its input verbatim unless told otherwise.
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic })
    expect(photo.prompt).toContain('only as a guide')
    expect(photo.prompt).toContain('never as a literal photo to copy')
  })

  it('tells the model brand details are constraints, not the point of the photo, and never dictate style/mood/composition', () => {
    const photo = composePhotoPrompt(testBrand, { ...baseJob, scene: baseJob.topic })
    expect(photo.prompt).toContain('never as the reason this scene exists')
    expect(photo.prompt).toContain('never as a directive about the overall photographic style, mood, or composition')
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

  it('attaches the character-ref photo as the edit source when the scene is actually about the truck', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.referenceImageUrl).toBe('https://example.com/character-ref.jpg')
  })

  it('does NOT attach the character-ref photo, containerDescriptor, or the wordmark instruction for a scene that has nothing to do with the truck', () => {
    // Regression test: this composer used to ALWAYS attach the truck photo
    // as the Flux Kontext edit source and ALWAYS inject containerDescriptor,
    // for every scene — a real generation showed the truck hallucinated
    // inside a family's own kitchen because of this. isContainerRelevant
    // (defaultRelevant: false) now gates both on whether the scene's own
    // text actually indicates the truck/unit is involved.
    const scene = composeSceneImagePrompt(testBrand, {
      ...baseJob,
      visualDescription: 'A family is at home in their kitchen, finding the cupboards empty.',
      shotNotes: 'medium close-up, natural light, focus on their worried expressions',
    })
    expect(scene.referenceImageUrl).toBeUndefined()
    expect(scene.prompt).not.toContain('THE FIXED CONTAINER DESCRIPTION')
    expect(scene.prompt).not.toContain('NO NEW TEXT INSTRUCTION')
    expect(scene.prompt).toContain('does not involve the Fresh-CAN truck or mobile unit')
    expect(scene.prompt).toContain('NO TEXT INSTRUCTION')
  })

  it('does NOT show the truck for an unrelated creative scene that happens to use generic words like "arrive"/"enter"/"door"/"visit"/"pick up"/"shop" — regression for false-positiving on ordinary narrative prose', () => {
    // Video scenes are free-form narrative built around whatever creative
    // idea the job asked for (e.g. "a mother and son walking down the
    // road"), not blog/photo's short topic+category strings — reusing
    // blog/photo's isContainerRelevant (tuned for generic action verbs
    // implying a visit) against sentences like these would wrongly force
    // the truck in. isVideoSceneAboutUnit only fires on an explicit,
    // unambiguous mention of the unit itself.
    const scenes = [
      'A mother and son walk hand in hand down a quiet residential road, laughing together.',
      'They arrive at the park and sit on a bench, watching the sunset.',
      'She enters the house and hangs up her coat by the front door.',
      'He picks up his backpack and waves goodbye before visiting his grandmother next door.',
      'They window shop along the street, pointing out things they like.',
    ]
    for (const visualDescription of scenes) {
      const scene = composeSceneImagePrompt(testBrand, { ...baseJob, visualDescription, shotNotes: null })
      expect(scene.referenceImageUrl).toBeUndefined()
      expect(scene.prompt).not.toContain('THE FIXED CONTAINER DESCRIPTION')
      expect(scene.prompt).toContain('does not involve the Fresh-CAN truck or mobile unit')
    }
  })

  it('still shows the truck for a scene about arriving/parking/scanning in/browsing inside, even without the word "truck"', () => {
    const scene = composeSceneImagePrompt(testBrand, {
      ...baseJob,
      visualDescription: 'The family approaches the unit, scanning the QR code with the app to enter.',
      shotNotes: null,
    })
    expect(scene.referenceImageUrl).toBe('https://example.com/character-ref.jpg')
    expect(scene.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
  })

  it('never adds unscripted people beyond who the scene describes, regardless of whether the truck appears', () => {
    const relevant = composeSceneImagePrompt(testBrand, baseJob)
    const notRelevant = composeSceneImagePrompt(testBrand, {
      ...baseJob,
      visualDescription: 'A family cooks dinner together at home.',
      shotNotes: null,
    })
    expect(relevant.prompt).toContain('no extra staff, workers, or bystanders')
    expect(notRelevant.prompt).toContain('no extra staff, workers, or bystanders')
  })

  it('never adds unexplained props, vehicles, or signage beyond what the scene describes', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('no unexplained extras just to fill the frame')
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

  it("includes the brand's fixed containerDescriptor (structure/no-side-door rule), same as every other composer that can show the vehicle", () => {
    // Regression test: this composer used to rely ENTIRELY on the character-ref
    // image itself to anchor the vehicle's real structure, with no structural
    // rule in the TEXT at all — unlike composeCharacterRefPrompt/composeBlogImage/
    // composePhotoPrompt, which all splice in containerDescriptor. That gap let
    // a side door get hallucinated: REFERENCE_IS_GUIDE_NOT_COPY explicitly tells
    // the model to build a genuinely new scene around the vehicle rather than
    // copy the reference photo, and nothing in the text ever ruled a side door
    // out for that new interpretation.
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
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

  it('requires the depicted setting to be physically plausible and safe — regression for a real generation showing people eating dinner in the middle of a road', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('physically plausible and safe')
    expect(scene.prompt).toContain('middle of a road')
  })

  it('asks for real cinematographic craft as a quality floor, without dictating a specific style', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('cinematographic craft')
    expect(scene.prompt).toContain('elevating whatever mood or style the scene above calls for')
  })

  it('does not frame the scene as "a marketing video" — that framing itself primed a staged/ad look', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).not.toContain('marketing video')
    expect(scene.prompt).toContain(`Scene ${baseJob.sceneNumber}: ${baseJob.visualDescription}`)
  })

  it('treats brand/vehicle details as a fixed constraint, never a directive on style — never the reason the scene exists', () => {
    const scene = composeSceneImagePrompt(testBrand, baseJob)
    expect(scene.prompt).toContain('never as the reason this scene exists')
  })
})

describe('composeSceneVideoPrompt', () => {
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
    // Regression test: the original "Subtle, natural, observational motion"
    // wording was in tension with composeVideoScriptSystemPrompt's newer
    // cinematic-shot-variety instruction — this locks in that deliberate
    // camera moves (pans, tilts, tracking, dolly, rack focus) are now
    // explicitly welcomed, not discouraged by default.
    const prompt = composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null })
    expect(prompt).toContain('pans, tilts, tracking, slow dolly, rack focus')
  })

  it('animates subject action, ambient environmental motion, and camera motion as three distinct layers, never camera as a substitute for scene action', () => {
    const prompt = composeSceneVideoPrompt({ visualDescription: 'X', shotNotes: null })
    expect(prompt).toContain('three distinct layers')
    expect(prompt).toContain('steam, wind, moving fabric, shifting light')
    expect(prompt).toContain('Camera movement is never a substitute for actual subject or environmental motion')
  })
})

describe('composeCharacterRefPrompt', () => {
  it('attaches an exterior reference photo when one is configured', () => {
    const ref = composeCharacterRefPrompt(testBrand, { pipelineId: 'pipeline-char-ref-1' })
    expect(ref.referenceImageUrl).toBe('https://example.com/exterior.jpg')
    expect(ref.prompt).toContain('THE FIXED CONTAINER DESCRIPTION')
  })

  it('always uses the FIRST exterior reference photo — the one shared reference every scene locks onto, so cleanliness of the source matters more than per-pipeline variety', () => {
    // Regression test: a real character-ref generation showed a duplicate,
    // garbled second wordmark-like decal over an unexplained red blob
    // graphic — most likely bleed-through from one of the OTHER reference
    // photos (documented in fresh-can.ts as showing a real decorative
    // graphic + URL text the model is told to disregard). Picking
    // deterministically from index 0 regardless of pipelineId is what
    // stops a rotation ever landing on one of those contaminated photos
    // for this specific, singular use.
    const refA = composeCharacterRefPrompt(multiAngleBrand, { pipelineId: 'pipeline-aaaa' })
    const refB = composeCharacterRefPrompt(multiAngleBrand, { pipelineId: 'pipeline-zzzz-different' })
    expect(refA.referenceImageUrl).toBe('https://example.com/back.jpg')
    expect(refB.referenceImageUrl).toBe('https://example.com/back.jpg')
  })

  it('states there must be exactly one wordmark, no second or duplicate decal', () => {
    const ref = composeCharacterRefPrompt(testBrand, { pipelineId: 'pipeline-char-ref-2' })
    expect(ref.prompt).toContain('Exactly one "Fresh CAN" wordmark total')
    expect(ref.prompt).toContain('no second or duplicate wordmark, decal, or graphic')
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

  it('explicitly forbids doors/openings on the front face too — regression for a real generation showing a door there', () => {
    // The old wording only named "either side" and the rear by name,
    // relying on "the rear door is the ONLY opening" to implicitly rule
    // out the front — the side-door bug already proved an implied
    // "nowhere else" isn't reliable, so the front now gets the same
    // explicit, named treatment.
    expect(BRAND_PROFILE.containerDescriptor).toContain('front face')
    expect(BRAND_PROFILE.containerDescriptor).toMatch(/NEVER render a door.*front face/i)
  })

  it('explicitly names a customer service window/hatch as forbidden — regression for a real generation showing an open service hatch to a customer', () => {
    // The existing generic "never a door/hatch/window/vent on either side"
    // wording was STILL violated by a real generation: an open service
    // hatch appeared in a scene where a family approaches to shop. Naming
    // this exact failure mode (a customer-facing serving window) directly,
    // rather than trusting the generic wording to cover it by implication
    // a second time, is the actual fix.
    expect(BRAND_PROFILE.containerDescriptor).toContain('customer service window')
    expect(BRAND_PROFILE.containerDescriptor).toContain('only place customers are ever served')
  })

  it('confines the logo to the side panels only, and explicitly rules out the front/rear/duplicates — regression for real reference photos actually showing it in 2-3 places at once', () => {
    // Direct user feedback: "make sure the correct fresh-can logo is used
    // and the logo is not used at random places — only on the side of the
    // truck." Re-inspecting the real reference photos found they contradict
    // the OLD wording here: the physical truck's actual wrap design shows a
    // second small wordmark on the rear header bar AND a large wordmark on
    // the front face, in addition to the correct side wordmark. Simplified
    // to a single enforceable rule (side only, once each) rather than
    // continuing to describe every real-but-inconsistent placement.
    expect(BRAND_PROFILE.containerDescriptor).toMatch(/wordmark.*appears ONLY on\s+the two side panels/i)
    expect(BRAND_PROFILE.containerDescriptor).toContain('nowhere else on the vehicle')
    expect(BRAND_PROFILE.containerDescriptor).toContain('no wordmark, signage, or QR code')
  })

  it('the first exterior reference photo (character-ref\'s fixed source) shows the logo in exactly that correct side-only location', () => {
    // composeCharacterRefPrompt always uses referenceImages.exterior[0] —
    // this locks in that whichever photo occupies that slot actually
    // matches the simplified brand rule above (a full side-profile view),
    // rather than one that also shows the front or rear wordmark in the
    // same frame.
    const first = BRAND_PROFILE.referenceImages.exterior[0]
    expect(first.framing).toContain('full profile view')
    expect(first.framing).toContain('reproduce that exact wordmark faithfully, once')
  })
})
