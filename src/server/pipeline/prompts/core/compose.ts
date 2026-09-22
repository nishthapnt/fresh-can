// Image-prompt assembly. The pattern: never let free-form job data (topic,
// scene notes, regen instructions) be the ONLY thing that decides what a
// generated image looks like. Instead, decide composition (mood, whether the
// branded subject appears) deterministically in code, then splice the
// brand's fixed, verbatim descriptions in around the job-specific scene text.
// This is what makes the container/logo look the same across every image
// that includes it, and what makes reference-image usage automatic instead
// of something every call site has to remember to wire up.
import type { BrandProfile, BrandReferenceImage, ImageStyle, SceneVisualState } from '../types'
import { pickDeterministic } from './rotation'
import { isContainerRelevant, isVideoSceneAboutUnit } from './scene'

export interface ImageComposition {
  prompt: string
  referenceImageUrl?: string
}

interface StyleInputs {
  /** 'photo' (default): strictly no on-image text, same as this pipeline
   *  has always done. 'infographic': headline/subtitle/logo/CTA text
   *  rendered onto the image — user-selected per job, see
   *  content_jobs.image_style. Requires headline+subtitle. */
  imageStyle?: ImageStyle
  /** Required when imageStyle === 'infographic'. Max ~6 words. */
  headline?: string
  /** Required when imageStyle === 'infographic'. 2-5 words. */
  subtitle?: string
}

interface BlogImageJob extends StyleInputs {
  pipelineId: string
  topic: string
  category: string
  /** The dashboard's "Your Scene Idea" free-text field (content_jobs.
   *  scene_notes) — required going forward (see src/app/dashboard/new's
   *  submit validation), so this is normally always present for a new job.
   *  Still typed optional/nullable here to keep composing safe for any
   *  pre-existing job created before the field became required. When
   *  present, it's the creative brief the scene is built around — see
   *  SCENE_IS_CREATIVE_BRIEF — not a light, non-binding influence. */
  sceneNotes?: string | null
}

interface PhotoJob extends StyleInputs {
  pipelineId: string
  topic: string
  category: string
  /** Scene descriptors already assembled by the caller — required Your
   *  Scene Idea text plus any clarifying-question answers, or a topic/
   *  category fallback for a pre-existing job with no scene_notes — see
   *  src/inngest/functions/image.ts's photoScene(). This is the creative
   *  brief the photo is built around (see SCENE_IS_CREATIVE_BRIEF), not one
   *  of several interchangeable descriptors. */
  scene: string
  regenInstructions?: string | null
}

// A single neutral default — not a rotating list of canned moods. Until
// Layer 2's plan-level `look` object exists (PROMPT_REFACTOR_BRIEF.md §4.3),
// every job is effectively "legacy", so this is the brief's own stated
// fallback (§6.3), not a temporary stand-in for something richer here.
const NEUTRAL_MOOD_DEFAULT = 'Natural daylight, true-to-life color, calm and unstaged.'

/**
 * A default lighting/atmosphere suggestion — a FALLBACK ONLY, for when the
 * scene description elsewhere in the prompt doesn't already establish its
 * own lighting, time of day, or mood. Explicitly conditional so it never
 * overrides a scene's own stated lighting/mood, only fills the gap when one
 * isn't given.
 */
function moodClause(): string {
  return `If unspecified, default mood: ${NEUTRAL_MOOD_DEFAULT}`
}

/** Picks one photo from a specific pool (exterior or interior). Independent
 *  seed per asset (hero/inline/photo) => each can land on a different real
 *  angle, unlike mood which is shared per pipeline. */
function pickReferenceFrom(pool: readonly BrandReferenceImage[], seed: string): BrandReferenceImage | undefined {
  return pool.length > 0 ? pickDeterministic(seed, pool) : undefined
}

type SceneType = 'exterior' | 'interior'

/** Decides exterior vs. interior for one image, deterministically. Falls
 *  back to whichever pool actually has photos if only one does, so an
 *  empty interior pool (e.g. before those photos are uploaded) can never
 *  pick a scene type with nothing to attach. */
function pickSceneType(brand: BrandProfile, seed: string): SceneType {
  const hasExterior = brand.referenceImages.exterior.length > 0
  const hasInterior = brand.referenceImages.interior.length > 0
  if (hasExterior && hasInterior) return pickDeterministic<SceneType>(seed, ['exterior', 'interior'])
  return hasInterior ? 'interior' : 'exterior'
}

/**
 * The text layer for image_style: 'infographic' — headline, subtitle, and
 * the CTA bar, all spliced in as the LAST thing in the prompt (same
 * position that noText/noNewTextInstruction occupy for 'photo' style).
 * Confirmed live (2026-09-10) with nano-banana-2 that this exact structure
 * (headline zone, subtitle below it, bottom CTA band) renders correctly
 * spelled text reliably — this is NOT safe to send to Flux Kontext; callers
 * must route 'infographic'-style jobs to a text-capable model (see
 * adapters/nanoBanana.ts).
 * Typography and the CTA bar's color come from the brand file
 * (typographyDescriptor/ctaBarColorDescriptor) rather than being hardcoded
 * here, so this stays generic across brands — see fresh-can.ts for why
 * those specific values (Manrope, Charcoal #1F1F1F) were chosen, sourced
 * from the brand's real guidelines doc.
 *
 * No corner-logo instruction here (removed 2026-09-19, was
 * brand.logoDescriptor): the AI model's own attempt at drawing the logo
 * risked a plausible-but-wrong rendering (see logoDescriptor's old incident
 * notes in fresh-can.ts's git history) — the real logo asset is now
 * composited on top-right after generation instead, see
 * adapters/storage.ts's use of lib/watermark.ts.
 */
function infographicTextLayer(brand: BrandProfile, headline: string, subtitle: string): string {
  return (
    `In the upper portion of the frame, in bold clean white letters using ${brand.typographyDescriptor} ` +
    `the text "${headline}" appears as a headline, sized moderately, spelled exactly as written with no ` +
    `typos. Directly below it, smaller white text in the same typeface reads "${subtitle}" as a subtitle, ` +
    `spelled exactly as written. Along the bottom edge, ${brand.ctaBarColorDescriptor} ` +
    `spans the full width containing the white text "${brand.ctaBarText}", centered, spelled exactly as ` +
    'written. Do not add any other text, caption, or typography anywhere else in the image beyond what is ' +
    'specified above. Photorealistic, 4:5 vertical format, polished advertisement composition.'
  )
}

