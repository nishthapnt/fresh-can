// Text-generation prompt assembly — same pattern as core/compose.ts's image
// prompts: fixed brand facts (mission, voice, real stats, category briefs)
// live in the brand file and get spliced into every prompt, rather than
// each step file writing brand-blind, topic-only prompts from scratch.
import type { BrandProfile, CreativeBrief, ImageStyle } from '../types'

/**
 * Renders a CreativeBrief (Layer 1, PROMPT_REFACTOR_BRIEF.md §4.2) as
 * grounding context for a Layer 2 planning prompt. Framed explicitly as
 * something to BUILD FROM, never a second, competing instruction set — same
 * "constraint/grounding, never the point" pattern every scene-idea clause in
 * this file already uses (see composeOutlineSystemPrompt's/
 * composeVideoScriptSystemPrompt's own sceneNotes handling).
 */
function creativeBriefContext(brief: CreativeBrief): string {
  const constraints = brief.constraintsFromAdmin
    ? ` The admin also specified this non-negotiable constraint, which must be preserved exactly: ${brief.constraintsFromAdmin}`
    : ''
  const improvements = brief.improvements ? ` ${brief.improvements}` : ''
  return (
    `An earlier interpretation pass already read the admin's idea and produced this brief — treat it as your ` +
    `own prior thinking, not a second opinion to reconcile: intent is "${brief.intent}"; the core message is ` +
    `"${brief.coreMessage}"; audience "${brief.audience}"; tone "${brief.emotionalTone}"; the viewer should ` +
    `"${brief.desiredResponse}".${improvements}${constraints} That same pass also estimated the brand's ` +
    `physical unit is "${brief.unitRelevance.value}" to this idea (${brief.unitRelevance.rationale}) — treat ` +
    'this as a starting point to confirm or refine with the full context below, never as a directive that ' +
    'overrides your own judgment once you have it.'
  )
}

function bannedWordsLine(brand: BrandProfile): string {
  return brand.bannedWords.length > 0 ? ` Avoid these overused phrases: ${brand.bannedWords.join(', ')}.` : ''
}

function statsLine(brand: BrandProfile): string {
  return brand.statistics.length > 0
    ? ` You may cite ONE of these real, verified facts if it is genuinely relevant to this specific topic — ` +
        `never force one in, never alter the number: ${brand.statistics.join(' | ')}.`
    : ''
}

// category is accepted for call-site compatibility (every brandContext
// caller already has it in scope) but deliberately does not shape the
// prompt — per-category canned creative direction was removed
// (PROMPT_REFACTOR_BRIEF.md §6.2); category may remain light job metadata
// but must never dictate subject, setting, composition, or style.
function brandContext(brand: BrandProfile, _category: string): string {
  return `${brand.missionStatement} Voice: ${brand.voiceGuidelines}${bannedWordsLine(brand)}\n\n`
}

const CONTENT_TYPE_LABEL: Record<string, string> = {
  video: 'a short-form vertical video',
  image_post: 'a single social media image post',
  blog: 'a blog article',
}

/**
 * Layer 1 (PROMPT_REFACTOR_BRIEF.md §4.2/§5.1) — turns the admin's raw idea
 * into a structured creative brief, the single input every subsequent
 * planning step (blog outline, video script, image plan) will read from.
 * Grounded in the brand's real business-model facts (journey/negatives) so
 * `unitRelevance` and `improvements` are decided against what Fresh-CAN
 * actually is, not a guess — but never lets those facts become a second,
 * competing topic (same "constraint, never the point" framing every other
 * prompt in this file already uses for scene ideas).
 */
