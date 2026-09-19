// Text-generation prompt assembly — same pattern as core/compose.ts's image
// prompts: fixed brand facts (mission, voice, real stats, category briefs)
// live in the brand file and get spliced into every prompt, rather than
// each step file writing brand-blind, topic-only prompts from scratch.
import type { BrandProfile } from '../types'

function bannedWordsLine(brand: BrandProfile): string {
  return brand.bannedWords.length > 0 ? ` Avoid these overused phrases: ${brand.bannedWords.join(', ')}.` : ''
}

function statsLine(brand: BrandProfile): string {
  return brand.statistics.length > 0
    ? ` You may cite ONE of these real, verified facts if it is genuinely relevant to this specific topic — ` +
        `never force one in, never alter the number: ${brand.statistics.join(' | ')}.`
    : ''
}

function categoryBriefLine(brand: BrandProfile, category: string): string {
  const brief = brand.categoryBriefs[category]
  return brief ? `This post's category ("${category}") should focus on: ${brief} ` : ''
}

function brandContext(brand: BrandProfile, category: string): string {
  return (
    `${brand.missionStatement} ${categoryBriefLine(brand, category)}` +
    `Voice: ${brand.voiceGuidelines}${bannedWordsLine(brand)}\n\n`
  )
}

export function composeOutlineSystemPrompt(brand: BrandProfile, category: string, sceneNotes?: string | null): string {
  return (
    brandContext(brand, category) +
    'You are a content strategist. Produce a JSON outline for a blog post with a title, ' +
    'a list of exactly 3 to 5 section headings, and a one-sentence summary of each section. Each heading and ' +
    'summary must reference something concrete and specific to this exact topic — a real detail, angle, or ' +
    'example — never a generic restatement of the brand\'s mission or a vague marketing angle that could ' +
    'apply to any post. Also include "headline" ' +
    '(max 6 words, a punchy standalone version of the title, suitable for rendering on an image) and ' +
    '"subtitle" (2-5 words) — these are only used if the post\'s image style calls for on-image text, but ' +
    'always include them.' +
    // The dashboard's "Your Scene Idea" field (content_jobs.scene_notes) —
    // required going forward (see src/app/dashboard/new's submit
    // validation), so this is normally always present. It's the creative
    // brief this outline is built around; the brand mission/voice/category
    // guidance in brandContext() above is a fixed constraint on tone and
    // accuracy, never a competing angle. Absent only for a pre-existing job
    // created before the field became required.
    (sceneNotes
      ? `\n\nBuild this outline around the user's own creative idea for the post: "${sceneNotes}". Treat the ` +
        'brand mission, voice, and category guidance above as fixed constraints on tone and accuracy — ' +
        'never as the angle itself. The scene idea decides what this post is actually about.'
      : '')
  )
}

export interface CopySystemPromptOptions {
  language: string
  category: string
  regenInstructions?: string | null
  /** The dashboard's "Your Scene Idea" field (content_jobs.scene_notes) —
   *  same required-creative-brief treatment as
   *  composeOutlineSystemPrompt's, still typed optional/nullable for a
   *  pre-existing job created before the field became required. */
  sceneNotes?: string | null
}

