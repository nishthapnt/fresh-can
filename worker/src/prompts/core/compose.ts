// Image-prompt assembly. The pattern: never let free-form job data (topic,
// scene notes, regen instructions) be the ONLY thing that decides what a
// generated image looks like. Instead, decide composition (mood, whether the
// branded subject appears) deterministically in code, then splice the
// brand's fixed, verbatim descriptions in around the job-specific scene text.
// This is what makes the container/logo look the same across every image
// that includes it, and what makes reference-image usage automatic instead
// of something every call site has to remember to wire up.
import type { BrandProfile, BrandReferenceImage, ImageStyle } from '../types.js'
import { pickDeterministic } from './rotation.js'
import { isContainerRelevant } from './scene.js'

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
 *  instruction (which would contradict the headline/subtitle just built). */
function textLayerFor(brand: BrandProfile, job: StyleInputs, referenceImageUrl: string | undefined): string {
  if (job.imageStyle === 'infographic') {
    if (!job.headline || !job.subtitle) {
      throw new Error('composeImage: imageStyle "infographic" requires both headline and subtitle')
    }
    return infographicTextLayer(brand, job.headline, job.subtitle)
  }
  return referenceImageUrl ? brand.noNewTextInstruction : brand.noTextInstruction
}

// Generic fallback for a non-container blog scene whose category has no
// categoryVisualHints entry (or the brand file doesn't define any) — keeps
// the non-container branch safe for a brand-new brand/category, not just
// Fresh-CAN's own five.
const DEFAULT_NON_CONTAINER_HINT =
  'Photorealistic documentary-style photo capturing a genuine, specific moment relevant to the topic above ' +
  '— real people, real food, or a real neighbourhood setting as appropriate. Natural lighting. No vehicles, ' +
  'storefronts, or brand logos of any kind in frame.'

function nonContainerSceneHint(brand: BrandProfile, category: string): string {
  return brand.categoryVisualHints?.[category] ?? DEFAULT_NON_CONTAINER_HINT
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
  const topicLine = `${label} about ${job.topic}, in the context of ${job.category}.`

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
  let referenceImageUrl: string | undefined

  if (showSubject) {
    const sceneType = pickSceneType(brand, `${job.pipelineId}:${kind}:scene`)
    const descriptor = sceneType === 'interior' ? brand.interiorDescriptor : brand.containerDescriptor
    const pool = sceneType === 'interior' ? brand.referenceImages.interior : brand.referenceImages.exterior
    parts.push(descriptor)
    const reference = pickReferenceFrom(pool, `${job.pipelineId}:${kind}`)
    if (reference) {
      parts.push(reference.framing)
      referenceImageUrl = reference.url
    }
  } else {
    parts.push(nonContainerSceneHint(brand, job.category))
  }

  parts.push(textLayerFor(brand, job, referenceImageUrl))

  return { prompt: parts.join(' '), referenceImageUrl }
}

export function composeHeroPrompt(brand: BrandProfile, job: BlogImageJob): ImageComposition {
  return composeBlogImage(brand, job, 'hero')
}

export function composeInlinePrompt(brand: BrandProfile, job: BlogImageJob): ImageComposition {
  return composeBlogImage(brand, job, 'inline')
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
    const reference = pickReferenceFrom(brand.referenceImages.exterior, `${job.pipelineId}:photo`)
    if (reference) {
      parts.push(reference.framing)
      referenceImageUrl = reference.url
    }
  }
  parts.push(textLayerFor(brand, job, referenceImageUrl))

  return { prompt: parts.join(' '), referenceImageUrl }
}