/** Appends the correct trailing text-instruction block for the job's style
 *  — the one shared decision point every composer routes through, so
 *  'infographic' can never accidentally fall through to a plain noText
 *  instruction (which would contradict the headline/subtitle just built).
 *  `noTextVariant` lets a caller swap in a different no-reference-image
 *  instruction than the blanket brand.noTextInstruction — see
 *  composeBlogImage's non-container branch, where the scene hint may
 *  already have told the model the truck can appear in the background, so
 *  a flat "no logos anywhere" here would directly contradict it. */
function textLayerFor(
  brand: BrandProfile,
  job: StyleInputs,
  referenceImageUrl: string | undefined,
  noTextVariant: string = brand.noTextInstruction,
): string {
  if (job.imageStyle === 'infographic') {
    if (!job.headline || !job.subtitle) {
      throw new Error('composeImage: imageStyle "infographic" requires both headline and subtitle')
    }
    return infographicTextLayer(brand, job.headline, job.subtitle)
  }
  return referenceImageUrl ? brand.noNewTextInstruction : noTextVariant
}

// Brand-agnostic fallback for a non-container blog scene — brief-mandated
// deletion of the per-category creative-direction map (categoryVisualHints,
// PROMPT_REFACTOR_BRIEF.md §6.2); every non-container scene now gets this
// same neutral hint regardless of category, with only the identity tier of
// the unit description (brief §4.1) pulled in for the optional background
// mention.
function nonContainerSceneHint(brand: BrandProfile): string {
  return (
    'Photorealistic documentary-style photo capturing a genuine, specific moment relevant to the topic above ' +
    `— real people, real food, or a real neighbourhood setting as appropriate. Natural lighting. If the ` +
    `${brand.name} vehicle plausibly fits the scene, it must be built to its real, correct structure — ` +
    `${brand.unit.identity} — never any other vehicle shape, color, or logo, never forced in, and never the ` +
    `main subject. Every other vehicle in the scene must stay completely unbranded — never place the ` +
    `${brand.name} wordmark or logo on it.`
  )
}

// The trailing text-instruction used by composeBlogImage's non-container
// branch instead of the blanket brand.noTextInstruction. That blanket
// instruction ("no logos, no watermarks... anywhere") directly contradicts
// nonContainerSceneHint, which explicitly permits the brand's real vehicle
// to appear in the background — sending both in one prompt is exactly the
// kind of contradiction that leaves the model free to invent an off-model
// result. This keeps the same "don't invent text" framing but carves out
// one exact exception, built from unit.identity so it can't drift into a
// shorthand, and restates the no-other-vehicle rule as the very last thing
// the model reads.
function backgroundBrandingInstruction(brand: BrandProfile): string {
  return (
    'Photorealistic, natural lighting, documentary style. Absolutely no invented text, words, letters, ' +
    'captions, titles, or typography anywhere in the image. The only exception is branding: if the ' +
    `${brand.name} vehicle naturally fits the scene, it must be built to this exact structure — ` +
    `${brand.unit.identity} — showing only its own real wordmark exactly as just described. Every ` +
    'other vehicle in the image must stay completely unbranded — never place this wordmark or logo on it.'
  )
}

// Shared by every composer below that attaches a real truck/character-ref
// photo as a Flux Kontext edit source. Edit-mode defaults toward
// reproducing its input when the surrounding prompt doesn't give it
// something genuinely new to build — confirmed live (2026-09-18, see
// containerSceneContext below) as near-verbatim reproduction of the
// reference photo's own background/composition. Spelling out that the
// photo is a STRUCTURAL guide (shape/color/logo placement) rather than a
// source to copy wholesale is what stops that — kept as one shared
// constant so this framing can't drift between call sites.
// Re-tightened 2026-09-19: briefly restored to fuller wording on the
// assumption that KieImageGenerator (unlike the Market endpoint
// KieSceneImageGenerator used before) had no prompt-length cap at all —
// wrong. A real generation confirmed KieImageGenerator has its own cap
// too, just a much more generous one: "The prompt word cannot exceed 3000
// characters" (its literal error text), versus the Market endpoint's much
// lower, never-numerically-confirmed limit. composeSceneImagePrompt's
// FIXED overhead alone (before any scene content) was measured at ~3490
// chars with the fuller wording — already over the real limit with zero
// scene content added. Re-tightened here (and containerDescriptor
// trimmed too, below) to leave real headroom under 3000 for the actual
// variable scene content. Kept both anchor phrases ('only as a guide' /
// 'never as a literal photo to copy') exactly, since compose.test.ts
// asserts on them directly.
const REFERENCE_IS_GUIDE_NOT_COPY =
  "Use the reference photo only as a guide for the vehicle's shape, structure, and color — never as a " +
  "literal photo to copy. Do not reuse its background, framing, composition, or people; build a new scene " +
  'instead.'

/**
 * Describes what a reference photo actually shows, scoped explicitly as
 * being about the ATTACHED INPUT image — never as a camera/composition
 * instruction for the new output. Added 2026-09-19: a `framing` string
 * (e.g. "three-quarter front view as the truck arrives and parks at the
 * curb") was being pushed as a bare sentence with no such scoping, so the
 * model had no way to tell it apart from an actual instruction for the new
 * image's own camera work — confirmed live, this is exactly what made a
 * user's explicit split-scene composition request get ignored in favor of
 * a single ordinary three-quarter shot matching the reference's own
 * framing. Only used where a real, competing scene description exists
 * (composeBlogImage/composePhotoPrompt) — composeCharacterRefPrompt has no
 * scene to compete with (it's deliberately just "a clean reference photo of
 * the vehicle"), so it still uses the bare framing string as a literal
 * instruction there.
 */
// Real elements a specific reference photo shows that aren't part of the
// brand's canonical design (see BrandReferenceImage.disregard) — named
// explicitly as their own sentence so nothing is left for the model to
// notice and try to faithfully reproduce on its own.
function disregardClause(disregard: readonly string[]): string {
  if (disregard.length === 0) return ''
  return (
    `This particular photo also shows ${disregard.join(', ')} — none of that is part of the vehicle's real, ` +
    `correct design; disregard ${disregard.length > 1 ? 'all of it' : 'it'}.`
  )
}

function describeReferencePhoto(reference: BrandReferenceImage): string {
  const disregard = disregardClause(reference.disregard)
  return (
    `The attached reference photo shows: ${reference.whatItShows}${disregard ? ` ${disregard}` : ''} That is ` +
    "a description of the INPUT photo only, so its shape, structure, and color can be reproduced accurately " +
    "— it does not dictate this image's own camera angle, composition, or story, which come entirely from " +
    'the scene description above.'
  )
}

