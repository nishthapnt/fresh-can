// The brand-swappable prompt structure. Everything a new client's install
// needs to customize for image generation lives on this one type — to
// re-brand the worker for another company, copy brand/fresh-can.ts to
// brand/<new-brand>.ts, fill in these fields for the new brand, and switch
// the import in prompts/index.ts. No database table, no runtime toggle —
// see PROGRESS.md for why this project deliberately chose that over a
// brand_profiles table.

// 'photo': strictly no text baked into the image (default — the existing
// Flux Kontext pipeline, unchanged). 'infographic': headline/subtitle/logo/
// CTA text rendered onto the image via a different, text-capable model
// (nano-banana-2, not Flux Kontext — see adapters/nanoBanana.ts). This is a
// per-job value the user selects in the dashboard form (content_jobs.
// image_style) — never an automatic per-category guess; an earlier
// automatic version of this concept was tried and removed for poor image
// quality (Flux Kontext garbling text it had to invent from scratch).
export type ImageStyle = 'photo' | 'infographic'

export interface ImageMood {
  key: string
  /** Lighting/color/atmosphere description spliced into every image prompt
   *  that uses this mood — keeps a pair of images (e.g. a blog's hero +
   *  inline) visually consistent when they share a mood key. */
  detail: string
}

export interface BrandReferenceImage {
  /** Publicly fetchable URL — Flux Kontext's `inputImage` must be able to
   *  download it. See worker/assets/<brand>/README.md for how to get one. */
  url: string
  /**
   * Prompt text describing the camera framing THIS specific photo shows —
   * spliced in alongside it. Flux Kontext edits from the attached photo, so
   * describing a different framing than what's actually in the photo (e.g.
   * "facing the rear entrance dead-on" while attaching a side-profile shot)
   * produces confused results — this keeps each photo paired with text that
   * actually matches it.
   */
  framing: string
}

