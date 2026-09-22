// Blog's Inngest orchestration — replaces worker/src/index.ts's blog branch
// in tickPipelines/tickTracks (see docs/IMPLEMENTATION_PLAN.md's Inngest
// migration plan, Phase 2). Calls the SAME step functions the worker used,
// unmodified — this file only re-implements the discovery/retry loop that
// used to come from the worker's 5s poll tick, using step.run + step.sleep
// so no Vercel function stays alive across a wait.
//
// Two events, matching the actual dependency graph (not one event per
// pipeline): content/blog.generate does the shared, once-per-pipeline work
// (outline, then hero+inline visuals) and — once that's ready — sends
// content/blog.track.process for each language track, which does that
// track's copy + finalize_draft.
import type { GetStepTools } from 'inngest'
import { inngest } from '../client'
import {
  createServiceClient,
  hasSucceededStep,
  getLastSucceededStepOutputAnyGeneration,
  getVisualAssets,
  type PipelineRow,
  type TrackRow,
} from '../../server/pipeline/db'
import { runGenerateOutline, type OutlineJobInput } from '../../server/pipeline/steps/blog/generateOutline'
import { runGenerateVisualImage } from '../../server/pipeline/steps/blog/generateVisualImage'
import { runGenerateCopy, type CopyJobInput } from '../../server/pipeline/steps/blog/generateCopy'
import { runFinalizeDraft } from '../../server/pipeline/steps/blog/finalizeDraft'
import { OpenAIScriptGenerator } from '../../server/pipeline/adapters/openai'
import { NanoBananaImageGenerator } from '../../server/pipeline/adapters/nanoBanana'
import { FakeKieImageGenerator } from '../../server/pipeline/adapters/kieFake'
import type { ImageGenerator } from '../../server/pipeline/adapters/types'
import { BRAND_PROFILE, composeHeroPrompt, composeInlinePrompt, type ImageStyle } from '../../server/pipeline/prompts/index'
import { parseAdCopy, deriveHeadline } from '../../server/pipeline/lib/adCopy'
import { env } from '../../server/pipeline/env'

type Step = GetStepTools<typeof inngest>

// Matches worker/src/index.ts's own WORKER_POLL_INTERVAL_MS default — the
// step functions below gate their own real work on isReadyToRetry
// internally, so this is just "how often to check back," not the actual
// backoff delay.
const RETRY_POLL_INTERVAL = '5s'
// Safety net only — each step function's own MAX_ATTEMPTS (lib/backoff.ts)
// is the real bound (openai=3, kie=5), reached in far fewer iterations.
const MAX_RETRY_LOOP_ITERATIONS = 30

const client = createServiceClient()

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

interface BlogJobFields {
  topic: string
  category: string
  target_audience: string
  scene_notes: string | null
  image_style: string | null
}

async function fetchBlogJobFields(jobId: string): Promise<BlogJobFields> {
  const { data, error } = await client
    .from('content_jobs')
    .select('topic, category, target_audience, scene_notes, image_style')
    .eq('id', jobId)
    .single()
  if (error || !data) {
    throw new Error(`Failed to load content_jobs row ${jobId}: ${error?.message ?? 'not found'}`)
  }
  return data as BlogJobFields
}

/**
 * Repeatedly calls runGenerateOutline (exactly as the worker's tick loop
 * did) until the pipeline leaves 'drafting' — either advanced to
 * 'generating' (success) or 'failed' (exhausted generate_outline's own
 * MAX_ATTEMPTS.openai). runGenerateOutline never throws on a provider
 * failure — it records it and returns — so this loop, not Inngest's own
 * step retry, is what re-attempts it.
 */
async function runOutlineUntilSettled(
  step: Step,
  pipelineId: string,
  input: OutlineJobInput,
  scriptGenerator: OpenAIScriptGenerator,
): Promise<PipelineRow> {
  let pipeline = await fetchPipeline(pipelineId)
  for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
    pipeline = await step.run(`generate-outline-${attempt}`, async () => {
      const current = await fetchPipeline(pipelineId)
      await runGenerateOutline(client, current, input, scriptGenerator)
      return fetchPipeline(pipelineId)
    })
    if (pipeline.status !== 'drafting') return pipeline
    await step.sleep(`outline-backoff-${attempt}`, RETRY_POLL_INTERVAL)
  }
  return pipeline
}

/**
 * Same pattern as runOutlineUntilSettled, but for one shared visual asset
 * (hero or inline). Loops until that asset reaches 'ready' or the whole
 * pipeline fails (generateVisualImage.ts fails the pipeline once one asset
 * exhausts MAX_ATTEMPTS.kie). Hero and inline are called sequentially, not
 * concurrently — matching worker/src/index.ts's own tickPipelines body
 * exactly, not a new optimization.
 */
async function runVisualUntilSettled(
  step: Step,
  pipelineId: string,
  assetType: 'hero_image' | 'inline_image',
  prompt: string,
  referenceImageUrl: string | undefined,
  imageGenerator: ImageGenerator,
): Promise<'ready' | 'failed'> {
  for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
    const outcome = await step.run(`generate-${assetType}-${attempt}`, async () => {
      const current = await fetchPipeline(pipelineId)
      await runGenerateVisualImage(client, current, assetType, prompt, imageGenerator, 5000, referenceImageUrl)
      const assets = await getVisualAssets(client, pipelineId, current.current_generation)
      const asset = assets.find((a) => a.asset_type === assetType)
      const freshPipeline = await fetchPipeline(pipelineId)
      return { assetStatus: asset?.status ?? 'pending', pipelineStatus: freshPipeline.status }
    })
    if (outcome.assetStatus === 'ready') return 'ready'
    if (outcome.pipelineStatus === 'failed') return 'failed'
    await step.sleep(`${assetType}-backoff-${attempt}`, RETRY_POLL_INTERVAL)
  }
  return 'failed'
}

