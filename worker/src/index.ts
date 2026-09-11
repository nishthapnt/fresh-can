// Content worker process entrypoint. Polls content_pipelines/content_language_tracks
// directly by status (no separate queue table — see ARCHITECTURE.MD §7 /
// docs/IMPLEMENTATION_PLAN.md Phase 2) and dispatches to the step handlers
// in src/steps/, per content_type. Each step handler is independently
// idempotent and claim-guarded, so this loop can be simple: fetch
// candidates, attempt each, log and move on if one fails — a bad tick never
// blocks the others.
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createServiceClient,
  getLastSucceededStepOutput,
  getLastSucceededStepOutputAnyGeneration,
  type PipelineRow,
  type TrackRow,
} from './db.js'
import { runGenerateOutline, type OutlineJobInput } from './steps/generateOutline.js'
import { runGenerateVisualImage } from './steps/generateVisualImage.js'
import { runGenerateCopy } from './steps/generateCopy.js'
import { runFinalizeDraft } from './steps/finalizeDraft.js'
import { runGenerateAdCopy } from './steps/generateAdCopy.js'
import { runGeneratePhoto } from './steps/generatePhoto.js'
import { runGenerateCaption } from './steps/generateCaption.js'
import { runFinalizeImageContent } from './steps/finalizeImageContent.js'
import { OpenAIScriptGenerator } from './adapters/openai.js'
import { KieImageGenerator } from './adapters/kie.js'
import { NanoBananaImageGenerator } from './adapters/nanoBanana.js'
import type { ImageGenerator } from './adapters/types.js'
import { SupabasePhotoStorageUploader } from './adapters/storage.js'
import { env } from './env.js'
import { BRAND_PROFILE, composeHeroPrompt, composeInlinePrompt, composePhotoPrompt, type ImageStyle } from './prompts/index.js'
import { parseAdCopy } from './lib/adCopy.js'

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000)
const PIPELINE_CONTENT_TYPES = ['blog', 'image_post'] as const

interface ImageAnswer {
  question: string
  answer: string
}

interface JobInputs {
  topic: string
  keywords: string
  category: string
  targetAudience: string
  // image_post-only context — never set for blog jobs. Persisted by
  // src/app/dashboard/new/page.tsx (supabase/migrations/20260909120000)
  // since this worker has no access to that page's transient form state
  // the way the old n8n webhook payload did.
  province: string | null
  city: string | null
  sceneNotes: string | null
  imageAnswers: ImageAnswer[] | null
  // User-selected per job (supabase/migrations/20260910000000) — 'photo'
  // (default) or 'infographic'. Never an automatic per-category guess.
  imageStyle: ImageStyle
  // User-selected per job (supabase/migrations/20260911000000), one of
  // BRAND_PROFILE.adAngleBriefs' keys, or null for "let AI decide". Resolved
  // to brief text (angleBriefFor below) before use — never spliced in raw.
  contentAngle: string | null
}

async function fetchJobInputs(client: SupabaseClient, jobId: string): Promise<JobInputs> {
  const { data, error } = await client
    .from('content_jobs')
    .select(
      'topic, keywords, category, target_audience, province, city, scene_notes, image_answers, image_style, content_angle',
    )
    .eq('id', jobId)
    .single()
  if (error || !data) {
    throw new Error(`Failed to load content_jobs row ${jobId}: ${error?.message ?? 'not found'}`)
  }
  return {
    topic: data.topic as string,
    keywords: (data.keywords as string | null) ?? '',
    category: data.category as string,
    targetAudience: data.target_audience as string,
    province: (data.province as string | null) ?? null,
    city: (data.city as string | null) ?? null,
    sceneNotes: (data.scene_notes as string | null) ?? null,
    imageAnswers: (data.image_answers as ImageAnswer[] | null) ?? null,
    imageStyle: ((data.image_style as string | null) === 'infographic' ? 'infographic' : 'photo'),
    contentAngle: (data.content_angle as string | null) ?? null,
  }
}

