// Image-prompt assembly. The pattern: never let free-form job data (topic,
// scene notes, regen instructions) be the ONLY thing that decides what a
// generated image looks like. Instead, decide composition (mood, whether the
// branded subject appears) deterministically in code, then splice the
// brand's fixed, verbatim descriptions in around the job-specific scene text.
// This is what makes the container/logo look the same across every image
// that includes it, and what makes reference-image usage automatic instead
// of something every call site has to remember to wire up.
import type { BrandProfile, BrandReferenceImage, ImageStyle } from '../types'
import { pickDeterministic } from './rotation'
import { isContainerRelevant } from './scene'

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
  /** The dashboard's optional "Your Scene Idea" free-text field
   *  (content_jobs.scene_notes) — previously only threaded into
   *  image_post's photo prompt (see PhotoJob.scene below), never into blog.
   *  Folded in here as a light, non-binding influence on mood/setting, not
   *  a scene description to follow literally the way image_post's `scene`
   *  is. */
  sceneNotes?: string | null
}

interface PhotoJob extends StyleInputs {
  pipelineId: string
  topic: string
  category: string
  /** Scene descriptors already assembled by the caller (scene notes +
   *  clarifying-question answers, or a topic/category fallback) — see
   *  worker/src/index.ts photoScene() for how these are gathered today. */
  scene: string
  regenInstructions?: string | null
}

