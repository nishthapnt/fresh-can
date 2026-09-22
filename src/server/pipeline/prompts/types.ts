// The brand-swappable prompt structure. Everything a new client's install
// needs to customize for image generation lives on this one type — to
// re-brand for another company, copy brand/fresh-can.ts to
// brand/<new-brand>.ts, fill in these fields for the new brand, and switch
// the import in prompts/index.ts. No database table, no runtime toggle —
// see PROGRESS.md for why this project deliberately chose that over a
// brand_profiles table.
//
// This file holds structured brand DATA only — no assembled prose, no
// per-category or per-angle creative direction (that's the plan's job, not
// the brand's — see docs/PROMPT_ARCHITECTURE.md's layer model). Composers
// (prompts/core/*) select from and assemble these fields; this file never
// decides what a scene is about.

// 'photo': strictly no text baked into the image (default — the existing
// Flux Kontext pipeline, unchanged). 'infographic': headline/subtitle/logo/
// CTA text rendered onto the image via a different, text-capable model
// (nano-banana-2, not Flux Kontext — see adapters/nanoBanana.ts). This is a
// per-job value the user selects in the dashboard form (content_jobs.
// image_style) — never an automatic per-category guess; an earlier
// automatic version of this concept was tried and removed for poor image
// quality (Flux Kontext garbling text it had to invent from scratch).
export type ImageStyle = 'photo' | 'infographic'

/**
 * Compact, per-scene visual-continuity bookkeeping — added alongside a
 * scene's existing visual_description/shot_notes/narration_intent (never a
 * DB migration: persisted inside video_scenes.narration_intent, which
 * already stores an arbitrary JSON object — see generateScript.ts's
 * upsertVideoScenes call). Deliberately tiny: only the handful of facts that
 * actually matter for keeping scene N+1's image consistent with scene N's —
 * never a full scene description of its own. `hands`/`objects`/
 * `new_entities` are free-text/short-string lists, not a taxonomy, by
 * design: this only needs to be specific enough for a human-readable
 * continuity clause (composeSceneImagePrompt), not a structured schema
 * downstream code branches on.
 */
export interface SceneVisualState {
  /** Count of distinct people visible in this scene. */
  people?: number
  /** Whose hands/arms are shown, e.g. "the woman only", "none visible" —
   *  never left implying a hand with no owner. */
  hands?: string
  /** Visually significant physical objects in frame (compact — a few words each). */
  objects?: string[]
  /** Subset of `objects` that are genuinely new in THIS scene, not carried
   *  over from the previous one. */
  new_entities?: string[]
}

/**
 * Layer 2 (PROMPT_REFACTOR_BRIEF.md §4.3) — video plan additions, all
 * optional/lenient (Phase 3: not yet validated as a strict contract — that's
 * Phase 5's guard layer). Field names stay snake_case to mirror the JSON the
 * model returns directly, same convention `ScriptSceneOutput`/
 * `SceneVisualState` already use. Persisted inside `video_scenes.
 * narration_intent`'s existing jsonb alongside `visual_state` — no migration.
 */
export interface VideoScriptStory {
  hook?: string
  arc?: string
  resolution?: string
  cta?: string | null
}

/** AI-authored per PROMPT_REFACTOR_BRIEF.md §4.3 — replaces the fixed
 *  neutral mood default `compose.ts`'s `moodClause` falls back to when no
 *  plan exists (Phase 1 §6.3). Phase 4 wires this into the scene-image/
 *  scene-video composers; until then it's generated and stored, not yet
 *  read downstream. */
export interface VideoScriptLook {
  time_of_day?: string
  lighting?: string
  palette?: string
  style_direction?: string
  camera_language?: string
}

/** Locked physical description reused verbatim across every scene that
 *  contains this person — the backbone of cross-scene continuity (brief
 *  §4.3/§9.2). Not yet spliced into any image prompt (Phase 4). */
export interface CastBibleEntry {
  id: string
  role?: string
  age_range?: string
  appearance?: string
  wardrobe?: string
  distinguishing_details?: string
}

export interface VideoLocation {
  id: string
  description?: string
  continuity_details?: string
}

/**
 * Layer 2 (PROMPT_REFACTOR_BRIEF.md §4.3) — image-post's plan, produced by
 * the new `steps/image/planImage.ts` (image_post had no Layer 2 planning
 * step before Phase 3). Not yet read by `composePhotoPrompt`/
 * `composeAdCopySystemPrompt` (Phase 4).
 */