/** Resolves the job's selected content_angle to its brief text — undefined
 *  for "let AI decide" (null) or an angle key the brand file doesn't define
 *  (never a hard error; an unrecognized angle just falls back to no brief,
 *  same as if the user hadn't picked one). */
function angleBriefFor(job: JobInputs): string | undefined {
  if (!job.contentAngle) return undefined
  return BRAND_PROFILE.adAngleBriefs?.[job.contentAngle]
}

/** Picks the right image generator for the job's style — 'infographic'
 *  needs a text-capable model (nano-banana-2), 'photo' keeps using Flux
 *  Kontext exactly as before. */
function imageGeneratorFor(
  style: ImageStyle,
  fluxGenerator: ImageGenerator,
  nanoBananaGenerator: ImageGenerator,
): ImageGenerator {
  return style === 'infographic' ? nanoBananaGenerator : fluxGenerator
}

/** Deterministic, no-LLM-call fallback headline — used only when a real
 *  model-authored one isn't available yet (see parseAdCopy call sites
 *  below): blog's generate_outline output missing the field, or image_post
 *  falling back before generate_ad_copy exists for a 'photo'-style job
 *  (which never calls it, since there's no on-image text to derive). */
function deriveHeadline(topic: string): string {
  return topic.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
}

// Prompt assembly (mood rotation, the fixed brand container description,
// reference-image wiring, the no-text instruction) lives in ./prompts — see
// prompts/core/compose.ts. This file only gathers the job-specific inputs
// those composers need.

function photoScene(job: JobInputs): string {
  const descriptors: string[] = []
  if (job.sceneNotes) descriptors.push(job.sceneNotes)
  if (job.imageAnswers?.length) {
    descriptors.push(...job.imageAnswers.map((a) => a.answer).filter(Boolean))
  }
  return descriptors.length > 0 ? descriptors.join(', ') : `${job.topic}, in the context of ${job.category}`
}

function locationContext(job: JobInputs): string {
  // 'auto' is the province dropdown's "let AI decide" sentinel, not a real
  // place name — new/page.tsx now converts it to null before persisting,
  // but guarding here too means a stale/manually-inserted row can never
  // cause "auto" to be fed to the caption prompt as if it were a location
  // again (confirmed live: this exact thing happened before the fix above).
  if (!job.province || job.province === 'auto') return ''
  return job.city ? `${job.city}, ${job.province}` : job.province
}