export function composeCopySystemPrompt(brand: BrandProfile, opts: CopySystemPromptOptions): string {
  return (
    brandContext(brand, opts.category) +
    statsLine(brand) +
    `\n\nYou are a copywriter. Write full blog copy in ${opts.language} from the given outline. ` +
    // Field names below MUST match blogEditFromDraft() in
    // src/app/dashboard/jobs/[job_id]/page.tsx exactly — see generateCopy.ts
    // for the full incident note on why this schema must stay explicit.
    'Respond with strictly valid JSON matching this exact shape (all string fields required, ' +
    'use "" if genuinely not applicable, arrays may be empty but must be present):\n' +
    '{\n' +
    '  "post_title": string,\n' +
    '  "post_slug": string (url-safe, lowercase, hyphenated),\n' +
    '  "content": {\n' +
    '    "introduction": string (1-2 paragraphs, 2-4 sentences each),\n' +
    '    "sections": [\n' +
    '      {\n' +
    '        "heading": string,\n' +
    '        "h3s": string[] (sub-headings within this section, [] if none),\n' +
    '        "paragraphs": string[] (the section\'s actual body copy, one string per paragraph, 2-4 ' +
    'paragraphs of 2-4 sentences each — this is the main content, never leave it empty),\n' +
    '        "list_items": string[] ([] if this section has no bulleted list),\n' +
    '        "blockquote": { "text": string, "cite": string } or null,\n' +
    '        "has_inline_image": boolean (true for exactly one section, the best fit for a supporting photo)\n' +
    '      }\n' +
    '    ],\n' +
    '    "conclusion": string (1-2 short paragraphs),\n' +
    '    "cta": { "heading": string, "text": string, "button_label": string, "button_url": string }\n' +
    '  },\n' +
    '  "seo": {\n' +
    '    "title": string, "meta_description": string, "focus_keyword": string,\n' +
    '    "secondary_keywords": string[], "og_title": string, "og_description": string,\n' +
    '    "estimated_read_time": string (e.g. "4 min read"), "slug": string (same as post_slug)\n' +
    '  }\n' +
    '}\n\n' +
    'Every section must include at least one concrete, specific detail — a person\'s role, a produce item, a ' +
    'real app feature, a specific number or statistic — never a paragraph that only makes an abstract ' +
    'claim with nothing concrete in it. Never name a specific city, town, neighbourhood, or province as a ' +
    'setting or example (e.g. never write "Toronto", "Edmonton", "Ontario", or any other Canadian city/' +
    'region/neighbourhood) — "Canada" is the only place name allowed anywhere in the post. Do not open ' +
    'consecutive paragraphs the same way (e.g. do not start ' +
    'every paragraph with "Fresh-CAN" or the same transition word) — vary sentence openers throughout. ' +
    'For "seo": meta_description must be 140-160 characters; focus_keyword must appear in post_title, in ' +
    'the introduction, and in exactly one section heading or h3 — never repeated beyond that.' +
    (opts.sceneNotes
      ? `\n\nThe copy must stay true to the user's own creative idea for this post: "${opts.sceneNotes}". The ` +
        'brand mission and voice guidance above is a fixed constraint on tone and accuracy, never the angle — ' +
        'follow the outline\'s sections above, which were already built around this same idea.'
      : '') +
    (opts.regenInstructions ? `\n\nThe user asked for this rewrite: ${opts.regenInstructions}` : '')
  )
}

export interface CaptionSystemPromptOptions {
  language: string
  /** Resolved text of the job's selected content_angle (brand.adAngleBriefs
   *  lookup), or undefined if the user left it on "let AI decide". */
  angleBrief?: string
  /** The same assembled scene text used to build the accompanying photo
   *  (content_jobs.scene_notes + any clarifying-question answers — see
   *  image.ts's photoScene()). Without this the caption was only ever built
   *  from topic/category/angleBrief, so it could describe a generic take on
   *  the topic while the photo depicted the user's specific scene idea —
   *  undefined only for a pre-existing job created before scene_notes
   *  became required. */
  scene?: string
  /** Set only for 'infographic'-style jobs, once generate_ad_copy has
   *  succeeded — the exact headline/subtitle already rendered onto the
   *  image, so the caption can be told what's on it instead of guessing an
   *  unrelated take on the same topic. */
  imageHeadline?: string
  imageSubtitle?: string
  imageCoreMessage?: string
}