// The dashboard's "Your Scene Idea" field (content_jobs.scene_notes) is now
// a required creative brief for both image_post's photo and blog's
// hero/inline images — it decides the actual subject, setting, AND style
// (candid vs. editorial, posed vs. documentary, single shot vs. a
// structured/split composition — whatever the user actually describes).
// Everything else in these prompts (the unit descriptor, forbiddenOnUnit,
// etc.) is brand IDENTITY — fixed constraints on what a brand element must
// look like IF it appears — never a competing creative direction. Without
// this instruction the model defaults to treating the branded subject as
// the reason the image exists, which is exactly what makes generated
// content read as a generic advertisement instead of whatever the user
// actually asked for.
//
// Reworded 2026-09-19: this used to also mandate "must read as a genuine,
// candid moment... never a posed, polished advertisement" — a hardcoded
// STYLE dictate, not a brand-identity constraint. Confirmed live: a user
// explicitly asked for "clean editorial photography... professional
// social-impact campaign aesthetic" (a split-scene composition) and got a
// single generic candid street photo instead — the brand's own style
// mandate was directly fighting the user's explicit request. Brand-identity
// rules enforce what the truck/logo/container must look like when they
// appear; they must never dictate mood, composition, or overall
// photographic style — that's the scene description's call alone.
// Re-tightened 2026-09-19 — see REFERENCE_IS_GUIDE_NOT_COPY's comment just
// above for why "restore to fuller wording, KieImageGenerator has no cap"
// turned out wrong (it has a real, confirmed 3000-char cap). Kept the
// anchor phrase ('never as the reason this scene exists') and the full
// enumerated style list exactly, since both are load-bearing: the style
// list is what stops this clause from silently reintroducing the "candid
// moment" style mandate it replaced (see this constant's own history
// above), and compose.test.ts asserts on the anchor phrase directly.
const SCENE_IS_CREATIVE_BRIEF =
  'Brand details are constraints on correctness if they appear — never as the reason this scene exists, ' +
  'and never as a directive about the overall photographic style, mood, or composition; the scene\'s own ' +
  'style (documentary, editorial, posed, graphic, split-composition, or otherwise) governs.'

// A grocery-access brand can never show food looking anything less than
// fresh — added 2026-09-19 after generated photos of produce/groceries came
// back looking dirty, bruised, or cluttered. Applied unconditionally
// everywhere food could plausibly appear (image_post's photo, blog's
// hero/inline, every video scene), not just the produce-focused category
// hints, since a user-authored scene idea can put food into any scene
// regardless of category.
// Re-tightened 2026-09-19 — see REFERENCE_IS_GUIDE_NOT_COPY's comment
// above for why. Kept both anchor phrases ('clean, fresh, tidy, and
// appetizing' / 'Never render food looking dirty, rotten, messy, or
// unappetizing') exactly, and the full defect list, since compose.test.ts
// asserts on them directly.
const FOOD_MUST_LOOK_CLEAN =
  'Any food, produce, or packaged groceries must look clean, fresh, tidy, and appetizing — no dirt, ' +
  'bruising, wilting, mold, spills, or clutter. Never render food looking dirty, rotten, messy, or ' +
  'unappetizing, regardless of the scene.'

// Added 2026-09-19 after a real video generation depicted people gathered
// and eating dinner in the middle of a road — composeVideoScriptSystemPrompt
// now carries the primary fix (a plausibility constraint at scene-planning
// time, before visual_description is ever written), but this is a second
// line of defense at image-render time, the same layered-constraint pattern
// FOOD_MUST_LOOK_CLEAN already uses: if a scene's visual_description is
// ever ambiguous enough to admit an implausible reading, this catches it
// here too instead of depending on the script step alone.
// Tightened 2026-09-19 — see REFERENCE_IS_GUIDE_NOT_COPY's comment above
// for why (composeSceneImagePrompt's overall length, KieImageGenerator's
// real 3000-char cap). Kept the exact scenario named, since specificity is
// what makes a constraint like this land rather than read as generic
// boilerplate.
// Shortened 2026-09-19 (same rule, only connecting prose cut) to make room
// for NO_UNSCRIPTED_PEOPLE/the containerDescriptor customer-window addition
// without exceeding KieImageGenerator's real ~3000-char cap — see
// REFERENCE_IS_GUIDE_NOT_COPY's comment above for that cap's history. Kept
// both anchor phrases ('physically plausible and safe' / 'middle of a
// road') exactly, since compose.test.ts asserts on them directly.
const PHYSICALLY_PLAUSIBLE_SCENE =
  'The setting must be physically plausible and safe — never implausible or unsafe, like people eating in ' +
  'the middle of a road.'

// Added 2026-09-19 — a production-value QUALITY floor, not a style
// dictate: SCENE_IS_CREATIVE_BRIEF already forbids dictating overall
// mood/style/composition (that's the scene description's call alone), but
// nothing was asking for basic cinematographic craft — framing, depth,
// lighting quality — regardless of which style the scene actually picks.
// Worded as elevating whatever style is already specified, never
// replacing it, the same "constraint on quality, never on creative
// direction" pattern FOOD_MUST_LOOK_CLEAN already uses.
// Shortened 2026-09-19, same reason/anchors kept as PHYSICALLY_PLAUSIBLE_SCENE
// above.
const CINEMATIC_QUALITY =
  'Shot with real cinematographic craft — framing, depth of field, lighting — elevating whatever mood or ' +
  'style the scene above calls for, never a flat, snapshot-like composition.'

// Added 2026-09-19 after a real video scene (family browsing inside the
// unit) showed an unscripted person already inside restocking shelves —
// nothing was telling the model to stick to the cast the scene's own
// visual_description actually called for.
const NO_UNSCRIPTED_PEOPLE =
  'Do not add people beyond who the scene above describes — no extra staff, workers, or bystanders.'

// Added 2026-09-19 alongside the video-script-level version of this same
// rule (composeVideoScriptSystemPrompt) — a second line of defense at
// image-render time, same layered-constraint pattern as
// PHYSICALLY_PLAUSIBLE_SCENE/FOOD_MUST_LOOK_CLEAN: even a well-planned scene
// description can leave an image model free to fill visual gaps with
// plausible-looking invented objects (a random vehicle, sign, or prop) that
// have nothing to do with the actual story.
const NO_UNEXPLAINED_PROPS =
  'Do not add props, vehicles, signage, or background objects beyond what the scene above describes or ' +
  'clearly implies — no unexplained extras just to fill the frame.'