export const blogGenerate = inngest.createFunction(
  {
    id: 'blog-generate',
    triggers: [{ event: 'content/blog.generate' }],
    // Belt-and-suspenders alongside claimPipeline's own CAS (db.ts) — see
    // docs/IMPLEMENTATION_PLAN.md's "Concurrency & idempotency" section for
    // why both are kept.
    concurrency: { key: 'event.data.pipelineId', limit: 1 },
  },
  async ({ event, step }) => {
    const { pipelineId, jobId } = event.data as { pipelineId: string; jobId: string }
    const scriptGenerator = new OpenAIScriptGenerator(env.OPENAI_API_KEY)
    // TEMPORARY (matches the old worker's own comment, 2026-09-17/18): forced
    // to nanoBananaGenerator for both hero/inline to cut per-image test cost.
    // Revert to KieImageGenerator for 'photo'-style once testing is done.
    //
    // KIE_FAKE_MODE (test-only, default off — see env.ts/adapters/kieFake.ts):
    // previously video-only; extended here (2026-09-18) so a local smoke
    // test can exercise the full blog/image event chain without spending
    // real KIE credits. Never set in production.
    const nanoBananaGenerator: ImageGenerator = env.KIE_FAKE_MODE
      ? new FakeKieImageGenerator()
      : new NanoBananaImageGenerator(env.KIE_API_KEY)

    let pipeline = await step.run('fetch-pipeline', () => fetchPipeline(pipelineId))

    if (pipeline.status === 'created' || pipeline.status === 'drafting') {
      const job = await step.run('fetch-job-for-outline', () => fetchBlogJobFields(jobId))
      const outlineInput: OutlineJobInput = {
        topic: job.topic,
        category: job.category,
        targetAudience: job.target_audience,
        sceneNotes: job.scene_notes,
      }
      pipeline = await runOutlineUntilSettled(step, pipelineId, outlineInput, scriptGenerator)
    }

    if (pipeline.status === 'failed') {
      return { status: 'failed', stage: 'generate_outline' }
    }

    if (pipeline.status === 'generating') {
      const job = await step.run('fetch-job-for-visuals', () => fetchBlogJobFields(jobId))
      const outlineOutput = await step.run('fetch-outline-output', () =>
        getLastSucceededStepOutputAnyGeneration(client, { contentPipelineId: pipelineId }, 'generate_outline'),
      )
      const { headline, subtitle } = parseAdCopy(outlineOutput, deriveHeadline(job.topic), job.category)
      const blogImageJob = {
        pipelineId,
        topic: job.topic,
        category: job.category,
        imageStyle: (job.image_style === 'infographic' ? 'infographic' : 'photo') as ImageStyle,
        headline,
        subtitle,
        sceneNotes: job.scene_notes,
      }
      const hero = composeHeroPrompt(BRAND_PROFILE, blogImageJob)
      const inline = composeInlinePrompt(BRAND_PROFILE, blogImageJob)

      const heroResult = await runVisualUntilSettled(
        step,
        pipelineId,
        'hero_image',
        hero.prompt,
        hero.referenceImageUrl,
        nanoBananaGenerator,
      )
      if (heroResult === 'ready') {
        await runVisualUntilSettled(
          step,
          pipelineId,
          'inline_image',
          inline.prompt,
          inline.referenceImageUrl,
          nanoBananaGenerator,
        )
      }

      pipeline = await step.run('fetch-pipeline-after-visuals', () => fetchPipeline(pipelineId))
    }

    if (pipeline.status === 'failed') {
      return { status: 'failed', stage: 'generate_visuals' }
    }

    if (pipeline.status === 'ready') {
      const tracks = await step.run('fetch-tracks', () => fetchTracksForPipeline(pipelineId))
      if (tracks.length > 0) {
        await step.sendEvent(
          'send-track-events',
          tracks.map((track) => ({
            name: 'content/blog.track.process' as const,
            id: `${track.id}:blog.track.process`,
            data: { trackId: track.id, pipelineId, jobId },
          })),
        )
      }
    }

    return { status: pipeline.status }
  },
)

export const blogTrackProcess = inngest.createFunction(
  {
    id: 'blog-track-process',
    triggers: [{ event: 'content/blog.track.process' }],
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
    const job = await step.run('fetch-job-for-copy', () => fetchBlogJobFields(jobId))
    const copyInput: CopyJobInput = {
      topic: job.topic,
      category: job.category,
      sceneNotes: job.scene_notes,
    }

    for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
      track = await step.run(`generate-copy-${attempt}`, async () => {
        const current = await fetchTrack(trackId)
        await runGenerateCopy(client, current, pipelineId, pipeline.current_generation, copyInput, scriptGenerator)
        return fetchTrack(trackId)
      })
      const copyDone = await step.run(`check-copy-done-${attempt}`, () =>
        hasSucceededStep(client, { contentLanguageTrackId: trackId }, 'generate_copy', track.master_generation_used),
      )
      if (copyDone || track.status === 'failed') break
      await step.sleep(`copy-backoff-${attempt}`, RETRY_POLL_INTERVAL)
    }

    if (track.status === 'failed') {
      return { status: 'failed', stage: 'generate_copy' }
    }

    await step.run('finalize-draft', async () => {
      const currentTrack = await fetchTrack(trackId)
      const currentPipeline = await fetchPipeline(pipelineId)
      await runFinalizeDraft(client, currentPipeline, currentTrack, jobId)
    })

    track = await step.run('fetch-track-final', () => fetchTrack(trackId))
    return { status: track.status }
  },
)