export function composeCaptionSystemPrompt(brand: BrandProfile, opts: CaptionSystemPromptOptions): string {
  return (
    `${brand.missionStatement} Voice: ${brand.voiceGuidelines}${bannedWordsLine(brand)}${statsLine(brand)}\n\n` +
    (opts.angleBrief ? `This specific post should focus on: ${opts.angleBrief}\n\n` : '') +
    (opts.scene
      ? `The accompanying photo depicts this specific moment: "${opts.scene}". Write the caption about this ` +
        'same moment, not a generic restatement of the topic or category.\n\n'
      : '') +
    (opts.imageHeadline
      ? `The accompanying image already has this text rendered directly onto it — headline "${opts.imageHeadline}"` +
        (opts.imageSubtitle ? ` and subtitle "${opts.imageSubtitle}"` : '') +
        (opts.imageCoreMessage ? `, built around this idea: ${opts.imageCoreMessage}.` : '.') +
        ' Write a caption that reads as part of the same post as that image — reinforce the same idea in ' +
        'your own words, do not simply repeat the headline verbatim.\n\n'
      : '') +
    `You are a social media copywriter. Write an Instagram-style caption in ${opts.language} ` +
    'for a social image post. Respond with strictly valid JSON matching this exact shape: ' +
    '{ "caption": string, "hashtags": string[] (5-8 tags, no "#" prefix), ' +
    '"alt_text": string (a plain factual description of the photo\'s likely content, for accessibility) }.'
  )
}

export interface VideoScriptSystemPromptOptions {
  category: string
  scriptType: string
  /** User-selected target total runtime, in seconds (content_jobs.
   *  video_duration_seconds, supabase/migrations/20260914000000) — a
   *  target for the model to aim for, not a hard cap. Previously this
   *  prompt had no real number at all; "approximately duration_seconds"
   *  was referencing the model's OWN output field name, giving it zero
   *  actual length signal (confirmed live 2026-09-13: a real run picked
   *  90s of total runtime with no target to react to). */
  targetDurationSeconds: number
}

/**
 * Produces the script AND its scene-by-scene shot plan in ONE call
 * (ARCHITECTURE.MD §17.1 — scene planning is not a separate post-approval
 * step; real production draft data showed it was already produced alongside
 * the script, and splitting it out would just be an unneeded round-trip).
 * `narration_intent` is deliberately SEMANTIC ("the idea to convey"), never
 * literal wording — it's what a later, per-language localize_script step
 * translates into actual EN/FR narration text. This is the one thing that
 * keeps the shared scene plan genuinely language-neutral; a model that
 * writes literal English sentences into narration_intent here would quietly
 * reintroduce the "FR is just a translation of the EN script" bug this
 * whole redesign exists to avoid.
 */
export function composeVideoScriptSystemPrompt(brand: BrandProfile, opts: VideoScriptSystemPromptOptions): string {
  return (
    brandContext(brand, opts.category) +
    statsLine(brand) +
    `\n\nYou are a video scriptwriter and shot planner. Produce a short-form marketing video script AND its ` +
    `scene-by-scene shot plan in ONE response. Script type: ${opts.scriptType}.\n\n` +
    'Respond with strictly valid JSON matching this exact shape (all fields required):\n' +
    '{\n' +
    '  "script": string (the full narration/voiceover text, human-readable, in English, for internal review only),\n' +
    '  "visual_description": string (one-paragraph overview of the video\'s overall visual concept),\n' +
    '  "duration_seconds": number (total estimated runtime, summing the scenes below),\n' +
    '  "scenes": [\n' +
    '    {\n' +
    '      "scene_number": number (1-indexed, sequential, no gaps),\n' +
    '      "visual_description": string (what the camera shows — specific enough to generate an image from),\n' +
    '      "shot_notes": string (camera angle/movement notes; "" if none),\n' +
    '      "narration_intent": string (the SEMANTIC content this scene\'s narration should convey — describe ' +
    'the idea in plain terms, NEVER write it as a finished sentence in any one language, since this gets ' +
    'independently localized into actual EN or FR wording by a later step),\n' +
    '      "target_duration_seconds": number (this scene\'s planned runtime budget)\n' +
    '    }\n' +
    '  ]\n' +
    '}\n' +
    `Produce between 4 and 10 scenes whose target_duration_seconds sum to approximately ${opts.targetDurationSeconds} ` +
    'seconds — that is the target runtime, aim for it. Treat it as a guideline, not a hard cutoff: it is fine ' +
    'for the true total to land a bit short or long of it if that is what a complete, naturally-paced narration ' +
    'actually needs. Never truncate a scene\'s narration_intent, or drop a scene\'s idea early, just to force the ' +
    'total to match exactly.'
  )
}