// Added 2026-09-21 — guards against the two most common AI-image rendering
// artifacts (malformed hands, uncanny/synthetic-looking skin), neither of
// which the existing guardrails above cover: those are all about scene
// LOGIC (what's in frame, whether it's plausible), never about whether a
// person the scene DOES call for renders like a real photo.
//
// Deliberately NOT in fixedParts below (unlike every other guardrail
// here) — real measurement showed composeSceneImagePrompt's fixed overhead
// was already within single-digit characters of KIE's 3000 cap for a
// perfectly ordinary scene, so protecting this unconditionally would have
// truncated real scene content on nearly every generation. This is a
// quality nice-to-have, not a correctness/safety constraint the way
// FOOD_MUST_LOOK_CLEAN or PHYSICALLY_PLAUSIBLE_SCENE are — so it's the
// FIRST thing the truncation cascade below drops when a scene runs long,
// included only when there's genuinely room. Kept intentionally short for
// exactly this reason: every character here is a character less available
// for real scene content on borderline-length scenes.
// Extended 2026-09-22 (still the same droppable, quality-not-safety tier —
// see this constant's own history just above) to also cover the visual-
// consistency failure modes a well-planned scene can still produce:
// unexplained/disembodied hands (the single most common defect — an object
// being "placed" or "held" with no established owner named), duplicate
// people, and floating objects. Kept in ONE constant with the existing
// hands/skin guardrail rather than as a separate fixedParts addition —
// fixedLen is already within single-digit characters of real headroom (see
// SCENE_IMAGE_PROMPT_CHAR_LIMIT's own comment), so a new unconditional
// clause would truncate real scene content on nearly every generation;
// this only costs headroom on the same borderline-length scenes the
// existing hands/skin guardrail already sometimes drops for.
const REALISTIC_PEOPLE =
  'Hands must be anatomically correct — never extra or missing fingers — and every visible hand or arm must ' +
  'clearly belong to an already-established person in the scene, never unexplained or disembodied; skin must ' +
  'look real, not synthetic. Only depict entities the scene establishes or clearly implies — never a ' +
  'duplicate of an established person or a floating, unexplained object.'

// Added 2026-09-19 as the OTHER half of composeSceneImagePrompt's new
// per-scene relevance gate (see showSubject there) — the explicit
// instruction a non-relevant scene gets INSTEAD of containerDescriptor/the
// character-ref photo. Fixes a real generation where the truck (and its
// branding) was hallucinated inside a family's kitchen and dining room —
// scenes composeSceneImagePrompt used to treat exactly like the ones that
// actually are about the truck.
const NO_SUBJECT_IN_SCENE =
  'This scene does not involve the Fresh-CAN truck or mobile unit — do not include it, its logo, or any ' +
  'Fresh-CAN branding anywhere in this image.'

// Added 2026-09-19 after a real character-ref generation (the ONE shared
// reference every scene in a pipeline then edits from) showed a duplicate,
// garbled second wordmark-like decal over an unexplained red blob graphic.
// containerDescriptor already says the side panels bear ONLY the wordmark,
// but restates it here as an explicit count, specifically for the one
// image this matters most on. "on the side panels only" (not "rear header
// bar" — corrected same day, see CONTAINER_DESCRIPTOR's own comment for
// why the logo's canonical location was simplified to the side only).
const ONE_WORDMARK_ONLY =
  'Exactly one "Fresh CAN" wordmark total, on the side panels only, as described above — no second or ' +
  'duplicate wordmark, decal, or graphic anywhere else on the vehicle.'

// Added 2026-09-18: the showSubject branch below used to push ONLY the
// truck/interior's fixed description plus the reference photo's own camera
// framing — nothing telling the model to actually build a new scene around
// it. Confirmed live: with edit-mode anchored to a reference photo and a
// prompt that just re-describes that same photo (same subject, same
// framing, same "keep this identical" language), the model has nothing to
// change and mostly reproduces the reference asset near-verbatim. The
// non-container branch (nonContainerSceneHint) and image_post's
// composePhotoPrompt (job.scene) both already give the model real scene
// content to depict; this is blog's container branch getting the same.
//
// Reworded 2026-09-19: this used to also mandate "real people going about
// their day... a new, lived-in scene... never a plain, empty, studio-style
// reproduction" — prescribing documentary realism as the STYLE, not just
// solving the "don't copy the reference verbatim" technical problem. The
// scene description elsewhere in the prompt (job.sceneNotes, now required)
// already supplies real content and whatever style the user actually
// wants; this only needs to point the model at using it instead of the
// reference's own background.
function containerSceneContext(job: BlogImageJob): string {
  return (
    `Build a genuinely new scene around the subject above, grounded in "${job.topic}" (${job.category}) and ` +
    `the scene description elsewhere in this prompt — never a plain reproduction of the reference photo's ` +
    `own background. ${REFERENCE_IS_GUIDE_NOT_COPY}`
  )
}

function composeBlogImage(
  brand: BrandProfile,
  job: BlogImageJob,
  kind: 'hero' | 'inline',
): ImageComposition {
  // An earlier version branched into a flat-infographic style for some
  // categories (icons/color only, no photorealism) — removed 2026-09-10:
  // confirmed live to produce poor-quality images even after two rounds of
  // prompt fixes for garbled on-image text. image_style: 'infographic'
  // (a per-job user choice, not an automatic per-category guess) replaced
  // it, routed to a different, text-capable model — see textLayerFor.
  const label = kind === 'hero' ? 'A hero image for a blog post' : 'A supporting inline photo for a blog post'
  // job.headline is the shared, once-per-pipeline outline's punchy title
  // (composeOutlineSystemPrompt) — read for both image styles (see
  // inngest/functions/blog.ts), not just 'infographic'. Folding it in here
  // gives the scene the post's actual specific angle instead of just raw
  // topic/category; it's descriptive context only, never rendered as
  // on-image text for 'photo' style (that's textLayerFor's job).
  const topicLine = job.headline
    ? `${label} about "${job.headline}" (${job.topic}), in the context of ${job.category}.`
    : `${label} about ${job.topic}, in the context of ${job.category}.`

  // Reversed 2026-09-11: blog hero/inline used to ALWAYS show the Fresh-CAN
  // unit regardless of topic — every image ended up looking like "the truck
  // from one of 5 fixed angles," since edit-mode anchors composition to
  // whichever real photo was picked. Gated the same way composePhotoPrompt
  // already was (isContainerRelevant, but defaultRelevant: false here —
  // blog is general content marketing, not inherently a grocery-access
  // post the way image_post's photo is), so the unit now only appears when
  // the topic is genuinely about visiting/using it — everything else gets
  // a real, topic-grounded scene instead (food/people/community — see
  // nonContainerSceneHint), with no reference photo to vary freely.
  const showSubject = isContainerRelevant(`${job.topic} ${job.category}`, false)

  const parts = [topicLine, moodClause(), FOOD_MUST_LOOK_CLEAN]
  // The dashboard's "Your Scene Idea" field — the creative brief this scene
  // is built around (see SCENE_IS_CREATIVE_BRIEF above the type declaring
  // this field). Absent only for a job created before the field became
  // required; the topic/category/mood system above still carries those.
  if (job.sceneNotes) {
    parts.push(
      `This is the creative direction for the image — build a genuine, specific scene around this idea: ` +
        `"${job.sceneNotes}". ${SCENE_IS_CREATIVE_BRIEF}`,
    )
  }
  let referenceImageUrl: string | undefined

  if (showSubject) {
    const sceneType = pickSceneType(brand, `${job.pipelineId}:${kind}:scene`)
    const descriptor = sceneType === 'interior' ? brand.unit.interior : brand.unit.full
    const pool = sceneType === 'interior' ? brand.referenceImages.interior : brand.referenceImages.exterior
    parts.push(descriptor)
    parts.push(containerSceneContext(job))
    const reference = pickReferenceFrom(pool, `${job.pipelineId}:${kind}`)
    if (reference) {
      parts.push(describeReferencePhoto(reference))
      referenceImageUrl = reference.url
    }
  } else {
    parts.push(nonContainerSceneHint(brand))
  }

  const noTextVariant = showSubject ? undefined : backgroundBrandingInstruction(brand)
  parts.push(textLayerFor(brand, job, referenceImageUrl, noTextVariant))

  return { prompt: parts.join(' '), referenceImageUrl }
}