export function composeIntentSystemPrompt(brand: BrandProfile, contentType: string): string {
  const contentTypeLabel = CONTENT_TYPE_LABEL[contentType] ?? 'a piece of content'
  const journeyLine = brand.journey.length > 0 ? ` The real customer journey: ${brand.journey.join(' ')}` : ''
  const negativesLine =
    brand.businessModelNegatives.length > 0 ? ` ${brand.businessModelNegatives.join(' ')}` : ''

  return (
    `${brand.missionStatement}${journeyLine}${negativesLine}\n\n` +
    'You are interpreting an admin\'s raw idea for ' +
    `${contentTypeLabel} before any script, outline, or image plan gets written. Read the idea charitably ` +
    'and specifically — assume it is a genuine, considered starting point, not a vague prompt to pad out. ' +
    'Identify what the admin is actually trying to accomplish. If the idea is thin, strengthen it with ' +
    'concrete, specific detail that serves the SAME idea — elevate it, never replace it or substitute a ' +
    "different angle; anything the admin stated explicitly is binding and must survive into your output " +
    'unchanged. Decide how relevant the brand\'s physical unit (the mobile grocery store) is to this specific ' +
    'idea: "central" if the idea is fundamentally about visiting, entering, shopping in, finding, or the ' +
    'existence/arrival of a unit, or is a direct how-it-works/customer-journey explainer; "incidental" if the ' +
    'unit could plausibly belong in the setting and reinforce context without being the subject (e.g. a ' +
    'community moment on a street where a unit happens to be parked) — never forced in; "none" for pure food/ ' +
    'nutrition education, recipes, produce/farm stories, awareness or community/emotional pieces with no ' +
    'natural place for the unit, and any interior domestic setting (a kitchen, dining room, living room). ' +
    'Never invent a fact, statistic, price, launch date, store count, or place name beyond "Canada" that is ' +
    'not already in the brand facts above or the admin\'s own input.\n\n' +
    'Respond with strictly valid JSON matching this exact shape (all fields required, use "" for a genuinely ' +
    'empty string field):\n' +
    '{\n' +
    '  "intent": string (what the admin is actually trying to do — marketing, promotion, awareness, food/' +
    'nutrition education, a community story, a product/how-it-works explainer, or another goal that fits ' +
    'better — inferred from the idea itself, never picked from a fixed list),\n' +
    '  "coreMessage": string (the single idea the viewer must leave with),\n' +
    '  "audience": string,\n' +
    '  "emotionalTone": string,\n' +
    '  "desiredResponse": string (what the viewer should think, feel, or do after seeing this),\n' +
    '  "unitRelevance": { "value": "central" | "incidental" | "none", "rationale": string (one sentence, ' +
    'honest and specific to this idea, never boilerplate) },\n' +
    '  "improvements": string (where the idea was thin, what you added to strengthen it — "" if it was ' +
    'already specific and complete),\n' +
    '  "constraintsFromAdmin": string (anything the admin stated that is non-negotiable and must be ' +
    'preserved exactly — "" if none)\n' +
    '}'
  )
}

export interface ImagePlanSystemPromptOptions {
  imageStyle: ImageStyle
  /** The dashboard's "Your Scene Idea" plus any clarifying-question answers
   *  — the same assembled scene text composePhotoPrompt is built around
   *  (see image.ts's photoScene()). This is the creative brief the plan is
   *  built around, never a light influence. */
  scene: string
}

/**
 * Layer 2 (PROMPT_REFACTOR_BRIEF.md §4.3) — image_post's plan. image_post
 * had no planning step of its own before Phase 3 (only 'infographic'-style
 * jobs got any planning pass at all, via generate_ad_copy's headline/
 * subtitle). Runs for both 'photo' and 'infographic' styles. Grounded in
 * the brand's business-model negatives (Phase 1) so the plan itself never
 * proposes a composition that Layer 3 would have to reject — e.g. this is
 * where "not a cashier or checkout counter" gets applied to what the model
 * PLANS, not just what it later avoids drawing.
 */
export function composeImagePlanSystemPrompt(
  brand: BrandProfile,
  opts: ImagePlanSystemPromptOptions,
  creativeBrief?: CreativeBrief,
): string {
  const negativesLine =
    brand.businessModelNegatives.length > 0 || brand.forbiddenInScene.length > 0
      ? ` ${[...brand.businessModelNegatives, ...brand.forbiddenInScene].join(' ')}`
      : ''
  const textPlanInstruction =
    opts.imageStyle === 'infographic'
      ? '"textPlan" is required for this job (image_style: "infographic") — a short headline (max 6 words) ' +
        'and subtitle (2-5 words) that will be rendered directly onto the image, grounded in the scene above.'
      : '"textPlan" MUST be null for this job (image_style: "photo") — this style never renders on-image text.'

  return (
    `${brand.missionStatement}${negativesLine}\n\n` +
    'You are planning a single social media image post before it gets rendered. This is the creative brief ' +
    `the plan is built around: "${opts.scene}". Brand facts above are fixed constraints on correctness if ` +
    'they appear — never the reason this image exists, and never a directive on style, mood, or composition, ' +
    "which stay entirely up to the scene above." +
    (creativeBrief ? `\n\n${creativeBriefContext(creativeBrief)}` : '') +
    '\n\nDecide honestly whether the brand\'s physical unit (the mobile grocery store) belongs in this frame: ' +
    '"featured" only if the scene above is genuinely about the unit itself (visiting, entering, shopping in, ' +
    'or the unit\'s own arrival/existence); "background" if it could plausibly and unobtrusively belong in the ' +
    'setting without being the subject — never forced in; "none" for anything else, including any interior ' +
    'domestic setting (a kitchen, dining room, living room) or a pure produce/food close-up.\n\n' +
    'Respond with strictly valid JSON matching this exact shape:\n' +
    '{\n' +
    '  "designIntent": string (what this image needs to accomplish, in one sentence),\n' +
    '  "subject": string (what/who is actually in frame),\n' +
    '  "composition": string (framing, focal hierarchy, negative space — a real compositional plan, not a ' +
    'restatement of the subject),\n' +
    '  "unitPresence": "none" | "background" | "featured",\n' +
    '  "unitPresenceRationale": string (one sentence, honest and specific to this image, never boilerplate),\n' +
    '  "setting": "exterior" | "interior" | "unrelated",\n' +
    '  "containsFood": boolean,\n' +
    '  "castDescription": string ("" if no people are in the scene),\n' +
    `  "textPlan": { "headline": string, "subtitle": string } or null (${textPlanInstruction}),\n` +
    '  "safeZone": "top-right" (fixed — the logo watermark is composited there after generation; keep that ' +
    'corner visually clean in the composition above — no text, no face, no high-detail clutter there)\n' +
    '}'
  )
}