async function tickPipelines(
  client: SupabaseClient,
  scriptGenerator: OpenAIScriptGenerator,
  imageGenerator: KieImageGenerator,
  nanoBananaGenerator: NanoBananaImageGenerator,
  uploader: SupabasePhotoStorageUploader,
): Promise<void> {
  const { data: pipelines, error } = await client
    .from('content_pipelines')
    .select('*')
    .in('content_type', PIPELINE_CONTENT_TYPES)
    .in('status', ['created', 'drafting', 'generating'])

  if (error) {
    console.error('[worker] failed to fetch pipelines:', error.message)
    return
  }

  for (const pipeline of (pipelines ?? []) as PipelineRow[]) {
    try {
      const jobInputs = await fetchJobInputs(client, pipeline.job_id)

      if (pipeline.content_type === 'blog') {
        const outlineInput: OutlineJobInput = {
          topic: jobInputs.topic,
          keywords: jobInputs.keywords,
          category: jobInputs.category,
          targetAudience: jobInputs.targetAudience,
        }

        if (pipeline.status === 'created' || pipeline.status === 'drafting') {
          await runGenerateOutline(client, pipeline, outlineInput, scriptGenerator)
        } else if (pipeline.status === 'generating') {
          let styleInputs: { headline?: string; subtitle?: string } = {}
          if (jobInputs.imageStyle === 'infographic') {
            // Free — generate_outline already asked for these and this is
            // a plain read of its already-succeeded, already-idempotent
            // output, not a new OpenAI call on every poll tick.
            //
            // Deliberately "any generation", not pipeline.current_generation:
            // generate_outline only ever succeeds once, at the pipeline's
            // ORIGINAL generation — a visual-only regen
            // (blog/regenerate/route.ts) bumps current_generation without
            // ever re-running outline, so looking this up by the current
            // (bumped) generation would find nothing on every regen after
            // the first and silently fall back to the crude topic-truncation
            // headline below, forever.
            const outlineOutput = await getLastSucceededStepOutputAnyGeneration(
              client,
              { contentPipelineId: pipeline.id },
              'generate_outline',
            )
            const { headline, subtitle } = parseAdCopy(
              outlineOutput,
              deriveHeadline(jobInputs.topic),
              jobInputs.category,
            )
            styleInputs = { headline, subtitle }
          }
          const blogImageJob = {
            pipelineId: pipeline.id,
            topic: jobInputs.topic,
            category: jobInputs.category,
            imageStyle: jobInputs.imageStyle,
            ...styleInputs,
          }
          const generator = imageGeneratorFor(jobInputs.imageStyle, imageGenerator, nanoBananaGenerator)
          const hero = composeHeroPrompt(BRAND_PROFILE, blogImageJob)
          const inline = composeInlinePrompt(BRAND_PROFILE, blogImageJob)
          await runGenerateVisualImage(
            client,
            pipeline,
            'hero_image',
            hero.prompt,
            generator,
            5000,
            hero.referenceImageUrl,
          )
          await runGenerateVisualImage(
            client,
            pipeline,
            'inline_image',
            inline.prompt,
            generator,
            5000,
            inline.referenceImageUrl,
          )
        }
      } else if (pipeline.content_type === 'image_post') {
        // 'infographic'-style jobs get a drafting phase image_post never
        // needed before: generate_ad_copy (shared, idempotent — mirrors
        // blog's generate_outline exactly) produces a real headline/
        // subtitle up front, both so it's better than the old crude
        // topic-truncation fallback AND so generate_caption (per-language)
        // has something durable to read and stay cohesive with. 'photo'
        // style skips this entirely — runGeneratePhoto still owns the
        // created -> generating transition directly, exactly as before.
        if (jobInputs.imageStyle === 'infographic' && (pipeline.status === 'created' || pipeline.status === 'drafting')) {
          await runGenerateAdCopy(
            client,
            pipeline,
            { topic: jobInputs.topic, category: jobInputs.category, angleBrief: angleBriefFor(jobInputs) },
            scriptGenerator,
          )
          continue // next tick re-reads pipeline status fresh — nothing else to do this pass
        }

        let styleInputs: { headline?: string; subtitle?: string } = {}
        if (jobInputs.imageStyle === 'infographic') {
          const adCopyOutput = await getLastSucceededStepOutput(
            client,
            { contentPipelineId: pipeline.id },
            'generate_ad_copy',
            pipeline.current_generation,
          )
          const { headline, subtitle } = parseAdCopy(adCopyOutput, deriveHeadline(jobInputs.topic), jobInputs.category)
          styleInputs = { headline, subtitle }
        }
        const photo = composePhotoPrompt(BRAND_PROFILE, {
          pipelineId: pipeline.id,
          topic: jobInputs.topic,
          category: jobInputs.category,
          scene: photoScene(jobInputs),
          regenInstructions: pipeline.regen_instructions,
          imageStyle: jobInputs.imageStyle,
          ...styleInputs,
        })
        await runGeneratePhoto(
          client,
          pipeline,
          photo.prompt,
          imageGeneratorFor(jobInputs.imageStyle, imageGenerator, nanoBananaGenerator),
          uploader,
          5000,
          photo.referenceImageUrl,
        )
      }
    } catch (err) {
      console.error(`[worker] pipeline ${pipeline.id} tick failed:`, err)
    }
  }
}