export function composeHeroPrompt(brand: BrandProfile, job: BlogImageJob): ImageComposition {
  return composeBlogImage(brand, job, 'hero')
}

export function composeInlinePrompt(brand: BrandProfile, job: BlogImageJob): ImageComposition {
  return composeBlogImage(brand, job, 'inline')
}

interface CharacterRefJob {
  pipelineId: string
  /** Set by POST /video/regenerate { scope: "visuals" } — never present on
   *  a first-time generation. */
  regenInstructions?: string | null
}

/**
 * Video's ONE shared character-reference image (ARCHITECTURE.MD §4.2 step
 * 3) — establishes a single locked visual instance of the brand's subject
 * that every scene_image generation then edits FROM (via its file_url as
 * Flux Kontext's inputImage), instead of each scene independently picking
 * its own reference photo. This is the actual mechanism that keeps the
 * subject's appearance identical across every scene and both languages —
 * not a convention callers have to remember, but a real single row that all
 * scene generation reads.
 */
export function composeCharacterRefPrompt(brand: BrandProfile, job: CharacterRefJob): ImageComposition {
  // Shortened 2026-09-17 (was a ~180-char sentence explaining WHY this
  // image matters — "this exact image will be reused as the visual anchor
  // for every scene" describes downstream process, not visual content, so
  // Flux Kontext never needed it) — part of the same length-reduction as
  // containerDescriptor's own tightening, see that constant's comment.
  const parts = [
    `A clean, well-lit reference photo of the ${brand.name} branded vehicle.`,
    brand.unit.full,
    ONE_WORDMARK_ONLY,
  ]

  let referenceImageUrl: string | undefined
  // Deliberately the FIRST exterior photo always, not pickReferenceFrom's
  // per-pipeline rotation (2026-09-19) — this is the ONE locked reference
  // every scene in a pipeline then edits from, so cross-pipeline visual
  // variety doesn't matter here the way it does for blog/photo. What
  // matters is starting from the real photo that shows the logo in its
  // correct, simplified location with the LEAST competing real content in
  // the same frame — a real character-ref generation reproduced a garbled
  // second decal precisely because whichever photo it happened to land on
  // also showed other genuine branding (a front-face wordmark, a rear
  // header-bar wordmark, a QR-code panel) that nothing in the prompt had
  // ever named. fresh-can.ts's referenceImages.exterior is now ordered
  // with the full dead-on SIDE profile first for exactly this reason (see
  // its own comment) — one clean wordmark instance, nothing else
  // real-but-undocumented sharing the frame with it — and every entry's
  // whatItShows/disregard explicitly names and disregards whatever extra
  // real elements that specific photo shows, so this stays correct even if
  // a future asset swap changes what index 0 actually is.
  const reference = brand.referenceImages.exterior[0]
  if (reference) {
    parts.push(reference.whatItShows)
    const disregard = disregardClause(reference.disregard)
    if (disregard) parts.push(disregard)
    referenceImageUrl = reference.url
  }
  parts.push(referenceImageUrl ? brand.noNewTextInstruction : brand.noTextInstruction)
  if (job.regenInstructions) parts.push(`${job.regenInstructions}.`)

  return { prompt: parts.join(' '), referenceImageUrl }
}

interface SceneImageJob {
  pipelineId: string
  sceneNumber: number
  visualDescription: string
  shotNotes: string | null
  /** The character_ref asset's file_url — always attached as the Flux
   *  Kontext edit source. A scene_image generation with no reference image
   *  would let the model reinvent the subject's appearance per scene,
   *  exactly the bug this design fixes (ARCHITECTURE.MD §4.1). */
  characterRefUrl: string
  /** Set by POST /video/regenerate { scope: "visuals" } — never present on
   *  a first-time generation. */
  regenInstructions?: string | null
  /** The immediately preceding scene's visual_state (SceneVisualState,
   *  prompts/types.ts) — undefined for scene 1, or if that scene had none.
   *  See continuityClauseFrom below for how this is used. */
  previousVisualState?: SceneVisualState | null
}

/**
 * Compact carry-forward context built from the PREVIOUS scene's
 * visual_state — "use the previous scene's compact visual state as
 * context" for scene-to-scene continuity. Deliberately built from just a
 * people count and a short object list, never the full scene, and kept in
 * the SAME droppable cascade tier as REALISTIC_PEOPLE below (never
 * fixedParts — see SCENE_IMAGE_PROMPT_CHAR_LIMIT's own header for why
 * fixedParts has essentially no headroom left to spend). Returns '' when
 * there's nothing worth carrying forward (scene 1, or a previous scene
 * whose visual_state was empty/never generated).
 */