export function composeOutlineSystemPrompt(
  brand: BrandProfile,
  category: string,
  sceneNotes?: string | null,
  creativeBrief?: CreativeBrief,
): string {
  return (
    brandContext(brand, category) +
    'You are a content strategist. Respond with strictly valid JSON matching this exact shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "headline": string (max 6 words, a punchy standalone version of the title, suitable for rendering on ' +
    'an image — only used if the post\'s image style calls for on-image text, but always include it),\n' +
    '  "subtitle": string (2-5 words, same on-image-only caveat as headline),\n' +
    '  "sections": [ { "heading": string, "summary": string (one sentence) } ] (exactly 3 to 5 entries)\n' +
    '}\n' +
    'Each heading and summary must reference something concrete and specific to this exact topic — a real ' +
    'detail, angle, or example — never a generic restatement of the brand\'s mission or a vague marketing ' +
    'angle that could apply to any post.' +
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
        'never as the angle itself. The scene idea decides what this post is actually about.' +
        (creativeBrief ? `\n\n${creativeBriefContext(creativeBrief)}` : '')
      : '')
  )
}

export interface ReferenceCopySystemPromptOptions {
  title: string
  sections: { heading: string; summary: string }[]
}

/**
 * Layer 2 addition (PROMPT_REFACTOR_BRIEF.md §9.3) — the shared,
 * language-neutral pass between the outline and hero/inline image
 * generation. NOT the final published copy (that's composeCopySystemPrompt,
 * generated separately per language track, after images already exist) —
 * this exists solely to give the shared images real, specific substance to
 * be grounded in, instead of just the outline's bare headline/subtitle.
 * Expands the ALREADY-APPROVED outline; never invents new structure or
 * sections of its own.
 */
