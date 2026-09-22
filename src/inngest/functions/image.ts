// image_post's Inngest orchestration — replaces worker/src/index.ts's
// image_post branch in tickPipelines/tickTracks (see
// docs/IMPLEMENTATION_PLAN.md's Inngest migration plan, Phase 3). Calls the
// SAME step functions the worker used, unmodified — see blog.ts's header for
// the general pattern this follows.
//
// Two events: content/image.generate does the shared, once-per-pipeline work
// — 'infographic'-style jobs get a generate_ad_copy pass first (mirrors
// blog's generate_outline), 'photo'-style jobs skip straight to the shared
// photo — then sends content/image.track.process per language track, which
// does that track's caption + finalize.
import type { GetStepTools } from 'inngest'
import { inngest } from '../client'
import {
  createServiceClient,
  hasSucceededStep,
  getLastSucceededStepOutput,
  type PipelineRow,
  type TrackRow,
} from '../../server/pipeline/db'
import { interpretIntent } from '../../server/pipeline/steps/shared/interpretIntent'
import { planImage } from '../../server/pipeline/steps/image/planImage'
import { runGenerateAdCopy, type AdCopyJobInput } from '../../server/pipeline/steps/image/generateAdCopy'
import { runGeneratePhoto } from '../../server/pipeline/steps/image/generatePhoto'
import { runGenerateCaption, type CaptionJobInput } from '../../server/pipeline/steps/image/generateCaption'
import { runFinalizeImageContent } from '../../server/pipeline/steps/image/finalizeImageContent'
import { OpenAIScriptGenerator } from '../../server/pipeline/adapters/openai'
import { NanoBananaImageGenerator } from '../../server/pipeline/adapters/nanoBanana'
import { FakeKieImageGenerator } from '../../server/pipeline/adapters/kieFake'
import type { ImageGenerator } from '../../server/pipeline/adapters/types'
import { SupabasePhotoStorageUploader } from '../../server/pipeline/adapters/storage'
import { BRAND_PROFILE, composePhotoPrompt, type ImageStyle } from '../../server/pipeline/prompts/index'
import { parseAdCopy, deriveHeadline } from '../../server/pipeline/lib/adCopy'
import { env } from '../../server/pipeline/env'

type Step = GetStepTools<typeof inngest>

// Matches worker/src/index.ts's own WORKER_POLL_INTERVAL_MS default — see
// blog.ts's identical constant for why this is just "how often to check
// back," not the real backoff delay (each step function gates its own real
// work internally via isReadyToRetry).
const RETRY_POLL_INTERVAL = '5s'
const MAX_RETRY_LOOP_ITERATIONS = 30

const client = createServiceClient()

interface ImageAnswer {
  question: string
  answer: string
}

async function fetchPipeline(pipelineId: string): Promise<PipelineRow> {
  const { data, error } = await client.from('content_pipelines').select('*').eq('id', pipelineId).single()
  if (error || !data) {
    throw new Error(`Failed to load content_pipelines row ${pipelineId}: ${error?.message ?? 'not found'}`)
  }
  return data as PipelineRow
}

async function fetchTrack(trackId: string): Promise<TrackRow> {
  const { data, error } = await client.from('content_language_tracks').select('*').eq('id', trackId).single()
  if (error || !data) {
    throw new Error(`Failed to load content_language_tracks row ${trackId}: ${error?.message ?? 'not found'}`)
  }
  return data as TrackRow
}

async function fetchTracksForPipeline(pipelineId: string): Promise<TrackRow[]> {
  const { data, error } = await client
    .from('content_language_tracks')
    .select('*')
    .eq('content_pipeline_id', pipelineId)
  if (error) throw new Error(`Failed to load content_language_tracks for pipeline ${pipelineId}: ${error.message}`)
  return (data ?? []) as TrackRow[]
}

interface ImageJobFields {
  topic: string
  category: string
  target_audience: string
  scene_notes: string | null
  image_answers: ImageAnswer[] | null
  image_style: string | null
  content_angle: string | null
}

async function fetchImageJobFields(jobId: string): Promise<ImageJobFields> {
  const { data, error } = await client
    .from('content_jobs')
    .select('topic, category, target_audience, scene_notes, image_answers, image_style, content_angle')
    .eq('id', jobId)
    .single()
  if (error || !data) {
    throw new Error(`Failed to load content_jobs row ${jobId}: ${error?.message ?? 'not found'}`)
  }
  return data as ImageJobFields
}

function resolveImageStyle(raw: string | null): ImageStyle {
  return raw === 'infographic' ? 'infographic' : 'photo'
}

/** scene_notes ("Your Scene Idea") is required going forward (see
 *  src/app/dashboard/new's submit validation) plus any clarifying-question
 *  answers; the topic/category fallback below only fires for a pre-existing
 *  job created before the field became required. */