function continuityClauseFrom(previous: SceneVisualState | null | undefined): string {
  if (!previous) return ''
  const bits: string[] = []
  if (typeof previous.people === 'number' && previous.people > 0) {
    bits.push(`${previous.people} established ${previous.people === 1 ? 'person' : 'people'}`)
  }
  if (previous.objects && previous.objects.length > 0) {
    bits.push(`objects: ${previous.objects.slice(0, 5).join(', ')}`)
  }
  if (bits.length === 0) return ''
  return (
    `Continuing from the previous scene (${bits.join('; ')}) — keep these consistent unless this scene's ` +
    'own description changes them.'
  )
}

// Hard ceiling under KieImageGenerator's real, confirmed 3000-char cap
// ("The prompt word cannot exceed 3000 characters") — added 2026-09-21
// after a real generation hit that cap for a THIRD time despite two prior
// rounds of hand-trimming the fixed brand/guardrail prose (see
// containerDescriptor's and REFERENCE_IS_GUIDE_NOT_COPY's comment history).
// Neither round added an actual ceiling — they just bought back margin that
// the next incident-driven safety clause (CINEMATIC_QUALITY,
// NO_UNSCRIPTED_PEOPLE, NO_UNEXPLAINED_PROPS, all also 2026-09-19) ate right
// back up. The fixed overhead alone measures ~2822 chars even after that
// trimming (showSubject=true branch, real BRAND_PROFILE) — confirmed by
// direct measurement, not estimated — so a merely-average visual_description
// /shot_notes/regenInstructions — all free text, all unbounded upstream (see
// generateScript.ts's normalizeScriptOutput and the /video/regenerate route)
// — can still push the total over 3000 and fail the whole scene.
//
// 2995, not 3000: KIE's own error text is unambiguous ("cannot exceed 3000
// characters", not a word-tokenization limit), so this only needs a few
// characters of margin against an off-by-one on their side, NOT the ~100
// chars a first pass at this used — that turned out to eat nearly the
// entire scene-content budget (fixedLen ~2822 left only ~78 chars for
// visualDescription+shotNotes+regenInstructions combined, truncating even
// short, ordinary scenes). At 2995, ordinary scenes have ~170 chars of
// headroom before this cap's cascading truncation ever engages at all.
const SCENE_IMAGE_PROMPT_CHAR_LIMIT = 2995

// Cuts at the last word boundary at/under maxChars rather than mid-word, so
// a truncated scene never ends the prompt on a fragment. Never lengthens
// input — maxChars <= 0 always returns ''.
function truncateToFit(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()
}

export function composeSceneImagePrompt(brand: BrandProfile, job: SceneImageJob): ImageComposition {
  // Added 2026-09-19: this composer used to ALWAYS attach the character-ref
  // truck photo and containerDescriptor, for every scene, regardless of
  // whether that scene had anything to do with the truck at all — a real
  // generation showed the truck (and its branding) hallucinated inside a
  // family's own kitchen and dining room. Gated on isVideoSceneAboutUnit,
  // NOT isContainerRelevant/blog-photo's heuristic — a video scene's
  // visual_description is free-form narrative prose built around whatever
  // creative idea the job asked for (a mother and son walking down a road,
  // for instance), so a generic-verb heuristic tuned for blog/photo's
  // short topic strings would false-positive on ordinary sentences and
  // force the truck into scenes that have nothing to do with it — see
  // isVideoSceneAboutUnit's own comment in scene.ts for why it only fires
  // on an explicit, unambiguous mention of the unit itself, and for the
  // 2026-09-21 note on why a same-day attempt to replace this with an
  // explicit LLM-authored field was reverted (needed a schema migration
  // the user didn't want) — the real "videos feel disconnected from the
  // brand" fix lives in composeVideoScriptSystemPrompt instead, not here.
  const sceneText = `${job.visualDescription} ${job.shotNotes ?? ''}`
  const showSubject = isVideoSceneAboutUnit(sceneText)

  // Everything below is a fixed brand/safety constraint sent in full,
  // always — see SCENE_IMAGE_PROMPT_CHAR_LIMIT's header for why these can
  // never be the thing that gets cut when a prompt runs long. REALISTIC_PEOPLE
  // is deliberately NOT in this list — see the cascade below for why.
  const fixedParts = [
    moodClause(),
    FOOD_MUST_LOOK_CLEAN,
    PHYSICALLY_PLAUSIBLE_SCENE,
    CINEMATIC_QUALITY,
    NO_UNSCRIPTED_PEOPLE,
    NO_UNEXPLAINED_PROPS,
    SCENE_IS_CREATIVE_BRIEF,
    showSubject ? brand.unit.full : NO_SUBJECT_IN_SCENE,
    showSubject ? REFERENCE_IS_GUIDE_NOT_COPY : '',
    showSubject ? brand.noNewTextInstruction : brand.noTextInstruction,
  ].filter(Boolean)
  const fixedLen = fixedParts.join(' ').length

  // The only free text in this prompt — LLM-generated (visualDescription/
  // shotNotes) or user-typed (regenInstructions) — and so the only part
  // that can grow past what fixedParts leaves room for. Cascading
  // truncation, lowest-value first: REALISTIC_PEOPLE (a quality nice-to-have
  // added 2026-09-21 — unlike everything in fixedParts above, it's not
  // preventing actively wrong/unsafe content, just improving rendering
  // quality, so it's the first thing dropped rather than eating into the
  // scene's own content — real measurement showed its fixed cost alone
  // left almost no room for a typical scene otherwise), then
  // regenInstructions (a refinement on an already-generated scene), then
  // shotNotes (secondary cinematography detail), then — only as a last
  // resort — visualDescription itself, since it's the actual creative
  // brief the scene is built around.
  let visualDescription = job.visualDescription
  let shotNotes = job.shotNotes ?? ''
  let regenInstructions = job.regenInstructions ?? ''
  let includeRealismClause = true
  let continuityClause = continuityClauseFrom(job.previousVisualState)

  const totalLen = () =>
    fixedLen +
    1 + // join space between the scene/shotNotes block and fixedParts, always present
    `Scene ${job.sceneNumber}: ${visualDescription}`.length +
    (shotNotes ? 1 + `Shot notes: ${shotNotes}.`.length : 0) +
    (regenInstructions ? 1 + `${regenInstructions}.`.length : 0) +
    (includeRealismClause ? 1 + REALISTIC_PEOPLE.length : 0) +
    (continuityClause ? 1 + continuityClause.length : 0)

  let overflow = totalLen() - SCENE_IMAGE_PROMPT_CHAR_LIMIT
  if (overflow > 0 && includeRealismClause) {
    includeRealismClause = false
    overflow = totalLen() - SCENE_IMAGE_PROMPT_CHAR_LIMIT
  }
  if (overflow > 0 && continuityClause) {
    // Second to drop — a real scene-to-scene continuity aid, but still an
    // enhancement on top of the always-present NO_UNSCRIPTED_PEOPLE/
    // NO_UNEXPLAINED_PROPS constraints above, never the only thing
    // enforcing consistency.
    continuityClause = ''
    overflow = totalLen() - SCENE_IMAGE_PROMPT_CHAR_LIMIT
  }
  if (overflow > 0 && regenInstructions) {
    regenInstructions = truncateToFit(regenInstructions, regenInstructions.length - overflow)
    overflow = totalLen() - SCENE_IMAGE_PROMPT_CHAR_LIMIT
  }
  if (overflow > 0 && shotNotes) {
    shotNotes = truncateToFit(shotNotes, shotNotes.length - overflow)
    overflow = totalLen() - SCENE_IMAGE_PROMPT_CHAR_LIMIT
  }
  if (overflow > 0) {
    visualDescription = truncateToFit(visualDescription, visualDescription.length - overflow)
  }

  const parts = [
    // Dropped "of a marketing video" (2026-09-19) — that framing itself
    // primed the model toward a polished, staged ad look before it even
    // read the scene content. The actual creative brief now lives upstream
    // in the script/scene plan's own visual_description (see
    // composeVideoScriptSystemPrompt's sceneNotes/anti-ad handling) — this
    // composer just needs to render it faithfully, not re-frame it as an ad.
    `Scene ${job.sceneNumber}: ${visualDescription}`,
    shotNotes ? `Shot notes: ${shotNotes}.` : '',
    continuityClause,
    // Same mood per pipeline (not per scene) — keeps lighting/atmosphere
    // consistent across all of one video's scenes, same reasoning as
    // composeBlogImage's hero/inline pairing. Deferential (moodClause, not
    // moodDetailFor directly) since job.visualDescription/shotNotes may
    // already specify their own lighting — see moodClause's own comment.
    moodClause(),
    FOOD_MUST_LOOK_CLEAN,
    PHYSICALLY_PLAUSIBLE_SCENE,
    CINEMATIC_QUALITY,
    NO_UNSCRIPTED_PEOPLE,
    NO_UNEXPLAINED_PROPS,
    includeRealismClause ? REALISTIC_PEOPLE : '',
    // Same instruction blog/photo images use (SCENE_IS_CREATIVE_BRIEF) —
    // added 2026-09-19. Without this the model has nothing pushing back
    // against reference-photo edit-mode's own bias toward a clean,
    // product-hero treatment of the vehicle instead of treating it as just
    // one constrained element in whatever moment visualDescription
    // actually describes.
    SCENE_IS_CREATIVE_BRIEF,
  ]

  let referenceImageUrl: string | undefined
  if (showSubject) {
    // Every OTHER composer that can show the vehicle
    // (composeCharacterRefPrompt, and composeBlogImage/composePhotoPrompt
    // when showSubject is true) splices in the brand's full
    // containerDescriptor — the fixed structural rule set (shape, color,
    // wordmark placement, and critically "NEVER a door/hatch/window/vent on
    // either side, the rear double door is the ONLY opening"), sourced from
    // the same single constant (fresh-can.ts's CONTAINER_DESCRIPTOR) so it
    // can never drift into a narrower paraphrase the way
    // BACKGROUND_TRUCK_CLAUSE's own history warns against.
    parts.push(brand.unit.full)
    // REFERENCE_IS_GUIDE_NOT_COPY explicitly tells the model to build a
    // genuinely new scene around the vehicle rather than copy the
    // character-ref photo — without it, a relevant scene risks coming out
    // looking like the character-ref's own plain reference shot instead of
    // that scene's actual visual_description.
    parts.push(REFERENCE_IS_GUIDE_NOT_COPY)
    parts.push(brand.noNewTextInstruction)
    referenceImageUrl = job.characterRefUrl
  } else {
    // No reference image attached at all for a non-relevant scene — a pure
    // text-to-image generation, so edit-mode's own bias toward
    // incorporating its input (the truck photo) can never pull the truck
    // into a scene that was never about it in the first place.
    parts.push(NO_SUBJECT_IN_SCENE)
    parts.push(brand.noTextInstruction)
  }
  if (regenInstructions) parts.push(`${regenInstructions}.`)

  return { prompt: parts.filter(Boolean).join(' '), referenceImageUrl }
}