export function composeReferenceCopySystemPrompt(brand: BrandProfile, opts: ReferenceCopySystemPromptOptions): string {
  const sectionsList = opts.sections.map((s, i) => `${i + 1}. "${s.heading}" — ${s.summary}`).join('\n')
  return (
    `${brand.missionStatement} Voice: ${brand.voiceGuidelines}\n\n` +
    'An outline for this blog post has already been approved. You are expanding it into a compact brief for ' +
    'the images that will illustrate it — never rewriting the outline\'s own structure, and never producing ' +
    `the actual publishable copy (that is written separately, per language, later).\n\nTitle: "${opts.title}"\n` +
    `Sections:\n${sectionsList}\n\n` +
    'Respond with strictly valid JSON matching this exact shape:\n' +
    '{\n' +
    '  "coreMessage": string (2-3 sentences capturing the single specific idea this whole article is ' +
    'actually about — grounded in the title and sections above, never a generic restatement of the brand\'s ' +
    'mission),\n' +
    '  "inlineHighlight": {\n' +
    '    "heading": string (must exactly match ONE of the section headings above — pick whichever section ' +
    'suggests the most genuinely specific, concrete visual moment, not necessarily the first one),\n' +
    '    "visualMoment": string (1-2 sentences describing a real, specific visual moment that section\'s ' +
    'content suggests — not a restatement of the heading or summary)\n' +
    '  }\n' +
    '}'
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
    `every paragraph with "${brand.name}" or the same transition word) — vary sentence openers throughout. ` +
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
  /** The dashboard's "Your Scene Idea" field (content_jobs.scene_notes) —
   *  same required-creative-brief treatment as composeOutlineSystemPrompt's
   *  (see that function), now extended to video: the story and every scene
   *  are built around this idea, with the brand facts above acting as fixed
   *  constraints on tone/accuracy/how branded elements must look or sound
   *  IF they appear — never as the angle itself. Optional/nullable for a
   *  pre-existing job created before the field became required. */
  sceneNotes?: string | null
  /** Layer 1's interpreted brief (PROMPT_REFACTOR_BRIEF.md §4.2), produced
   *  by steps/shared/interpretIntent.ts. Optional so a caller that hasn't
   *  run that step yet (or a legacy job predating it) still works exactly
   *  as before. Only folded in alongside sceneNotes — see
   *  composeVideoScriptSystemPrompt's own body for why. */
  creativeBrief?: CreativeBrief
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
 *
 * `sceneNotes` (added alongside the anti-ad framing below) brings video in
 * line with how composeOutlineSystemPrompt/composeBlogImage/composePhotoPrompt
 * already treat the dashboard's "Your Scene Idea" field and SCENE_IS_CREATIVE_BRIEF
 * (core/compose.ts): the brand's mission/voice/category/real physical
 * descriptions are fixed CONSTRAINTS on what must look, sound, or feel
 * correct if they appear — never the reason a scene exists. Without this,
 * the model defaults to writing the vehicle/app/brand into the center of
 * every scene, which is exactly what makes generated video read as an ad
 * instead of a real moment.
 *
 * Rewritten 2026-09-19 after a real generation given a fully unrelated
 * scene idea (a family's cozy autumn dinner — pumpkin, squash, sweet
 * potatoes, warm spices, no mention of Fresh-CAN at all) ignored it
 * completely and wrote a generic Fresh-CAN mission/food-desert pitch
 * instead — real statistics cited, the mobile unit forced into 4 of 7
 * scenes. The scene-idea clause used to be a single sentence appended at
 * the very END of this entire system prompt, AFTER the brand's full
 * mission statement, its category brief (a directive: "this category
 * should focus on..." — a second, directly competing topic), real
 * statistics available to cite, the whole JSON schema, and every other
 * instruction below. By the time the model reached it, it had already
 * been primed hard toward brand/mission content, and one trailing
 * sentence was nowhere near enough to override that. The idea now leads
 * instead — brand facts are reframed as background constraints from the
 * very first sentence — and the category brief/statistics (the two most
 * topic-like, directly competing pieces of brand content) are dropped
 * entirely rather than reworded softer: there's no safe phrasing of "here
 * is a second, whole different topic you may also want to write about"
 * that doesn't risk reintroducing exactly this bug.
 *
 * Follow-up the same day: even after the rewrite above, the user asked why
 * a generation about that same unrelated autumn-dinner idea still
 * mentioned "food desert communities" at all. Answer: missionStatement
 * itself — quoted verbatim as "background context" — literally contains
 * that phrase (see fresh-can.ts), regardless of which category was
 * selected; a category brief was never the only source of topic drift.
 * `brand.neutralIdentityLine` (falls back to missionStatement when unset)
 * exists so this branch can quote a short, purely-factual line instead —
 * the same "remove the competing content, don't just reframe it" judgment
 * already applied to the category brief/statistics above.
 *
 * 2026-09-21: the anti-hijack fix above worked almost too well — real user
 * feedback was that generated videos now read as either forcibly about the
 * truck (whenever a scene happened to mention it) or with NO connection to
 * the brand campaign at all, nothing recognizable as belonging to Fresh-
 * CAN's own social feed. First attempt at CAMPAIGN_FIT (later the same day)
 * was pure reassurance ("real warmth/community already qualifies, nothing
 * needs to be added") — too soft: the very next real generation still had
 * zero recognizable connection to Fresh-CAN at all, just the scene idea
 * with no brand thread anywhere. Second attempt required a genuine
 * CONNECTION but treated the literal brand name as merely "ideal," one of
 * several equally-valid options alongside generic "fresh/local" language —
 * still too easy for the model to satisfy with vague food-freshness talk
 * and never actually say "Fresh-CAN." Third attempt made the name itself a
 * hard requirement, layered on top of the mission connection — this DID
 * produce a real script mentioning "Fresh-CAN" twice, but review of that
 * real output surfaced two further gaps, both closed in this (fourth)
 * revision:
 *
 * (a) The model satisfied the requirement by writing "Fresh-CAN" into the
 * top-level `script` field — which the schema itself labels "for internal
 * review only" — while `narration_intent`, the field that actually reaches
 * the audience (composeLocalizeScriptSystemPrompt below reads ONLY
 * narration_intent, never the top-level script), had no guarantee of
 * carrying the same mention. CAMPAIGN_FIT now says explicitly which field
 * the mention must live in.
 *
 * (b) The real output's final scene asked for "the screen transitions to
 * the Fresh-CAN logo" as its own visual_description — i.e. asking an image/
 * video generation model to DRAW the actual brand logo from a text
 * description, the exact failure mode watermark.ts (src/server/pipeline/
 * lib/watermark.ts) already exists to avoid for images ("risked a
 * plausible-but-wrong rendering... this stamps the actual asset on
 * instead") — video has no equivalent real-asset-compositing step, so a
 * scene like that would only ever produce an AI-hallucinated approximation
 * of the logo, never the real one. CAMPAIGN_FIT now explicitly forbids
 * writing a scene whose subject is the logo/wordmark/any brand graphic —
 * the Fresh-CAN connection must live entirely in narration, never in a
 * shot asking a generative model to render brand artwork.
 *
 * The key distinction that keeps all of this from reopening the original
 * hijack bug: MESSAGING (reciting the mission statement, statistics, a
 * slogan, forcing the vehicle into a scene it doesn't fit) is still
 * forbidden; ONE specific, natural, spoken mention of the name itself,
 * written into the right scene's narration_intent and grounded in a
 * genuine narrative connection to what Fresh-CAN actually does, is
 * required.
 *
 * 2026-09-22: fifth revision — not another rewrite of the requirement
 * above (real production data already confirmed it works: a real
 * generation said "Fresh-CAN" twice in actual synthesized narration), but
 * an explicit ask to make the SURROUNDING creative process more
 * structured, and to make how much Fresh-CAN shows up beyond that one
 * required mention scale with how directly the user's idea already
 * concerns the brand, instead of being the same fixed ask for every idea.
 * Added STORY_PLANNING_CLAUSE (a silent, internal 6-step planning pass —
 * core idea, story arc, a deliberately chosen creative device, a
 * background/supporting/enabler/subject/hero classification of Fresh-CAN's
 * role in THIS idea, a recurring visual motif, and per-scene purpose —
 * explicitly never exposed in the JSON output, so the existing schema
 * generateScript.ts depends on didn't need to change) and
 * FRESHCAN_ROLE_ADAPTIVITY (how much VISUAL/NARRATIVE presence — the
 * vehicle appearing, more direct narration — is earned by that
 * classification; the one required spoken name-mention above stays a flat,
 * non-negotiable floor at every role level, since that's the specific,
 * production-validated fix an idea with only a loose connection should
 * never lose). Also added BRAND_ASSET_FIDELITY (never invent/redesign the
 * logo, vehicle, or a product/service that doesn't exist — the narrative-
 * level counterpart to what containerDescriptor/REFERENCE_IS_GUIDE_NOT_COPY
 * already enforce at the image-prompt layer in compose.ts) and
 * FINAL_SELF_CHECK_CLAUSE (a silent pre-return quality gate). None of this
 * changes the JSON schema, the DB columns it's written into, or
 * isVideoSceneAboutUnit's keyword-based per-scene truck decision (scene.ts)
 * — all of it is prompt-only, richer guidance flowing into the same
 * visual_description/shot_notes/narration_intent fields that already
 * existed, per the request's own "preserve JSON structure/DB expectations,
 * modify the smallest number of files necessary."
 */
function campaignFit(brand: BrandProfile): string {
  return (
    `That does not mean the story can ignore ${brand.name}, though — every video is made for ${brand.name}'s own brand ` +
    `campaign, so it must still genuinely connect to ${brand.name}'s real mission and goals, no matter how creative ` +
    'the idea gets. This is required, not optional, and has two parts, both required together: (1) find the ' +
    `honest, natural bridge between the idea above and what ${brand.name} actually does — bringing fresh, ` +
    'affordable, local groceries directly into communities — and let it show through the story\'s own real ' +
    'details: food that reads as genuinely fresh and local, a real neighbourhood or community feeling, people ' +
    `getting good food easily; and (2) the ${brand.name} name itself must be said explicitly, out loud, somewhere in ` +
    'the narration across the video — this is REQUIRED, not merely ideal, and is never satisfied by "fresh" or ' +
    '"local" language alone, no matter how strong the thematic connection is otherwise. This MUST be written ' +
    'directly into the relevant scene\'s own "narration_intent" field below, in plain semantic terms (e.g. ' +
    `"mentions this was made possible by ${brand.name}") — the top-level "script" field is for internal review only ` +
    'and is never what actually reaches the audience, so writing the mention there alone does NOT satisfy this ' +
    'requirement. Find the single most natural moment already in the story for it — wherever food, its origin, a ' +
    'delivery, or a visit is already part of the scene — and have that scene\'s narration_intent call for naming ' +
    `${brand.name} there directly, the way a real person would actually say it out loud in that moment. The ` +
    'difference from reciting the mission statement or forcing the vehicle in: this is ONE specific, natural ' +
    'mention of the name, grounded in the story\'s own real details, never a slogan, statistic, or pitch stated ' +
    'on top of the scene. Never write a scene whose subject is the brand\'s logo, wordmark, or any graphic/text ' +
    'reveal — no visual_description should ask for the logo to be drawn, shown, or transitioned to; an AI image ' +
    `or video model cannot reproduce the real logo accurately, so the ${brand.name} connection belongs entirely in ` +
    'the spoken narration above, never as a visual logo or brand-graphic shot.'
  )
}

// Silent internal planning pass, run before the model writes any scene —
// see CAMPAIGN_FIT's own header, "2026-09-22: fifth revision," for why this
// was added and why it deliberately never touches the JSON schema below
// (generateScript.ts's normalizeScriptOutput has no field for any of this;
// it's reasoning that should shape the existing visual_description/
// shot_notes/narration_intent output, not a new output of its own).
function storyPlanningClause(brand: BrandProfile): string {
  return (
    'Before writing the scenes below, silently work through the following — this is internal reasoning, never ' +
    'part of your JSON output, which must contain only the fields the schema below asks for: (1) Core creative ' +
    'idea — what genuinely makes the idea above interesting or worth watching? (2) Story arc — a hook, a ' +
    'development, and a payoff, or another structure that fits this specific idea better. (3) Creative device — ' +
    'choose ONE device that serves this idea, such as a visual reveal, an object\'s own journey, a POV shot, a ' +
    'match cut, a cause-and-effect chain, a transformation, a human moment, or another device that fits better ' +
    `than any of these. (4) ${brand.name}'s role in this story — classify it as background, supporting, enabler, ` +
    `subject, or hero, based on how directly the idea above already concerns ${brand.name} or its mission (an idea ` +
    `with no real connection to groceries or the brand is background; an idea directly about ${brand.name}'s own ` +
    'mission or service is hero) — this is an honest read of the idea itself, never a default, since the ' +
    'branding guidance below scales against it. If an earlier pass already estimated how relevant the physical ' +
    'unit is to this idea, treat that as a starting point to confirm or refine here, with the full idea and ' +
    'scenes you are now planning — your own classification, made with that fuller context, is what the ' +
    'branding guidance below actually scales against. (5) Visual motif — one recurring visual element (a color, an ' +
    'object, a gesture, a shot type) that can carry across multiple scenes for cohesion. (6) Scene purpose — plan ' +
    'what specific job each scene does in the story before writing it; every scene must advance the story, never ' +
    'exist as one more pretty but disconnected shot.'
  )
}

// How much Fresh-CAN shows up BEYOND the one required narration mention
// above scales with STORY_PLANNING_CLAUSE's role classification — see
// CAMPAIGN_FIT's header for why the mention itself stays a flat,
// non-negotiable floor at every role level regardless.
function freshcanRoleAdaptivity(brand: BrandProfile): string {
  return (
    `How visually and narratively present ${brand.name} is beyond that one required mention should scale with the ` +
    'role you classified during planning, not be the same for every idea. For a background, supporting, or ' +
    `enabler role — the idea has only a loose or everyday connection to groceries — keep ${brand.name}'s presence ` +
    'subtle: the required spoken mention above is enough, connected through the story\'s own food, people, ' +
    'community, or access details; do not force the vehicle, the logo, or the app into the visuals just because ' +
    `the brand is being credited in narration. For a subject or hero role — the idea is directly about ${brand.name}, ` +
    'its mission, or its service — stronger, more direct branding is earned and appropriate: the vehicle can be a ' +
    `real visual presence across multiple scenes, and narration can speak about ${brand.name} more directly, still as ` +
    'part of a genuine story, never as a recited pitch. Every added character, object, location, action, or brand ' +
    `element must have a narrative reason for being there, at any role level — never a random ${brand.name} truck, a ` +
    'random food prop, a generic cinematic shot with nothing to do with the story, an unrelated character or ' +
    'location, branding beyond what the role above earns, or a surreal element with no narrative justification. ' +
    `The finished video should make it obvious both why it belongs on ${brand.name}'s own social media and why the ` +
    'user\'s original creative idea is still fully recognizable in it — neither should come at the other\'s expense.'
  )
}

function brandAssetFidelity(brand: BrandProfile): string {
  return (
    `When ${brand.name}'s vehicle, app, or other real assets appear in a scene, describe them only as already true ` +
    'per the brand facts above — never invent a new logo, redesign the vehicle\'s shape or colors, invent a ' +
    `product or service ${brand.name} doesn't actually offer, or add an app feature that isn't real. Use an ` +
    'existing asset because this specific scene\'s idea genuinely calls for it, never merely because it exists.'
  )
}

function finalSelfCheckClause(brand: BrandProfile): string {
  return (
    '\n\nBefore returning your answer, silently verify: is the original creative idea still recognizable in what ' +
    'you wrote? Is there a clear, coherent story rather than a string of unrelated shots? Does every scene serve ' +
    `a purpose? Is ${brand.name}'s presence natural for the role you classified, not forced? Did you avoid drawing ` +
    'the logo or inventing brand assets? Is the story visually and physically logical? Does it land on a ' +
    'memorable, satisfying ending? If not, revise your answer before returning it — only the final JSON is ' +
    'returned, never this checklist.'
  )
}

export function composeVideoScriptSystemPrompt(brand: BrandProfile, opts: VideoScriptSystemPromptOptions): string {
  const preamble = opts.sceneNotes
    ? `Build this video's story and every one of its scenes around the user's own creative idea: ` +
      `"${opts.sceneNotes}". This idea alone decides what the video is about and what happens in it — ` +
      `never blend in or substitute a different topic. ${brand.neutralIdentityLine ?? brand.missionStatement} ` +
      `That is background context for tone and brand accuracy only: a fixed constraint on how the brand's ` +
      `vehicle, app, or other branding must look or sound IF the idea above genuinely calls for them, never a ` +
      `second angle, and never a reason to insert brand or mission messaging into a scene the idea doesn't ` +
      `call for.${opts.creativeBrief ? ` ${creativeBriefContext(opts.creativeBrief)}` : ''} ` +
      `${storyPlanningClause(brand)} ${campaignFit(brand)} ${freshcanRoleAdaptivity(brand)} ${brandAssetFidelity(brand)} ` +
      `Voice: ${brand.voiceGuidelines}${bannedWordsLine(brand)}\n\n`
    : brandContext(brand, opts.category) + statsLine(brand) + '\n\n'

  return (
    preamble +
    `You are a video scriptwriter and shot planner. Produce a short-form marketing video script AND its ` +
    `scene-by-scene shot plan in ONE response. Script type: ${opts.scriptType}.\n\n` +
    'Respond with strictly valid JSON matching this exact shape (the core fields — script, visual_description, ' +
    'duration_seconds, scenes, and each scene\'s scene_number/visual_description/shot_notes/narration_intent/' +
    'target_duration_seconds — are required; the additional planning fields below are optional but strongly ' +
    'encouraged whenever you have a real, specific answer for them — never pad one with a generic placeholder ' +
    'just to fill it in):\n' +
    '{\n' +
    '  "script": string (the full narration/voiceover text, human-readable, in English, for internal review only),\n' +
    '  "visual_description": string (one-paragraph overview of the video\'s overall visual concept),\n' +
    '  "duration_seconds": number (total estimated runtime, summing the scenes below),\n' +
    '  "story": { "hook": string, "arc": string, "resolution": string, "cta": string or null } (a compact ' +
    'summary of your planning above — the same hook/arc/payoff structure, not new content),\n' +
    '  "look": { "time_of_day": string, "lighting": string, "palette": string, "style_direction": string, ' +
    '"camera_language": string } (the visual mood/style for the WHOLE video, deferential to whatever the scene ' +
    'idea itself already implies — this replaces guessing a default mood per image later),\n' +
    '  "cast_bible": [ { "id": string (short, stable, e.g. "mother"), "role": string, "age_range": string, ' +
    '"appearance": string, "wardrobe": string, "distinguishing_details": string } ] (one entry per named or ' +
    'recurring person in the story — locked physical descriptions to reuse VERBATIM in every scene that person ' +
    'appears in, the backbone of keeping them looking the same scene to scene; omit entirely for a video with ' +
    'no recurring named people),\n' +
    '  "locations": [ { "id": string, "description": string, "continuity_details": string } ] (one entry per ' +
    'distinct place the story visits, if it revisits any; omit for a single-location or single-shot video),\n' +
    '  "scenes": [\n' +
    '    {\n' +
    '      "scene_number": number (1-indexed, sequential, no gaps),\n' +
    '      "beat": string (this scene\'s narrative job — e.g. "hook", "build", "turn", "payoff", "close", or ' +
    'another word that fits better),\n' +
    '      "visual_description": string (what the camera shows — the subject\'s own action plus any natural ' +
    'ambient motion already implied by the setting, e.g. steam rising, wind moving leaves or fabric, light ' +
    'shifting — specific enough to generate an image from. Ground it in this scene\'s own story beat and ' +
    'purpose from your planning above: what specifically happens, in what environment, and how it connects to ' +
    'the scene immediately before it — never a generic or purposeless shot),\n' +
    '      "shot_notes": string (real cinematographic direction for this exact shot — angle, camera movement, ' +
    'depth of field, framing, e.g. "low-angle slow tracking shot, shallow depth of field" or "static wide shot, ' +
    'soft window light" — only "" for a scene where a plain static shot is genuinely the deliberate choice, ' +
    'never left empty by default. Choose composition and camera movement that serve THIS scene\'s specific ' +
    'purpose in the story, not decoration for its own sake),\n' +
    '      "narration_intent": string (the SEMANTIC content this scene\'s narration should convey — describe ' +
    'the idea in plain terms, NEVER write it as a finished sentence in any one language, since this gets ' +
    'independently localized into actual EN or FR wording by a later step),\n' +
    '      "target_duration_seconds": number (this scene\'s planned runtime budget),\n' +
    '      "cast_present": string[] (the cast_bible ids of who appears in this scene, if any — [] or omit if ' +
    'the video has no cast_bible),\n' +
    '      "props_present": string[] (visually significant objects this scene establishes or carries forward),\n' +
    `      "unit_presence": "none" | "background" | "featured" (is ${brand.name}'s physical unit the ` +
    'subject of this scene, plausibly present in the background, or absent — an honest per-scene read, never a default),\n' +
    '      "unit_presence_rationale": string (one sentence, honest and specific to this scene, never ' +
    'boilerplate — why you chose that unit_presence value; omit only if unit_presence is "none"),\n' +
    '      "setting": "exterior" | "interior" | "unrelated" (unrelated for a setting that has nothing to do ' +
    'with the unit at all, e.g. a home kitchen),\n' +
    '      "contains_food": boolean (does this scene show food, produce, or packaged groceries),\n' +
    '      "is_final_scene": boolean (true only for the actual last scene),\n' +
    '      "visual_state": { "people": number, "hands": string (who this scene\'s visible hands belong to, ' +
    'e.g. "the woman only" or "none visible" — never a hand with no owner), "objects": string[] (visually ' +
    'significant physical objects in frame, a few words each), "new_entities": string[] (the subset of ' +
    'objects genuinely new in THIS scene) } (keep this extremely compact — a few short words per field, ' +
    'omit a field or leave an array empty rather than pad it)\n' +
    '    }\n' +
    '  ]\n' +
    '}\n' +
    `Produce between 4 and 10 scenes whose target_duration_seconds sum to approximately ${opts.targetDurationSeconds} ` +
    'seconds — that is the target runtime, aim for it. Treat it as a guideline, not a hard cutoff: it is fine ' +
    'for the true total to land a bit short or long of it if that is what a complete, naturally-paced narration ' +
    'actually needs. Never truncate a scene\'s narration_intent, or drop a scene\'s idea early, just to force the ' +
    'total to match exactly.\n\n' +
    'The overall video and every individual scene must read as a genuine story or moment from real life — ' +
    'natural pacing, real stakes or feeling — never scripted ad copy, a corporate promo, or a polished ' +
    'commercial, even though it is being produced for marketing use. Every scene\'s setting must also be ' +
    'physically plausible and safe — an ordinary real-world place the action could actually happen (a ' +
    'sidewalk, porch, kitchen table, park, community space, or similar) — never an implausible or unsafe ' +
    'arrangement like people gathered or eating in the middle of an active road, unless the scene idea ' +
    'itself explicitly calls for that exact setup. Shoot it like a well-made short film, not a slideshow of ' +
    'plain snapshots: vary shot types scene to scene (wide establishing shots, medium shots, close-ups, ' +
    'over-the-shoulder, tracking shots) and give each one deliberate camera direction in shot_notes — this is ' +
    'a production-quality bar every scene should meet, never a directive on what mood or overall style to ' +
    'use, which stays entirely up to the scene idea. If the idea above is brief, expand it creatively into ' +
    'specific, vivid visual detail — concrete actions, objects, and environment — but every detail must still ' +
    'serve that exact idea, never a generic or unrelated addition. Do not invent a prop, vehicle, building, or ' +
    'person that serves no purpose in the story — every significant visual element must have a clear reason ' +
    'to exist; if removing it would not harm the story, do not add it. Maintain natural continuity across ' +
    'scenes that share the same moment, characters, or place — the same people, their clothing, and the ' +
    'setting should carry between consecutive scenes describing that same moment, unless the story moves ' +
    'somewhere new — each scene\'s visual_state should reflect this too: carry forward the previous scene\'s ' +
    'people/objects/location unless the story genuinely moves on, and only list something under ' +
    'new_entities when this scene\'s own action introduces it or it\'s a natural background element, never ' +
    'invented just to make the scene visually interesting. Where your planning above chose a visual motif, let it recur across multiple scenes rather ' +
    'than appearing once and being forgotten — that repetition is what makes the video read as one connected ' +
    'piece rather than a set of unrelated shots. The FINAL scene must land the video on a genuine sense of ' +
    'closure, not cut off mid-action ' +
    "— its action should resolve into a settled, natural concluding beat (a finished gesture, a held look, a " +
    'moment landing) appropriate to the story\'s own scale, never a big staged finale or a jump straight from ' +
    'motion to black.' +
    (opts.sceneNotes
      ? ' Every scene must still serve the creative idea given at the very start of this prompt — never drift ' +
        'into generic brand, mission, or food-desert messaging unless that idea itself genuinely calls for it, ' +
        'and never force the vehicle into a scene it does not genuinely fit. The vehicle appearing in one ' +
        'scene is never a reason to carry it into a later scene — only include it again if that later scene\'s ' +
        'own idea genuinely calls for it too.' +
        finalSelfCheckClause(brand)
      : '')
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
 *
 * 2026-09-21: this is the step that ACTUALLY produces what gets voiced —
 * composeVideoScriptSystemPrompt's CAMPAIGN_FIT clause can require a scene's
 * narration_intent to name Fresh-CAN, but this function only ever received
 * that narration_intent and a generic "never sound like a commercial"
 * instruction with zero awareness of that requirement. Given a
 * narration_intent that explicitly calls for naming the brand, "never
 * sound like ad copy" is exactly the instruction that could make this step
 * quietly paraphrase the name away — a real brand-name mention IS the kind
 * of thing that pattern-matches as "sounds promotional." Added an explicit
 * carve-out below so a deliberate brand mention survives localization
 * instead of being softened out by a rule aimed at a different problem
 * (generic ad-copy phrasing, not a specific required name).
 */
export function composeLocalizeScriptSystemPrompt(brand: BrandProfile, opts: LocalizeScriptSystemPromptOptions): string {
  return (
    `${brand.missionStatement} Voice: ${brand.voiceGuidelines}${bannedWordsLine(brand)}\n\n` +
    `You are localizing a video's narration into ${opts.language}. You will be given a list of scenes, each ` +
    'with a "narration_intent" (the SEMANTIC content that scene\'s narration should convey — not literal ' +
    `wording) and a target_duration_seconds budget. Write the actual narration wording in ${opts.language} for ` +
    'each scene, fitting comfortably within its target duration (roughly 2.5 words per second is a reasonable ' +
    'speaking pace) — a soft constraint, not an exact word count. Write it as natural spoken narration for a ' +
    'real story, never as scripted ad copy or a voiceover that sounds like a commercial. The one exception: if ' +
    `a narration_intent explicitly calls for naming ${brand.name} (or otherwise references the brand by name), the ` +
    `localized ${opts.language} wording MUST include that name literally, spoken naturally — never paraphrase, ` +
    'translate, soften, or drop it for sounding too promotional; that specific mention is a deliberate, ' +
    'required part of the story, not the generic ad-copy pattern this rule exists to avoid elsewhere. Respond ' +
    'with strictly valid JSON: ' +
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