export interface ImagePostPlan {
  designIntent: string
  subject: string
  composition: string
  unitPresence: 'none' | 'background' | 'featured'
  /** One sentence, honest and specific to this image — brief §15's own
   *  acceptance criterion: unit presence must be LLM-decided "with
   *  rationale," not a bare enum (added Phase 8, closing a gap found
   *  auditing against that checklist). */
  unitPresenceRationale: string
  setting: 'exterior' | 'interior' | 'unrelated'
  containsFood: boolean
  castDescription?: string
  textPlan: { headline: string; subtitle: string } | null
  /** Always 'top-right' today (brief §10) — kept as a field, not a
   *  constant, so a future brand/layout with a different watermark
   *  position doesn't need a new type. */
  safeZone: 'top-right'
}

/**
 * Layer 1 (PROMPT_REFACTOR_BRIEF.md §4.2) — the admin's raw idea, interpreted
 * into a structured brief. Produced once per pipeline generation by
 * `steps/shared/interpretIntent.ts`, shared by all three content types.
 *
 * `unitRelevance` here is a BRIEF-level (whole-content) judgment, distinct
 * from the per-scene/per-image `unitPresence` rubric a Layer 2 plan will
 * carry (PROMPT_REFACTOR_BRIEF.md §8, 'featured'/'background'/'none') — a
 * `central` brief can still have individual scenes where the unit doesn't
 * belong (an establishing shot of produce, say), and vice versa.
 */
export interface CreativeBrief {
  /** What the admin is actually trying to do — inferred, never picked from
   *  a fixed list (e.g. marketing, awareness, food/nutrition education,
   *  community story, product/how-it-works explainer). */
  intent: string
  /** The single idea the viewer must leave with. */
  coreMessage: string
  audience: string
  emotionalTone: string
  /** What the viewer should think, feel, or do after seeing this. */
  desiredResponse: string
  unitRelevance: {
    value: 'central' | 'incidental' | 'none'
    /** One sentence, honest and specific to this idea — never boilerplate. */
    rationale: string
  }
  /** Where the admin's idea was thin, what was added to make it stronger —
   *  must elevate, never override, anything the admin stated explicitly.
   *  Empty string if the idea was already specific and complete. */
  improvements: string
  /** Anything the admin stated that is non-negotiable and must be preserved
   *  exactly. Empty string if none. */
  constraintsFromAdmin: string
}

/**
 * A real photo of the brand's physical subject. `whatItShows` is a pure,
 * factual description of what the camera captured — never a correction or
 * an instruction. Anything real-but-not-brand-canonical the photo happens
 * to show (extra decals, URL text, a second wordmark, etc.) goes in
 * `disregard` instead, so composers can tell the model exactly what to
 * ignore without that correction language leaking into the factual
 * description itself.
 */
export interface BrandReferenceImage {
  /** Publicly fetchable URL — the image adapter's edit-source input must be
   *  able to download it. */
  url: string
  /** What this specific photo's camera actually shows (angle, framing,
   *  what's in view) — factual only, never a directive about the NEW
   *  image's own composition. */
  whatItShows: string
  /** Real elements visible in this specific photo that are NOT part of the
   *  brand's canonical design (e.g. an extra decal, URL text, a second
   *  wordmark) — named explicitly so nothing is left for the model to
   *  notice and try to faithfully reproduce on its own. */
  disregard: readonly string[]
}

/**
 * The brand's physical unit, described at three tiers so a composer spends
 * characters only where the unit's presence actually warrants it (see
 * docs/PROMPT_ARCHITECTURE.md's unit-presence rubric).
 */
export interface UnitDescriptor {
  /** The minimum that makes the vehicle recognisably the brand's — form
   *  factor, colour, wordmark placement. Used for background/incidental
   *  appearances only. */
  identity: string
  /** The complete structural rule set — every face, every opening, what
   *  must never appear. Used when the unit is a featured subject. */
  full: string
  /** Interior layout and fixtures. Used only for interior scenes. */
  interior: string
  /** The wordmark's own literal text, standalone — e.g. "Fresh CAN" — for
   *  the rare prompt fragment that needs to quote it by itself rather than
   *  embed it in a fuller descriptive sentence (identity/full/interior
   *  already spell it out in prose; this exists so a composer never has to
   *  hardcode it directly — brief G4). */
  wordmarkText: string
}