/** Same seed for hero+inline of one pipeline => same mood for both. */
function moodDetailFor(brand: BrandProfile, pipelineId: string): string {
  return pickDeterministic(pipelineId, brand.moods).detail
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
 * The text layer for image_style: 'infographic' — headline, subtitle, the
 * brand's locked logo description, and the CTA bar, all spliced in as the
 * LAST thing in the prompt (same position that noText/noNewTextInstruction
 * occupy for 'photo' style). Confirmed live (2026-09-10) with nano-banana-2
 * that this exact structure (headline zone, subtitle below it, corner logo,
 * bottom CTA band) renders correctly spelled text reliably — this is NOT
 * safe to send to Flux Kontext (see noTextInstruction's incident notes);
 * callers must route 'infographic'-style jobs to a text-capable model
 * (see worker/src/adapters/nanoBanana.ts). Typography and the CTA bar's
 * color come from the brand file (typographyDescriptor/ctaBarColorDescriptor)
 * rather than being hardcoded here, so this stays generic across brands —
 * see fresh-can.ts for why those specific values (Manrope, Charcoal
 * #1F1F1F) were chosen, sourced from the brand's real guidelines doc.
 */
function infographicTextLayer(brand: BrandProfile, headline: string, subtitle: string): string {
  return (
    `In the upper portion of the frame, in bold clean white letters using ${brand.typographyDescriptor} ` +
    `the text "${headline}" appears as a headline, sized moderately, spelled exactly as written with no ` +
    `typos. Directly below it, smaller white text in the same typeface reads "${subtitle}" as a subtitle, ` +
    `spelled exactly as written. ${brand.logoDescriptor} Along the bottom edge, ${brand.ctaBarColorDescriptor} ` +
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

// Generic fallback for a non-container blog scene whose category has no
// categoryVisualHints entry (or the brand file doesn't define any) — keeps
// the non-container branch safe for a brand-new brand/category, not just
// Fresh-CAN's own five.
const DEFAULT_NON_CONTAINER_HINT =
  'Photorealistic documentary-style photo capturing a genuine, specific moment relevant to the topic above ' +
  '— real people, real food, or a real neighbourhood setting as appropriate. Natural lighting. If the ' +
  'Fresh-CAN truck plausibly fits the scene, it must be built to its real, correct structure — a white box ' +
  'truck with a dark maroon-red steel cargo container and a white "Fresh [maple leaf icon] CAN" wordmark on ' +
  "the container's rear header bar only — never any other vehicle shape, color, or logo, never forced in, and " +
  'never the main subject. Every other vehicle in the scene must stay completely unbranded — never place the ' +
  'Fresh-CAN wordmark or logo on it.'

function nonContainerSceneHint(brand: BrandProfile, category: string): string {
  return brand.categoryVisualHints?.[category] ?? DEFAULT_NON_CONTAINER_HINT
}

// The trailing text-instruction used by composeBlogImage's non-container
// branch instead of the blanket brand.noTextInstruction. That blanket
// instruction ("no logos, no watermarks... anywhere") directly contradicts
// nonContainerSceneHint/categoryVisualHints, which explicitly permits the
// brand's real vehicle to appear in the background — sending both in one
// prompt is exactly the kind of contradiction that leaves the model free to
// invent an off-model result (e.g. the wordmark on the wrong vehicle
// shape). This keeps the same "don't invent text" framing but carves out
// one exact exception, built from containerDescriptor so it can't drift
// into a shorthand, and restates the no-other-vehicle rule as the very last
// thing the model reads.
function backgroundBrandingInstruction(brand: BrandProfile): string {
  return (
    'Photorealistic, natural lighting, documentary style. Absolutely no invented text, words, letters, ' +
    'captions, titles, or typography anywhere in the image. The only exception is branding: if the ' +
    `${brand.name} vehicle naturally fits the scene, it must be built to this exact structure — ` +
    `${brand.containerDescriptor} — showing only its own real wordmark exactly as just described. Every ` +
    'other vehicle in the image must stay completely unbranded — never place this wordmark or logo on it.'
  )
}

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
function containerSceneContext(job: BlogImageJob): string {
  return (
    `Set this in a real, specific moment relevant to "${job.topic}" (${job.category}) — real people going ` +
    'about their day, a specific time of day, genuine surrounding environment (street, sky, pavement, ' +
    'nearby buildings or greenery as fits the setting). This must read as a new, lived-in scene built around ' +
    "the subject above, never a plain, empty, studio-style reproduction of the reference photo's own background."
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
  // worker/src/index.ts), not just 'infographic'. Folding it in here gives
  // the scene the post's actual specific angle instead of just raw
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

  const parts = [topicLine, moodDetailFor(brand, job.pipelineId)]
  // Optional, non-binding: the dashboard's "Your Scene Idea" field. Framed
  // as inspiration rather than a literal scene to reproduce (unlike
  // image_post's PhotoJob.scene, which composePhotoPrompt treats as the
  // scene) — blog images are built from the topic/category/mood system
  // above, and forcing an unrelated user story onto every hero/inline image
  // would fight that rather than complement it.
  if (job.sceneNotes) {
    parts.push(
      `For light inspiration only, the user shared this idea when creating the post: "${job.sceneNotes}" — ` +
        'let it subtly inform the mood or setting where it naturally fits, without contradicting or replacing ' +
        'the scene described below.',
    )
  }
  let referenceImageUrl: string | undefined

  if (showSubject) {
    const sceneType = pickSceneType(brand, `${job.pipelineId}:${kind}:scene`)
    const descriptor = sceneType === 'interior' ? brand.interiorDescriptor : brand.containerDescriptor
    const pool = sceneType === 'interior' ? brand.referenceImages.interior : brand.referenceImages.exterior
    parts.push(descriptor)
    parts.push(containerSceneContext(job))
    const reference = pickReferenceFrom(pool, `${job.pipelineId}:${kind}`)
    if (reference) {
      parts.push(reference.framing)
      referenceImageUrl = reference.url
    }
  } else {
    parts.push(nonContainerSceneHint(brand, job.category))
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
    brand.containerDescriptor,
  ]

  let referenceImageUrl: string | undefined
  const reference = pickReferenceFrom(brand.referenceImages.exterior, `${job.pipelineId}:character_ref`)
  if (reference) {
    parts.push(reference.framing)
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
}

export function composeSceneImagePrompt(brand: BrandProfile, job: SceneImageJob): ImageComposition {
  const parts = [
    `Scene ${job.sceneNumber} of a marketing video: ${job.visualDescription}`,
    job.shotNotes ? `Shot notes: ${job.shotNotes}.` : '',
    // Same mood per pipeline (not per scene) — keeps lighting/atmosphere
    // consistent across all of one video's scenes, same reasoning as
    // composeBlogImage's hero/inline pairing.
    moodDetailFor(brand, job.pipelineId),
    // Always the "reference photo attached" instruction — a scene_image
    // generation ALWAYS has characterRefUrl attached, never the
    // no-reference-image branch other composers have.
    brand.noNewTextInstruction,
    job.regenInstructions ? `${job.regenInstructions}.` : '',
  ]

  return { prompt: parts.filter(Boolean).join(' '), referenceImageUrl: job.characterRefUrl }
}

interface SceneVideoJob {
  visualDescription: string
  shotNotes: string | null
}

/** Prompt for Kling 2.6 image-to-video (worker/src/adapters/kie.ts's
 *  KieVideoGenerator) — motion/camera direction only. The subject's
 *  appearance is NOT re-described here; it's already locked in the
 *  scene_image frame this call animates from (image_urls[0]), so repeating
 *  a physical description would be redundant at best. */
export function composeSceneVideoPrompt(job: SceneVideoJob): string {
  const shot = job.shotNotes ? ` ${job.shotNotes}` : ''
  return `${job.visualDescription}${shot} Subtle, natural motion — no camera shake, no jump cuts.`
}

export function composePhotoPrompt(brand: BrandProfile, job: PhotoJob): ImageComposition {
  const sceneText = `${job.scene} ${job.regenInstructions ?? ''}`
  // image_post's photo is inherently a "grocery access" post, so default to
  // showing the subject unless the scene is clearly produce/recipe-only.
  const showSubject = isContainerRelevant(sceneText, true)
  const guidance = job.regenInstructions ? ` ${job.regenInstructions}.` : ''

  const parts = [
    `A photo for a social media grocery-access post depicting ${job.scene}.${guidance}`,
    moodDetailFor(brand, job.pipelineId),
  ]

  let referenceImageUrl: string | undefined
  if (showSubject) {
    parts.push(brand.containerDescriptor)
    // job.scene is usually real, specific content from the dashboard's
    // clarifying-question answers, but photoScene() (worker/src/index.ts)
    // falls back to a bare "topic, in the context of category" when the
    // user skipped every question — exactly as thin as blog's old topic
    // line was before composeBlogImage's containerSceneContext fix, with
    // the same risk: edit-mode reproducing the reference photo near-
    // verbatim instead of building a new scene. Reinforced unconditionally
    // here since it's harmless when job.scene is already rich.
    parts.push(
      'This must depict a real, specific moment — genuine people/action and surrounding environment as ' +
        "described above — never a plain, empty, studio-style reproduction of the reference photo's own " +
        'background.',
    )
    const reference = pickReferenceFrom(brand.referenceImages.exterior, `${job.pipelineId}:photo`)
    if (reference) {
      parts.push(reference.framing)
      referenceImageUrl = reference.url
    }
  }
  parts.push(textLayerFor(brand, job, referenceImageUrl))

  return { prompt: parts.join(' '), referenceImageUrl }
}