interface SceneVideoJob {
  visualDescription: string
  shotNotes: string | null
  /** True only for the LAST scene in the video. Adds a settle-the-motion
   *  instruction so the clip doesn't get cut off mid-movement — see this
   *  function's own header for why the "abrupt ending" bug is really a
   *  motion problem, not just a script/pacing one. */
  isFinalScene?: boolean
}

/** Prompt for Seedance 1.5 Pro image-to-video (adapters/kie.ts's
 *  KieVideoGenerator) — motion/camera direction only. The subject's
 *  appearance is NOT re-described here; it's already locked in the
 *  scene_image frame this call animates from (input_urls[0]), so repeating
 *  a physical description would be redundant at best.
 *
 *  "no staged product-reveal moves" (added 2026-09-19) is the motion-side
 *  half of composeSceneImagePrompt's SCENE_IS_CREATIVE_BRIEF addition — a
 *  slow orbit or hero push-in around the vehicle is exactly the camera
 *  language of a commercial, even when the frame itself already reads as a
 *  candid moment.
 *
 *  Reworded same day: "Subtle, natural, observational motion" was, on its
 *  own, in tension with composeVideoScriptSystemPrompt's own newer
 *  cinematic-shot-variety instruction (real camera direction in shot_notes
 *  — pans, tilts, tracking, dolly moves) — "subtle" reads as suppressing
 *  exactly the deliberate, dynamic movement that instruction now explicitly
 *  asks the script step to plan. This keeps the one rule that actually
 *  matters (no product-hero orbit/push-in AROUND THE SUBJECT, no jump
 *  cuts) while giving real cinematographic technique explicit positive
 *  permission instead of discouraging it by default.
 *
 *  Ambient-motion clause tightened 2026-09-21 after real Seedance renders
 *  showed illogical motion on static objects — e.g. produce/vegetables in
 *  a grocery scene drifting or shifting with no visible cause. The old
 *  wording ("any natural ambient motion already implied by the setting...
 *  so the environment never freezes into a still backdrop") actively
 *  pressured the model to find SOMETHING to animate whenever a scene had
 *  no steam/wind/fabric of its own, and solid objects sitting in frame
 *  (produce, packaged goods) were the most visually salient thing left to
 *  move — this is the video-motion equivalent of the image prompt's
 *  PHYSICALLY_PLAUSIBLE_SCENE constraint, which has no counterpart here.
 *  Now explicitly scopes which motion is allowed (steam, smoke, wind on
 *  hair/fabric/leaves, water, shifting light — all passive/environmental)
 *  and states the rule a static object must pass before it's allowed to
 *  move at all (a real, visible cause), rather than leaving "ambient
 *  motion" open to whatever the model invents to avoid a "still backdrop."
 *
 *  SCENE_VIDEO_PROMPT_CHAR_LIMIT added the same day, mirroring
 *  composeSceneImagePrompt's SCENE_IMAGE_PROMPT_CHAR_LIMIT — Seedance's
 *  video endpoint has its own documented prompt cap (`input.prompt`:
 *  3-2500 characters per docs.kie.ai/market/bytedance/seedance-1-5-pro,
 *  separate from and tighter than the image endpoint's 3000), and this
 *  function's fixed suffix + a long visual_description/shot_notes (both
 *  free text, unbounded upstream — see generateScript.ts) could exceed it
 *  the same way composeSceneImagePrompt's fixed overhead did. shotNotes is
 *  truncated before visualDescription (the actual creative brief), same
 *  lowest-value-first cascade as the image prompt's guard.
 *
 *  `isFinalScene` clause added 2026-09-21 — real renders showed the video
 *  ending abruptly, mid-motion. Root cause is upstream too
 *  (renderLanguageTrack.ts/avMerger.ts's buildSceneDurationMatchCommand
 *  hard-trims each scene's clip to the track's real narration length via
 *  `-t`), but if the LAST scene's own motion is still actively moving
 *  (a pan, a walk) at that exact trim point, the cut looks jarring no
 *  matter how precise the trim is — this asks the model to settle motion
 *  into a held beat by the end of the shot so that trim point lands on
 *  something that already reads as an ending. Paired with a render-level
 *  fade-out (avMerger.ts's buildMuxCommand) as the deterministic half of
 *  this fix — this clause is the soft, model-compliance half. */