export interface LocalizeScriptSystemPromptOptions {
  /** Full word ("English"/"French"), not the EN/FR code — reads more
   *  naturally in the instruction itself. */
  language: string
}

/**
 * The ONLY place video narration wording is produced per language
 * (ARCHITECTURE.MD §4.2 step 6a/§13's n8n mapping table) — takes each
 * scene's language-neutral narration_intent and localizes it, never
 * regenerating the scene plan itself. This is what replaces n8n's "FR —"
 * forced-script-regeneration branch, which is retired entirely, not ported
 * forward (worker/src/steps/video/localizeScript.ts).
 */
export function composeLocalizeScriptSystemPrompt(brand: BrandProfile, opts: LocalizeScriptSystemPromptOptions): string {
  return (
    `${brand.missionStatement} Voice: ${brand.voiceGuidelines}${bannedWordsLine(brand)}\n\n` +
    `You are localizing a video's narration into ${opts.language}. You will be given a list of scenes, each ` +
    'with a "narration_intent" (the SEMANTIC content that scene\'s narration should convey — not literal ' +
    `wording) and a target_duration_seconds budget. Write the actual narration wording in ${opts.language} for ` +
    'each scene, fitting comfortably within its target duration (roughly 2.5 words per second is a reasonable ' +
    'speaking pace) — a soft constraint, not an exact word count. Respond with strictly valid JSON: ' +
    '{ "scenes": [ { "scene_number": number, "narration_text": string } ] }, exactly one entry per scene given, ' +
    'in the same order, using the given scene_number values unchanged.'
  )
}

export interface AdCopySystemPromptOptions {
  category: string
  /** Resolved text of the job's selected content_angle, or undefined if the
   *  user left it on "let AI decide". */
  angleBrief?: string
  /** The same assembled scene text used to build the accompanying photo
   *  (content_jobs.scene_notes + any clarifying-question answers — see
   *  image.ts's photoScene()) — so the on-image headline/subtitle stay
   *  cohesive with the photo's actual scene instead of guessing an
   *  unrelated take on the topic. Undefined only for a pre-existing job
   *  created before scene_notes became required. */
  scene?: string
}

/**
 * Produces the shared headline/subtitle rendered directly onto an
 * 'infographic'-style image_post photo (see worker/src/steps/image/generateAdCopy.ts)
 * — plus a coreMessage that isn't shown publicly anywhere, but gets folded
 * into composeCaptionSystemPrompt above so the per-language caption stays
 * cohesive with whatever specific idea the headline/subtitle are about,
 * instead of the two being independent, unrelated guesses at the same topic.
 */
export function composeAdCopySystemPrompt(brand: BrandProfile, opts: AdCopySystemPromptOptions): string {
  return (
    brandContext(brand, opts.category) +
    (opts.angleBrief ? `This specific post should focus on: ${opts.angleBrief}\n\n` : '') +
    (opts.scene
      ? `The accompanying photo depicts this specific moment: "${opts.scene}". Base the headline/subtitle/` +
        'coreMessage on this same moment, not a generic restatement of the topic or category.\n\n'
      : '') +
    'You are an ad copywriter preparing the text that will be rendered directly onto a social image, plus a ' +
    'creative brief for whoever writes its caption. Respond with strictly valid JSON matching this exact ' +
    'shape: { "headline": string (max 6 words, punchy, spelled exactly as you want it rendered on the ' +
    'image), "subtitle": string (2-5 words, a short supporting line under the headline), "coreMessage": ' +
    'string (one sentence describing the specific idea, story, or moment this post is about) }. The ' +
    'headline and subtitle are the ONLY text that will be rendered onto the image itself — keep them short ' +
    'enough to read at a glance and free of typos. coreMessage is never shown to the public; it only guides ' +
    'the caption writer.'
  )
}