export interface BrandProfile {
  name: string
  /**
   * One or two sentences on what the brand does and for whom — spliced into
   * every text-generation prompt (outline, copy, caption) so the model has
   * real company context instead of writing from the topic string alone.
   */
  missionStatement: string
  /**
   * A short, neutral, purely-factual fallback for missionStatement — used
   * ONLY by composeVideoScriptSystemPrompt when a user-submitted scene idea
   * leads the prompt (see that function). Added 2026-09-19 after a real
   * generation given a scene idea entirely unrelated to food deserts still
   * mentioned "food desert communities" — traced to missionStatement's own
   * fuller framing (mission language, statistics-adjacent phrasing) being
   * quoted verbatim as "background context," which is the same
   * competing-topic risk composeVideoScriptSystemPrompt's category-brief/
   * statistics removal was fixed for, just via a field this file's other
   * prompts (outline/copy) still correctly use the fuller missionStatement
   * for — those ARE Fresh-CAN content by definition, so the fuller framing
   * is appropriate there. Optional: falls back to missionStatement itself
   * when unset, so an existing/new brand file needs no change to keep
   * working.
   */
  neutralIdentityLine?: string
  /**
   * Tone/voice rules for all generated text — e.g. person, formality,
   * regional spelling. Fixed here rather than re-explained per prompt call,
   * so every generated piece of text sounds consistent regardless of topic.
   */
  voiceGuidelines: string
  /** Overused AI-marketing-copy phrases to steer generated text away from. */
  bannedWords: readonly string[]
  /**
   * Real, verified facts/statistics the model MAY cite if genuinely relevant
   * to a given topic — never required, never to be paraphrased into a
   * different number. Providing a fixed list prevents the model from
   * inventing a plausible-sounding but fabricated statistic.
   */
  statistics: readonly string[]
  /**
   * What each blog category should actually cover — keyed by the exact
   * strings from src/app/dashboard/new's category dropdown. Grounds the
   * outline/copy generation in what this specific category is for, instead
   * of leaving the model to guess from the category label alone.
   */
  categoryBriefs: Readonly<Record<string, string>>
  /**
   * What a blog hero/inline image should show INSTEAD of the brand's
   * physical subject, for a post whose topic isn't actually about the
   * mobile unit itself (core/scene.ts's isContainerRelevant gate) — keyed
   * by the exact same category strings as categoryBriefs. Kept separate
   * from containerDescriptor/interiorDescriptor since these describe
   * generic, non-branded scenes (food, people, community) with no fixed
   * real-world subject to preserve, so no reference photo is attached —
   * pure text-to-image, which is what actually varies from generation to
   * generation instead of always editing the same handful of real photos.
   * Optional: an unmatched/missing category falls back to a generic
   * documentary-photo hint (see core/compose.ts).
   */
  categoryVisualHints?: Readonly<Record<string, string>>
  /**
   * Fixed, verbatim physical description of the brand's real-world subject
   * (a vehicle, a storefront, a container). Deliberately never left to an
   * LLM to reinvent per-post — every image that includes this subject
   * splices in this exact text, so the described shape/color/logo can't
   * drift between generations even though the surrounding scene changes.
   */
  containerDescriptor: string
  /**
   * Fixed, verbatim physical description of the subject's INTERIOR — same
   * purpose as containerDescriptor, but for interior-scene images. Kept
   * separate rather than folded into containerDescriptor since the two
   * describe different, non-overlapping physical spaces (paired with
   * referenceImages.interior, never referenceImages.exterior).
   */
  interiorDescriptor: string
  /**
   * Appended to every image prompt as a second line of defense against text
   * baked into the image (see worker/src/index.ts git history — a
   * "Label: value." colon-style prompt was confirmed live to make the image
   * model render the label as on-image text). Used only when NO reference
   * image is attached — see noNewTextInstruction for when one is.
   */
  noTextInstruction: string
  /**
   * Used instead of noTextInstruction whenever a real reference photo is
   * attached (Flux Kontext edit mode). The reference photo's own real,
   * correctly-rendered logo/signage should be preserved, not stripped —
   * telling the model "no logos, no text at all" while also handing it a
   * photo covered in real branding is a contradiction that can make it
   * ignore one instruction or the other unpredictably.
   */
  noNewTextInstruction: string
  /** Rotated across generations (deterministically, keyed by pipeline id —
   *  see core/rotation.ts) so images don't all default to the same mood. */
  moods: readonly ImageMood[]
  /** Fixed CTA bar text rendered along the bottom edge of every
   *  image_style: 'infographic' image — e.g. "Visit fresh-can.com". */
  ctaBarText: string
  /**
   * The brand's real typeface, described in words an image model can act on
   * (image models can't be told to literally use a named font file the way
   * a design tool can, but naming the real font plus its visual character
   * gets closer than a generic "clean sans-serif"). Used for BOTH the
   * headline and subtitle text in an 'infographic'-style image — kept here
   * rather than hardcoded in core/compose.ts so a rebranded install can
   * swap in its own real typeface instead of inheriting Fresh-CAN's.
   */
  typographyDescriptor: string
  /**
   * Precise color description of the solid bar the CTA text sits on, e.g.
   * "a solid charcoal-black band, similar to hex #1F1F1F" — from the
   * brand's actual color palette, not a generic "dark" guess. Same
   * per-brand-swappable reasoning as typographyDescriptor above.
   */
  ctaBarColorDescriptor: string
  /**
   * Optional, user-selected creative angle/hook for a single post (
   * content_jobs.content_angle) — keyed by the exact option values from
   * src/app/dashboard/new's Content Angle dropdown, same pattern as
   * categoryBriefs. Spliced into the image_post caption prompt always, and
   * into generate_ad_copy's prompt (the shared headline/subtitle baked into
   * an 'infographic'-style image) — sharing one brief between both prompts
   * is what keeps the on-image text and the caption thematically cohesive
   * instead of two independent, unrelated guesses. Optional on the type so
   * existing brand fixtures/tests don't need updating for it.
   */
  adAngleBriefs?: Readonly<Record<string, string>>
  /**
   * ElevenLabs voice ID for video narration, one per supported language —
   * a single fixed voice per language (no rotation, no gender variation,
   * no per-job selection); see synthesizeVoice.ts's lookup. An empty/missing
   * entry makes synthesizeVoice.ts fail loudly (a clear "no voice id
   * configured" error) instead of silently calling ElevenLabs with an
   * invalid id and getting a confusing 404 back — leave a language's entry
   * blank rather than guess an ID if a real one isn't available yet.
   */
  videoVoiceIds?: Readonly<Partial<Record<'EN' | 'FR', string>>>
  referenceImages: {
    /**
     * Real exterior photos of the subject, e.g. the truck from several
     * angles. One is picked deterministically per image (see
     * core/rotation.ts), independently for hero vs. inline, so a blog
     * post's two photorealistic images don't have to look like they're the
     * same shot. May be empty (no photos uploaded yet) — every composer
     * handles that by falling back to plain text-to-image generation.
     */
    exterior: readonly BrandReferenceImage[]
    /**
     * Real interior photos of the subject — paired with interiorDescriptor,
     * never containerDescriptor. Which pool (exterior vs interior) a given
     * image draws from is itself picked deterministically — see
     * core/compose.ts's pickSceneType. May be empty (no photos uploaded).
     */
    interior: readonly BrandReferenceImage[]
  }
}