const SCENE_VIDEO_PROMPT_CHAR_LIMIT = 2450

const FINAL_SCENE_SETTLE_CLAUSE =
  ' This is the FINAL shot of the video — ease subject and camera motion into a settled, held final beat by ' +
  'the end of the shot rather than staying in active movement right up to the cut; the last moment on screen ' +
  'should already read as an ending, not get cut off mid-motion.'

export function composeSceneVideoPrompt(job: SceneVideoJob): string {
  const suffix =
    " Animate this as three distinct layers: the subject's own action described above; any natural ambient " +
    'motion already implied by the setting — steam, smoke, wind moving hair, fabric, or leaves, water, ' +
    'shifting light — so the environment never freezes into a still backdrop, but never motion with no real ' +
    'cause: produce, packaged goods, and other solid objects at rest must stay completely still unless a ' +
    'visible hand, wind, or other real force is actually moving them; and camera motion as a separate layer ' +
    'on top of those two — follow whatever camera direction is given above (pans, tilts, tracking, slow ' +
    'dolly, rack focus) with smooth, real-camera motion. Camera movement is never a substitute for actual ' +
    'subject or environmental motion. Never a jump cut, and never a staged product-reveal move like a slow ' +
    'orbit or a dramatic hero push-in around the subject. The approved reference frame is the visual source ' +
    'of truth — preserve every established person, limb, and object exactly as shown in it; never introduce ' +
    'a new person, limb, or object that was not already in that frame.' +
    (job.isFinalScene ? FINAL_SCENE_SETTLE_CLAUSE : '')

  let visualDescription = job.visualDescription
  let shotNotes = job.shotNotes ?? ''

  const totalLen = () =>
    visualDescription.length + (shotNotes ? 1 + shotNotes.length : 0) + suffix.length

  let overflow = totalLen() - SCENE_VIDEO_PROMPT_CHAR_LIMIT
  if (overflow > 0 && shotNotes) {
    shotNotes = truncateToFit(shotNotes, shotNotes.length - overflow)
    overflow = totalLen() - SCENE_VIDEO_PROMPT_CHAR_LIMIT
  }
  if (overflow > 0) {
    visualDescription = truncateToFit(visualDescription, visualDescription.length - overflow)
  }

  const shot = shotNotes ? ` ${shotNotes}` : ''
  return `${visualDescription}${shot}${suffix}`
}

export function composePhotoPrompt(brand: BrandProfile, job: PhotoJob): ImageComposition {
  const sceneText = `${job.scene} ${job.regenInstructions ?? ''}`
  // image_post's photo is inherently a "grocery access" post, so default to
  // showing the subject unless the scene is clearly produce/recipe-only.
  const showSubject = isContainerRelevant(sceneText, true)
  const guidance = job.regenInstructions ? ` ${job.regenInstructions}.` : ''

  const parts = [
    `A photo for a social media grocery-access post depicting ${job.scene}.${guidance}`,
    moodClause(),
    SCENE_IS_CREATIVE_BRIEF,
    FOOD_MUST_LOOK_CLEAN,
  ]
  let referenceImageUrl: string | undefined
  if (showSubject) {
    parts.push(brand.unit.full)
    // job.scene is usually real, specific content from the dashboard's
    // clarifying-question answers, but image.ts's photoScene() falls back
    // to a bare "topic, in the context of category" when the
    // user skipped every question — exactly as thin as blog's old topic
    // line was before composeBlogImage's containerSceneContext fix, with
    // the same risk: edit-mode reproducing the reference photo near-
    // verbatim instead of building a new scene. Reinforced unconditionally
    // here since it's harmless when job.scene is already rich.
    //
    // Reworded 2026-09-19: this used to also mandate "a real, specific
    // moment — genuine people/action" — style dictation, and redundant with
    // REFERENCE_IS_GUIDE_NOT_COPY's own "build a genuinely new scene"
    // clause right below it. Confirmed live alongside the mood/framing
    // fixes this same day: an explicit split-scene editorial request came
    // back as a single generic candid photo — this line was one more
    // hardcoded voice pulling toward "ordinary real-life moment" regardless
    // of what the user actually asked for.
    parts.push(
      `Build the scene around the vehicle as described above, never a plain reproduction of the reference ` +
        `photo's own background. ${REFERENCE_IS_GUIDE_NOT_COPY}`,
    )
    const reference = pickReferenceFrom(brand.referenceImages.exterior, `${job.pipelineId}:photo`)
    if (reference) {
      parts.push(describeReferencePhoto(reference))
      referenceImageUrl = reference.url
    }
  }
  parts.push(textLayerFor(brand, job, referenceImageUrl))

  return { prompt: parts.join(' '), referenceImageUrl }
}