export interface BrandProfile {
  name: string
  /**
   * What the brand does, for whom, and how the actual customer journey
   * works — spliced into every text-generation prompt (outline, copy,
   * caption) so the model has real company context instead of writing from
   * the topic string alone. Must be unambiguous about the business model
   * (see journey/positiveVisualTruths/businessModelNegatives below) — a
   * vague mission statement is what lets a model invent wrong scenes
   * (service windows, cashiers, market stalls).
   */
  missionStatement: string
  /**
   * A short, neutral, purely-factual fallback for missionStatement — used
   * ONLY by composeVideoScriptSystemPrompt when a user-submitted scene idea
   * leads the prompt (see that function). Keeps just the physical facts (what
   * the unit is, how customers use it) a story might legitimately need for
   * accuracy if it touches the unit or app at all, without the fuller
   * mission framing competing with an unrelated scene idea as a second
   * topic. Optional: falls back to missionStatement itself when unset.
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
   * The real, step-by-step customer journey, in order — the ground truth a
   * "how it works" scene or script must get right (never invent a
   * different mechanism, e.g. a per-item scan or a payment QR).
   */
  journey: readonly string[]
  /** Real visual facts about what a genuine scene involving the unit looks
   *  like (entry, interior, exit, product quality) — positive guidance,
   *  paired with forbiddenInScene's negatives. */
  positiveVisualTruths: readonly string[]
  /**
   * Atomic, visual, non-negotiable facts about what this business is NOT —
   * enforced in every visual prompt path that could plausibly depict the
   * business (not just unit-featuring ones). Each entry is a short,
   * standalone rule, never a paragraph, so a composer can include exactly
   * the ones relevant to a given scene without duplicating prose.
   */
  businessModelNegatives: readonly string[]
  /** The brand's physical unit, tiered — see UnitDescriptor. */
  unit: UnitDescriptor
  /** Atomic rules for what must never appear ON the unit itself (extra
   *  openings, extra branding, wrong colour, etc.). */
  forbiddenOnUnit: readonly string[]
  /** Atomic rules for what must never appear in a scene, unit-independent
   *  (cashiers, checkout counters, queues, carts, place names/landmarks). */
  forbiddenInScene: readonly string[]
  /**
   * Appended to every image prompt as a second line of defense against text
   * baked into the image. Used only when NO reference image is attached —
   * see noNewTextInstruction for when one is.
   */
  noTextInstruction: string
  /**
   * Used instead of noTextInstruction whenever a real reference photo is
   * attached (edit mode). The reference photo's own real, correctly-
   * rendered logo/signage should be preserved, not stripped — telling the
   * model "no logos, no text at all" while also handing it a photo covered
   * in real branding is a contradiction that can make it ignore one
   * instruction or the other unpredictably.
   */
  noNewTextInstruction: string
  /** Fixed CTA bar text rendered along the bottom edge of every
   *  image_style: 'infographic' image — e.g. "Visit fresh-can.com". */
  ctaBarText: string
  /**
   * The brand's real typeface, described in words an image model can act on
   * (image models can't be told to literally use a named font file the way
   * a design tool can, but naming the real font plus its visual character
   * gets closer than a generic "clean sans-serif"). Kept here rather than
   * hardcoded in core/compose.ts so a rebranded install can swap in its own
   * real typeface instead of inheriting this brand's.
   */
  typographyDescriptor: string
  /**
   * Precise color description of the solid bar the CTA text sits on, e.g.
   * "a solid charcoal-black band, similar to hex #1F1F1F" — from the
   * brand's actual color palette, not a generic "dark" guess.
   */
  ctaBarColorDescriptor: string
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
     * Real exterior photos of the subject, e.g. the vehicle from several
     * angles. One is picked deterministically per image (see
     * core/rotation.ts), independently for hero vs. inline, so a blog
     * post's two photorealistic images don't have to look like they're the
     * same shot. May be empty (no photos uploaded yet) — every composer
     * handles that by falling back to plain text-to-image generation.
     */
    exterior: readonly BrandReferenceImage[]
    /**
     * Real interior photos of the subject — paired with unit.interior,
     * never unit.full. Which pool (exterior vs interior) a given image draws
     * from is itself picked deterministically — see core/compose.ts's
     * pickSceneType. May be empty (no photos uploaded).
     */
    interior: readonly BrandReferenceImage[]
  }
}
