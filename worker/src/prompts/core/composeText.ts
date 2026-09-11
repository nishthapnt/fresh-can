// Text-generation prompt assembly — same pattern as core/compose.ts's image
// prompts: fixed brand facts (mission, voice, real stats, category briefs)
// live in the brand file and get spliced into every prompt, rather than
// each step file writing brand-blind, topic-only prompts from scratch.
import type { BrandProfile } from '../types.js'

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

export function composeOutlineSystemPrompt(brand: BrandProfile, category: string): string {
  return (
    brandContext(brand, category) +
    'You are a content strategist. Produce a JSON outline for a blog post with a title, ' +
    'a list of section headings, and a one-sentence summary of each section. Also include "headline" ' +
    '(max 6 words, a punchy standalone version of the title, suitable for rendering on an image) and ' +
    '"subtitle" (2-5 words) — these are only used if the post\'s image style calls for on-image text, but ' +
    'always include them.'
  )
}

export interface CopySystemPromptOptions {
  language: string
  category: string
  regenInstructions?: string | null
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
    '    "introduction": string (1-2 paragraphs),\n' +
    '    "sections": [\n' +
    '      {\n' +
    '        "heading": string,\n' +
    '        "h3s": string[] (sub-headings within this section, [] if none),\n' +
    '        "paragraphs": string[] (the section\'s actual body copy, one string per paragraph — ' +
    'this is the main content, never leave it empty),\n' +
    '        "list_items": string[] ([] if this section has no bulleted list),\n' +
    '        "blockquote": { "text": string, "cite": string } or null,\n' +
    '        "has_inline_image": boolean (true for exactly one section, the best fit for a supporting photo)\n' +
    '      }\n' +
    '    ],\n' +
    '    "conclusion": string,\n' +
    '    "cta": { "heading": string, "text": string, "button_label": string, "button_url": string }\n' +
    '  },\n' +
    '  "seo": {\n' +
    '    "title": string, "meta_description": string, "focus_keyword": string,\n' +
    '    "secondary_keywords": string[], "og_title": string, "og_description": string,\n' +
    '    "estimated_read_time": string (e.g. "4 min read"), "slug": string (same as post_slug)\n' +
    '  }\n' +
    '}' +
    (opts.regenInstructions ? `\n\nThe user asked for this rewrite: ${opts.regenInstructions}` : '')
  )
}

export interface CaptionSystemPromptOptions {
  language: string
  location?: string
  /** Resolved text of the job's selected content_angle (brand.adAngleBriefs
   *  lookup), or undefined if the user left it on "let AI decide". */
  angleBrief?: string
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
    '"alt_text": string (a plain factual description of the photo\'s likely content, for accessibility) }.' +
    (opts.location
      ? ` Make the caption feel locally relevant to ${opts.location} — reference the community by name ` +
        'where it reads naturally, and include a location-relevant hashtag.'
      : '')
  )
}

export interface AdCopySystemPromptOptions {
  category: string
  /** Resolved text of the job's selected content_angle, or undefined if the
   *  user left it on "let AI decide". */
  angleBrief?: string
}

/**
 * Produces the shared headline/subtitle rendered directly onto an
 * 'infographic'-style image_post photo (see worker/src/steps/generateAdCopy.ts)
 * — plus a coreMessage that isn't shown publicly anywhere, but gets folded
 * into composeCaptionSystemPrompt above so the per-language caption stays
 * cohesive with whatever specific idea the headline/subtitle are about,
 * instead of the two being independent, unrelated guesses at the same topic.
 */
export function composeAdCopySystemPrompt(brand: BrandProfile, opts: AdCopySystemPromptOptions): string {
  return (
    brandContext(brand, opts.category) +
    (opts.angleBrief ? `This specific post should focus on: ${opts.angleBrief}\n\n` : '') +
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