function photoScene(job: ImageJobFields): string {
  const descriptors: string[] = []
  if (job.scene_notes) descriptors.push(job.scene_notes)
  if (job.image_answers?.length) {
    descriptors.push(...job.image_answers.map((a) => a.answer).filter(Boolean))
  }
  return descriptors.length > 0 ? descriptors.join(', ') : `${job.topic}, in the context of ${job.category}`
}

// adAngleBriefs (per-angle canned creative direction) was removed
// (PROMPT_REFACTOR_BRIEF.md §6.2) — content_angle remains light job
// metadata (still read/stored) but no longer resolves to prompt text here.
// A structured Layer 1/2 interpretation of the angle belongs in a future
// phase, not a static per-angle brief map.
function angleBriefFor(_job: ImageJobFields): string | undefined {
  return undefined
}

/** Same retry-loop pattern as blog.ts's runOutlineUntilSettled — repeatedly
 * calls runGenerateAdCopy until the pipeline leaves 'drafting'. */
async function runAdCopyUntilSettled(
  step: Step,
  pipelineId: string,
  input: AdCopyJobInput,
  scriptGenerator: OpenAIScriptGenerator,
): Promise<PipelineRow> {
  let pipeline = await fetchPipeline(pipelineId)
  for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
    pipeline = await step.run(`generate-ad-copy-${attempt}`, async () => {
      const current = await fetchPipeline(pipelineId)
      await runGenerateAdCopy(client, current, input, scriptGenerator)
      return fetchPipeline(pipelineId)
    })
    if (pipeline.status !== 'drafting') return pipeline
    await step.sleep(`ad-copy-backoff-${attempt}`, RETRY_POLL_INTERVAL)
  }
  return pipeline
}

/**
 * Same retry-loop pattern, for the shared photo. runGeneratePhoto owns its
 * own created -> generating -> ready transitions internally (unlike blog's
 * hero/inline pair, image_post has one shared asset, so there's no separate
 * fan-in to check — the pipeline's own status is enough to know when it's
 * done).
 */
async function runPhotoUntilSettled(
  step: Step,
  pipelineId: string,
  prompt: string,
  referenceImageUrl: string | undefined,
  imageGenerator: ImageGenerator,
  uploader: SupabasePhotoStorageUploader,
): Promise<PipelineRow> {
  let pipeline = await fetchPipeline(pipelineId)
  for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
    pipeline = await step.run(`generate-photo-${attempt}`, async () => {
      const current = await fetchPipeline(pipelineId)
      await runGeneratePhoto(client, current, prompt, imageGenerator, uploader, 5000, referenceImageUrl)
      return fetchPipeline(pipelineId)
    })
    if (pipeline.status !== 'created' && pipeline.status !== 'generating') return pipeline
    await step.sleep(`photo-backoff-${attempt}`, RETRY_POLL_INTERVAL)
  }
  return pipeline
}