async function tickTracks(
  client: SupabaseClient,
  scriptGenerator: OpenAIScriptGenerator,
): Promise<void> {
  const { data: tracks, error } = await client
    .from('content_language_tracks')
    .select('*')
    .in('status', ['waiting_on_shared', 'generating'])

  if (error) {
    console.error('[worker] failed to fetch tracks:', error.message)
    return
  }

  for (const track of (tracks ?? []) as TrackRow[]) {
    try {
      const { data: pipeline, error: pErr } = await client
        .from('content_pipelines')
        .select('*')
        .eq('id', track.content_pipeline_id)
        .single()
      if (pErr || !pipeline) continue
      if (!PIPELINE_CONTENT_TYPES.includes(pipeline.content_type as (typeof PIPELINE_CONTENT_TYPES)[number])) {
        continue
      }

      const jobInputs = await fetchJobInputs(client, pipeline.job_id)

      if (pipeline.content_type === 'blog') {
        await runGenerateCopy(
          client,
          track,
          pipeline.id,
          pipeline.current_generation,
          { topic: jobInputs.topic, category: jobInputs.category },
          scriptGenerator,
        )

        // Re-fetch — generate_copy may have just changed this track's status,
        // and finalize_draft needs the pipeline's current status too.
        const [{ data: freshTrack }, { data: freshPipeline }] = await Promise.all([
          client.from('content_language_tracks').select('*').eq('id', track.id).single(),
          client.from('content_pipelines').select('*').eq('id', pipeline.id).single(),
        ])
        if (freshTrack && freshPipeline) {
          await runFinalizeDraft(client, freshPipeline as PipelineRow, freshTrack as TrackRow, pipeline.job_id)
        }
      } else if (pipeline.content_type === 'image_post') {
        await runGenerateCaption(
          client,
          track,
          {
            topic: jobInputs.topic,
            category: jobInputs.category,
            location: locationContext(jobInputs),
            angleBrief: angleBriefFor(jobInputs),
            imageStyle: jobInputs.imageStyle,
            pipelineGeneration: pipeline.current_generation,
          },
          scriptGenerator,
        )

        const [{ data: freshTrack }, { data: freshPipeline }] = await Promise.all([
          client.from('content_language_tracks').select('*').eq('id', track.id).single(),
          client.from('content_pipelines').select('*').eq('id', pipeline.id).single(),
        ])
        if (freshTrack && freshPipeline) {
          await runFinalizeImageContent(
            client,
            freshPipeline as PipelineRow,
            freshTrack as TrackRow,
            pipeline.job_id,
            { topic: jobInputs.topic, category: jobInputs.category, imageStyle: jobInputs.imageStyle },
          )
        }
      }
    } catch (err) {
      console.error(`[worker] track ${track.id} tick failed:`, err)
    }
  }
}

async function tick(
  client: SupabaseClient,
  scriptGenerator: OpenAIScriptGenerator,
  imageGenerator: KieImageGenerator,
  nanoBananaGenerator: NanoBananaImageGenerator,
  uploader: SupabasePhotoStorageUploader,
): Promise<void> {
  await tickPipelines(client, scriptGenerator, imageGenerator, nanoBananaGenerator, uploader)
  await tickTracks(client, scriptGenerator)
}

async function main(): Promise<void> {
  const client = createServiceClient()
  const scriptGenerator = new OpenAIScriptGenerator(env.OPENAI_API_KEY)
  const imageGenerator = new KieImageGenerator(env.KIE_API_KEY)
  const nanoBananaGenerator = new NanoBananaImageGenerator(env.KIE_API_KEY)
  const uploader = new SupabasePhotoStorageUploader(client)

  let stopping = false
  const stop = () => {
    console.log('[worker] shutdown signal received, stopping after current tick')
    stopping = true
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  console.log(`[worker] started, polling every ${POLL_INTERVAL_MS}ms`)
  while (!stopping) {
    await tick(client, scriptGenerator, imageGenerator, nanoBananaGenerator, uploader)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  console.log('[worker] stopped')
}

main().catch((err) => {
  console.error('[worker] fatal error:', err)
  process.exit(1)
})