export const imageGenerate = inngest.createFunction(
  {
    id: 'image-generate',
    triggers: [{ event: 'content/image.generate' }],
    concurrency: { key: 'event.data.pipelineId', limit: 1 },
  },
  async ({ event, step }) => {
    const { pipelineId, jobId } = event.data as { pipelineId: string; jobId: string }
    const scriptGenerator = new OpenAIScriptGenerator(env.OPENAI_API_KEY)
    // TEMPORARY (matches the old worker's own comment, 2026-09-17/18): forced
    // to nanoBananaGenerator regardless of imageStyle to cut per-image test
    // cost. Revert to KieImageGenerator for 'photo'-style once testing is
    // done.
    //
    // KIE_FAKE_MODE (test-only, default off — see env.ts/adapters/kieFake.ts):
    // previously video-only; extended here (2026-09-18) so a local smoke
    // test can exercise the full blog/image event chain without spending
    // real KIE credits. Never set in production.
    const nanoBananaGenerator: ImageGenerator = env.KIE_FAKE_MODE
      ? new FakeKieImageGenerator()
      : new NanoBananaImageGenerator(env.KIE_API_KEY)
    const uploader = new SupabasePhotoStorageUploader(client)

    let pipeline = await step.run('fetch-pipeline', () => fetchPipeline(pipelineId))
    const job = await step.run('fetch-job', () => fetchImageJobFields(jobId))
    const imageStyle = resolveImageStyle(job.image_style)

    if (pipeline.status === 'created' || pipeline.status === 'drafting') {
      // Layer 1 (PROMPT_REFACTOR_BRIEF.md §4.2) — feeds plan_image below.
      const creativeBrief = await step.run('interpret-intent', () =>
        interpretIntent(
          client,
          { contentPipelineId: pipelineId },
          pipeline.current_generation,
          scriptGenerator,
          BRAND_PROFILE,
          {
            contentType: 'image_post',
            topic: job.topic,
            category: job.category,
            targetAudience: job.target_audience,
            sceneNotes: job.scene_notes,
          },
        ),
      )
      // Layer 2 (PROMPT_REFACTOR_BRIEF.md §4.3) — image_post's first
      // planning step. Generated and logged now; not yet consumed by
      // generate_ad_copy/composePhotoPrompt (Phase 4 wires this in).
      await step.run('plan-image', () =>
        planImage(client, { contentPipelineId: pipelineId }, pipeline.current_generation, scriptGenerator, BRAND_PROFILE, {
          imageStyle,
          scene: photoScene(job),
          creativeBrief,
        }),
      )
    }

    if (imageStyle === 'infographic' && (pipeline.status === 'created' || pipeline.status === 'drafting')) {
      const adCopyInput: AdCopyJobInput = {
        topic: job.topic,
        category: job.category,
        angleBrief: angleBriefFor(job),
        scene: photoScene(job),
      }
      pipeline = await runAdCopyUntilSettled(step, pipelineId, adCopyInput, scriptGenerator)
    }

    if (pipeline.status === 'failed') {
      return { status: 'failed', stage: 'generate_ad_copy' }
    }

    if (pipeline.status === 'created' || pipeline.status === 'generating') {
      let styleInputs: { headline?: string; subtitle?: string } = {}
      if (imageStyle === 'infographic') {
        const adCopyOutput = await step.run('fetch-ad-copy-output', () =>
          getLastSucceededStepOutput(client, { contentPipelineId: pipelineId }, 'generate_ad_copy', pipeline.current_generation),
        )
        const { headline, subtitle } = parseAdCopy(adCopyOutput, deriveHeadline(job.topic), job.category)
        styleInputs = { headline, subtitle }
      }
      const photo = composePhotoPrompt(BRAND_PROFILE, {
        pipelineId,
        topic: job.topic,
        category: job.category,
        scene: photoScene(job),
        regenInstructions: pipeline.regen_instructions,
        imageStyle,
        ...styleInputs,
      })
      pipeline = await runPhotoUntilSettled(
        step,
        pipelineId,
        photo.prompt,
        photo.referenceImageUrl,
        nanoBananaGenerator,
        uploader,
      )
    }

    if (pipeline.status === 'failed') {
      return { status: 'failed', stage: 'generate_photo' }
    }

    if (pipeline.status === 'ready') {
      const tracks = await step.run('fetch-tracks', () => fetchTracksForPipeline(pipelineId))
      if (tracks.length > 0) {
        await step.sendEvent(
          'send-track-events',
          tracks.map((track) => ({
            name: 'content/image.track.process' as const,
            id: `${track.id}:image.track.process`,
            data: { trackId: track.id, pipelineId, jobId },
          })),
        )
      }
    }

    return { status: pipeline.status }
  },
)

export const imageTrackProcess = inngest.createFunction(
  {
    id: 'image-track-process',
    triggers: [{ event: 'content/image.track.process' }],
    concurrency: { key: 'event.data.trackId', limit: 1 },
  },
  async ({ event, step }) => {
    const { trackId, pipelineId, jobId } = event.data as {
      trackId: string
      pipelineId: string
      jobId: string
    }
    const scriptGenerator = new OpenAIScriptGenerator(env.OPENAI_API_KEY)

    let track = await step.run('fetch-track', () => fetchTrack(trackId))
    const pipeline = await step.run('fetch-pipeline', () => fetchPipeline(pipelineId))
    const job = await step.run('fetch-job', () => fetchImageJobFields(jobId))
    const imageStyle = resolveImageStyle(job.image_style)

    const captionInput: CaptionJobInput = {
      topic: job.topic,
      category: job.category,
      angleBrief: angleBriefFor(job),
      scene: photoScene(job),
      imageStyle,
      pipelineGeneration: pipeline.current_generation,
    }

    for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
      track = await step.run(`generate-caption-${attempt}`, async () => {
        const current = await fetchTrack(trackId)
        await runGenerateCaption(client, current, captionInput, scriptGenerator)
        return fetchTrack(trackId)
      })
      const captionDone = await step.run(`check-caption-done-${attempt}`, () =>
        hasSucceededStep(client, { contentLanguageTrackId: trackId }, 'generate_caption', track.master_generation_used),
      )
      if (captionDone || track.status === 'failed') break
      await step.sleep(`caption-backoff-${attempt}`, RETRY_POLL_INTERVAL)
    }

    if (track.status === 'failed') {
      return { status: 'failed', stage: 'generate_caption' }
    }

    await step.run('finalize-image-content', async () => {
      const currentTrack = await fetchTrack(trackId)
      const currentPipeline = await fetchPipeline(pipelineId)
      await runFinalizeImageContent(client, currentPipeline, currentTrack, jobId, {
        topic: job.topic,
        category: job.category,
        imageStyle,
      })
    })

    track = await step.run('fetch-track-final', () => fetchTrack(trackId))
    return { status: track.status }
  },
)
