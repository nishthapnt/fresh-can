// Video's Inngest orchestration — replaces worker/src/index.ts's video
// branch in tickPipelines/tickTracks (see docs/IMPLEMENTATION_PLAN.md's
// Inngest migration plan, Phase 5). Calls the SAME step functions the
// worker used, unmodified — see blog.ts's header for the general pattern.
//
// Three events, matching video's actual dependency graph (not the
// generate/track-process split blog/image use, since video has an
// approval gate blog/image don't):
// - content/video.generate: the ONLY step before user approval — produces
//   the script + scene plan, stops at 'draft_ready' (mirrors
//   generateScript.ts's own doc comment).
// - content/video.approve: shared, once-per-pipeline work AFTER approval —
//   character_ref, then per-scene visuals (image + clip), 'approved' ->
//   'ready'/'failed'. Sent by the approve route, not chained from
//   content/video.generate — approval is a manual user action, not
//   automatic.
// - content/video.track.render: per-language-track work — localize_script
//   -> synthesize_voice -> transcribe_audio (none of these wait on shared
//   visuals, exactly like the worker's tickTracks let them run concurrently
//   with tickPipelines) -> then waits for the pipeline's shared visuals to
//   reach 'ready' -> render. Sent by the approve route (and by regenerate)
//   alongside content/video.approve, not chained from it — matching the
//   worker's own "tickPipelines and tickTracks run independently every
//   tick" concurrency, not a false dependency.
//
// One real constraint this file can't hide: runRenderLanguageTrack (see
// that file's own POLL_TIMEOUT_MS/STALE_CLAIM_MS) can legitimately take up
// to ~20 minutes PER PASS (concat, mux, caption) with no interruption point
// in between — unlike the KIE-based steps, it never persists a resumable
// provider_ref before polling, so there's no way to durably checkpoint
// mid-render without modifying that file. It's wrapped in the same
// single-step.run pattern as everything else here for consistency; the
// practical implication is that the Inngest route's maxDuration must be set
// high enough to cover a realistic render (see docs/IMPLEMENTATION_PLAN.md's
// Vercel requirements section) and a pathologically slow render approaching
// that ceiling risks the platform killing the step — Inngest would then
// retry the whole render from scratch, which is expensive but no less safe
// than today's worker doing the exact same thing after a crash mid-render
// (renderLanguageTrack.ts's own STALE_CLAIM_MS already assumes recovery
// looks like "someone restarts it later").
import type { GetStepTools } from 'inngest'
import { inngest } from '../client'
import {
  createServiceClient,
  hasSucceededStep,
  getVisualAssets,
  getVideoScenes,
  getVideoSceneAudioRows,
  type PipelineRow,
  type TrackRow,
} from '../../server/pipeline/db'
import { interpretIntent } from '../../server/pipeline/steps/shared/interpretIntent'
import { runGenerateScript, type VideoScriptJobInput } from '../../server/pipeline/steps/video/generateScript'
import { runGenerateCharacterRef } from '../../server/pipeline/steps/video/generateCharacterRef'
import { runGenerateSceneVisual } from '../../server/pipeline/steps/video/generateSceneVisual'
import { runLocalizeScript } from '../../server/pipeline/steps/video/localizeScript'
import { runSynthesizeVoice } from '../../server/pipeline/steps/video/synthesizeVoice'
import { runTranscribeAudio } from '../../server/pipeline/steps/video/transcribeAudio'
import { runRenderLanguageTrack } from '../../server/pipeline/steps/video/renderLanguageTrack'
import { OpenAIScriptGenerator, OpenAIImageValidator } from '../../server/pipeline/adapters/openai'
import { KieVideoGenerator } from '../../server/pipeline/adapters/kie'
import { NanoBananaImageGenerator } from '../../server/pipeline/adapters/nanoBanana'
import { FakeKieImageGenerator, FakeKieVideoGenerator } from '../../server/pipeline/adapters/kieFake'
import type { ImageGenerator, VideoGenerator } from '../../server/pipeline/adapters/types'
import { SupabaseVideoStorageUploader } from '../../server/pipeline/adapters/storage'
import { ElevenLabsVoiceSynthesizer } from '../../server/pipeline/adapters/elevenlabs'
import { AssemblyAITranscriptionService } from '../../server/pipeline/adapters/assemblyai'
import { UploadPostAVMerger } from '../../server/pipeline/adapters/avMerger'
import { BRAND_PROFILE, composeCharacterRefPrompt, type CreativeBrief } from '../../server/pipeline/prompts/index'
import { env } from '../../server/pipeline/env'

type Step = GetStepTools<typeof inngest>
type AspectRatio = '9:16' | '1:1' | '16:9'

// Matches worker/src/index.ts's own WORKER_POLL_INTERVAL_MS default — see
// blog.ts's identical constant for why this is just "how often to check
// back," not the real backoff delay.
const RETRY_POLL_INTERVAL = '5s'
// Bumped 30 -> 40 (2026-09-19, in step with the render step's own
// backoffBaseDelayMs increase below) — the render retry schedule's
// worst case (20s/40s/60s waits before attempts 2/3/4) needs up to ~140s
// of this loop's own polling just to reach the last attempt, and 30 *
// RETRY_POLL_INTERVAL (150s) left uncomfortably little margin for
// Inngest's own step overhead on top of that. Shared by every retry loop
// in this file, not render-specific — harmless for the others, which
// finish well inside the old ceiling anyway.
const MAX_RETRY_LOOP_ITERATIONS = 40
// The per-track render event waits here for the SEPARATE content/video.approve
// function to finish shared visual generation, which can legitimately take
// many minutes across several scenes — a longer, patient poll, not a tight
// retry loop.
const VISUALS_WAIT_POLL_INTERVAL = '20s'
const MAX_VISUALS_WAIT_ITERATIONS = 120

const client = createServiceClient()

// PERMANENT as of 2026-09-23: character-ref and scene-image generation
// both moved from KieImageGenerator (Flux Kontext) to NanoBananaImageGenerator
// (nano-banana-2), unifying video onto the same image model blog/image_post
// already use permanently — see nanoBanana.ts's own header for the full
// history (infographic-text origin, why it's now the permanent choice
// everywhere, and the aspectRatio bug found and fixed as part of this
// move). Unlike KieImageGenerator's confirmed 3000-char cap
// (limits.ts's PROMPT_LIMITS.sceneImage/characterRef), nano-banana-2 has
// no documented prompt-length limit — the existing budgets are kept as a
// conservative ceiling regardless, not loosened just because the new
// model may not enforce one.
function characterRefGenerator(): ImageGenerator {
  return env.KIE_FAKE_MODE ? new FakeKieImageGenerator() : new NanoBananaImageGenerator(env.KIE_API_KEY)
}
function sceneImageGenerator(): ImageGenerator {
  return env.KIE_FAKE_MODE ? new FakeKieImageGenerator() : new NanoBananaImageGenerator(env.KIE_API_KEY)
}
function sceneVideoGenerator(): VideoGenerator {
  return env.KIE_FAKE_MODE ? new FakeKieVideoGenerator() : new KieVideoGenerator(env.KIE_API_KEY)
}
// Real vision QA gate always, even in KIE_FAKE_MODE — it's a separate
// OpenAI call, not a KIE one, and there is no fake counterpart (same as
// OpenAIScriptGenerator above, which KIE_FAKE_MODE never gates either).
function sceneImageValidator() {
  return new OpenAIImageValidator(env.OPENAI_API_KEY)
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

interface VideoJobFields {
  topic: string
  category: string
  target_audience: string
  script_type: string | null
  language: string | null
  aspect_ratio: AspectRatio | null
  video_duration_seconds: number | null
  voice_id_en: string | null
  voice_id_fr: string | null
  // The dashboard's "Your Scene Idea" field — now the creative brief video's
  // script/scene plan is built around too (see composeVideoScriptSystemPrompt),
  // same as blog's outline/copy and image_post's photo already were.
  scene_notes: string | null
}

async function fetchVideoJobFields(jobId: string): Promise<VideoJobFields> {
  const { data, error } = await client
    .from('content_jobs')
    .select(
      'topic, category, target_audience, script_type, language, aspect_ratio, video_duration_seconds, voice_id_en, voice_id_fr, scene_notes',
    )
    .eq('id', jobId)
    .single()
  if (error || !data) {
    throw new Error(`Failed to load content_jobs row ${jobId}: ${error?.message ?? 'not found'}`)
  }
  return data as VideoJobFields
}

export const videoGenerate = inngest.createFunction(
  {
    id: 'video-generate',
    triggers: [{ event: 'content/video.generate' }],
    concurrency: { key: 'event.data.pipelineId', limit: 1 },
  },
  async ({ event, step }) => {
    const { pipelineId, jobId } = event.data as { pipelineId: string; jobId: string }
    const scriptGenerator = new OpenAIScriptGenerator(env.OPENAI_API_KEY)

    const job = await step.run('fetch-job', () => fetchVideoJobFields(jobId))

    let pipeline = await fetchPipeline(pipelineId)
    let creativeBrief: CreativeBrief | undefined
    if (pipeline.status === 'created' || pipeline.status === 'drafting') {
      // Layer 1 (PROMPT_REFACTOR_BRIEF.md §4.2) — now feeds generate_script
      // below (Phase 3).
      creativeBrief = await step.run('interpret-intent', () =>
        interpretIntent(
          client,
          { contentPipelineId: pipelineId },
          pipeline.current_generation,
          scriptGenerator,
          BRAND_PROFILE,
          {
            contentType: 'video',
            topic: job.topic,
            category: job.category,
            targetAudience: job.target_audience,
            sceneNotes: job.scene_notes,
          },
        ),
      )
    }
    const scriptInput: VideoScriptJobInput = {
      topic: job.topic,
      category: job.category,
      targetAudience: job.target_audience,
      scriptType: job.script_type ?? 'SOLUTION',
      jobLanguage: job.language ?? 'EN',
      durationSeconds: job.video_duration_seconds ?? 36,
      sceneNotes: job.scene_notes,
      creativeBrief,
    }

    for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
      pipeline = await step.run(`generate-script-${attempt}`, async () => {
        const current = await fetchPipeline(pipelineId)
        await runGenerateScript(client, current, scriptInput, scriptGenerator)
        return fetchPipeline(pipelineId)
      })
      if (pipeline.status !== 'created' && pipeline.status !== 'drafting') break
      await step.sleep(`generate-script-backoff-${attempt}`, RETRY_POLL_INTERVAL)
    }

    return { status: pipeline.status }
  },
)

/**
 * Loops runGenerateCharacterRef (which claims 'approved' -> 'generating' but
 * never advances further — see that file's own header) until the character
 * ref asset reaches 'ready' or the pipeline fails.
 */
async function runCharacterRefUntilSettled(
  step: Step,
  pipelineId: string,
  prompt: string,
  referenceImageUrl: string | undefined,
  aspectRatio: AspectRatio | undefined,
): Promise<{ status: 'ready' | 'failed'; characterRefUrl: string | null }> {
  const generator = characterRefGenerator()
  const uploader = new SupabaseVideoStorageUploader(client)

  for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
    const result = await step.run(`character-ref-${attempt}`, async () => {
      const current = await fetchPipeline(pipelineId)
      await runGenerateCharacterRef(client, current, prompt, generator, uploader, 5000, referenceImageUrl, aspectRatio)
      const assets = await getVisualAssets(client, pipelineId, current.current_generation)
      const asset = assets.find((a) => a.asset_type === 'character_ref' && !a.video_scene_id)
      const freshPipeline = await fetchPipeline(pipelineId)
      return {
        assetStatus: asset?.status ?? 'pending',
        pipelineStatus: freshPipeline.status,
        characterRefUrl: asset?.file_url ?? null,
      }
    })
    if (result.assetStatus === 'ready') return { status: 'ready', characterRefUrl: result.characterRefUrl }
    if (result.pipelineStatus === 'failed') return { status: 'failed', characterRefUrl: null }
    await step.sleep(`character-ref-backoff-${attempt}`, RETRY_POLL_INTERVAL)
  }
  return { status: 'failed', characterRefUrl: null }
}

/**
 * Loops runGenerateSceneVisual — each call is one "wave" across every scene
 * (image or clip, whichever each scene needs next), fanned internally via
 * Promise.allSettled (see that file's own header for why that fan-out isn't
 * reimplemented here). A full pipeline needs at least two waves (an image
 * wave, then a clip wave); more if any scene retries.
 */
async function runSceneVisualsUntilSettled(
  step: Step,
  pipelineId: string,
  characterRefUrl: string,
  aspectRatio: AspectRatio | undefined,
): Promise<PipelineRow> {
  const imageGen = sceneImageGenerator()
  const videoGen = sceneVideoGenerator()
  const uploader = new SupabaseVideoStorageUploader(client)
  const scaler = new UploadPostAVMerger(env.UPLOAD_POST_API_KEY)
  const imageValidator = sceneImageValidator()

  let pipeline = await fetchPipeline(pipelineId)
  for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
    pipeline = await step.run(`scene-visuals-wave-${attempt}`, async () => {
      const current = await fetchPipeline(pipelineId)
      await runGenerateSceneVisual(
        client,
        current,
        characterRefUrl,
        imageGen,
        videoGen,
        uploader,
        scaler,
        5000,
        aspectRatio,
        imageValidator,
      )
      return fetchPipeline(pipelineId)
    })
    if (pipeline.status !== 'generating') return pipeline
    await step.sleep(`scene-visuals-backoff-${attempt}`, RETRY_POLL_INTERVAL)
  }
  return pipeline
}

export const videoApprove = inngest.createFunction(
  {
    id: 'video-approve',
    triggers: [{ event: 'content/video.approve' }],
    concurrency: { key: 'event.data.pipelineId', limit: 1 },
  },
  async ({ event, step }) => {
    const { pipelineId, jobId } = event.data as { pipelineId: string; jobId: string }

    const pipeline = await step.run('fetch-pipeline', () => fetchPipeline(pipelineId))
    if (pipeline.status !== 'approved' && pipeline.status !== 'generating') {
      return { status: pipeline.status }
    }

    const job = await step.run('fetch-job', () => fetchVideoJobFields(jobId))
    const aspectRatio = job.aspect_ratio ?? '9:16'
    const characterRefPrompt = composeCharacterRefPrompt(BRAND_PROFILE, { pipelineId })

    const characterRef = await runCharacterRefUntilSettled(
      step,
      pipelineId,
      characterRefPrompt.prompt,
      characterRefPrompt.referenceImageUrl,
      aspectRatio,
    )
    if (characterRef.status === 'failed' || !characterRef.characterRefUrl) {
      return { status: 'failed', stage: 'generate_character_ref' }
    }

    const finalPipeline = await runSceneVisualsUntilSettled(step, pipelineId, characterRef.characterRefUrl, aspectRatio)
    return { status: finalPipeline.status }
  },
)

async function allScenesSynthesized(pipelineId: string, trackId: string, generation: number): Promise<boolean> {
  const scenes = await getVideoScenes(client, pipelineId)
  if (scenes.length === 0) return false
  const audioRows = await getVideoSceneAudioRows(client, trackId, generation)
  return scenes.every((scene) => audioRows.find((a) => a.video_scene_id === scene.id)?.status === 'ready')
}

export const videoTrackRender = inngest.createFunction(
  {
    id: 'video-track-render',
    triggers: [{ event: 'content/video.track.render' }],
    concurrency: { key: 'event.data.trackId', limit: 1 },
    // Added 2026-09-21 — this file's own header ("the Inngest route's
    // maxDuration must be set high enough to cover a realistic render")
    // flagged this as a known risk but nothing ever actually set it,
    // leaving Inngest's own default function-execution ceiling in effect.
    // Confirmed live the same day: a real render's `render-0` step errored
    // out after ~4 minutes (well under renderLanguageTrack.ts's own 20-min
    // POLL_TIMEOUT_MS, so this wasn't that file's own timeout firing) —
    // right around when a real caption-burn pass first started actually
    // completing instead of instantly failing validation (see
    // avMerger.ts's buildCaptionAssFile header for that fix), so total
    // render wall-clock time only just started exceeding whatever this
    // ceiling was. 30m gives real headroom over the 20-min per-poll-loop
    // ceiling render can legitimately take across its several passes.
    timeouts: { finish: '30m' },
  },
  async ({ event, step }) => {
    const { trackId, pipelineId, jobId } = event.data as {
      trackId: string
      pipelineId: string
      jobId: string
    }
    const scriptGenerator = new OpenAIScriptGenerator(env.OPENAI_API_KEY)
    const voiceSynthesizer = new ElevenLabsVoiceSynthesizer(env.ELEVENLABS_API_KEY)
    const transcriptionService = new AssemblyAITranscriptionService(env.ASSEMBLYAI_API_KEY)
    const avMerger = new UploadPostAVMerger(env.UPLOAD_POST_API_KEY)
    const videoUploader = new SupabaseVideoStorageUploader(client)

    let track = await step.run('fetch-track', () => fetchTrack(trackId))
    const job = await step.run('fetch-job', () => fetchVideoJobFields(jobId))
    const voiceIdOverride = track.language === 'FR' ? job.voice_id_fr : job.voice_id_en

    // ── localize_script — no dependency on shared visuals ──────────────
    for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
      track = await step.run(`localize-${attempt}`, async () => {
        const current = await fetchTrack(trackId)
        await runLocalizeScript(client, current, pipelineId, scriptGenerator)
        return fetchTrack(trackId)
      })
      const localizeDone = await step.run(`check-localize-done-${attempt}`, () =>
        hasSucceededStep(client, { contentLanguageTrackId: trackId }, 'localize_script', track.master_generation_used),
      )
      if (localizeDone || track.status === 'failed') break
      await step.sleep(`localize-backoff-${attempt}`, RETRY_POLL_INTERVAL)
    }
    if (track.status === 'failed') return { status: 'failed', stage: 'localize_script' }

    // ── synthesize_voice — fanned per scene inside the step itself ──────
    for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
      const result = await step.run(`synthesize-voice-${attempt}`, async () => {
        const current = await fetchTrack(trackId)
        await runSynthesizeVoice(client, current, pipelineId, jobId, voiceSynthesizer, videoUploader, voiceIdOverride)
        const done = await allScenesSynthesized(pipelineId, trackId, current.master_generation_used)
        const freshTrack = await fetchTrack(trackId)
        return { done, trackStatus: freshTrack.status }
      })
      if (result.done || result.trackStatus === 'failed') break
      await step.sleep(`synthesize-voice-backoff-${attempt}`, RETRY_POLL_INTERVAL)
    }
    track = await step.run('fetch-track-after-synthesize', () => fetchTrack(trackId))
    if (track.status === 'failed') return { status: 'failed', stage: 'synthesize_voice' }

    // ── transcribe_audio — advances the track to 'awaiting_shared' ──────
    for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
      track = await step.run(`transcribe-${attempt}`, async () => {
        const current = await fetchTrack(trackId)
        await runTranscribeAudio(client, current, pipelineId, transcriptionService)
        return fetchTrack(trackId)
      })
      if (track.status === 'awaiting_shared' || track.status === 'failed') break
      await step.sleep(`transcribe-backoff-${attempt}`, RETRY_POLL_INTERVAL)
    }
    if (track.status === 'failed') return { status: 'failed', stage: 'transcribe_audio' }

    // ── wait for the SEPARATE content/video.approve run to finish shared
    // visuals — patient, longer-interval polling since this function does
    // no real work while waiting (see VISUALS_WAIT_POLL_INTERVAL's comment).
    let pipeline = await fetchPipeline(pipelineId)
    for (let attempt = 0; attempt < MAX_VISUALS_WAIT_ITERATIONS; attempt++) {
      pipeline = await step.run(`wait-for-visuals-${attempt}`, () => fetchPipeline(pipelineId))
      if (pipeline.status === 'ready' || pipeline.status === 'failed') break
      await step.sleep(`wait-for-visuals-backoff-${attempt}`, VISUALS_WAIT_POLL_INTERVAL)
    }
    if (pipeline.status !== 'ready') {
      return { status: 'failed', stage: 'awaiting_shared_visuals' }
    }
    if (track.master_generation_used !== pipeline.current_generation) {
      // Stale generation (ARCHITECTURE.MD §10.1's fencing) — a regenerate
      // should have already reset this track to 'waiting_on_shared' at the
      // new generation and sent a fresh event; this run is superseded.
      return { status: 'skipped', reason: 'stale generation' }
    }

    // ── render — see this file's header for the maxDuration caveat ─────
    // backoffBaseDelayMs bumped 5000 -> 20000ms (2026-09-19, in step with
    // backoff.ts's MAX_ATTEMPTS.upload_post 3 -> 4) after a real 429
    // rate-limit failure exhausted every retry in ~21s total — nowhere
    // near upload-post.com's own documented 60s cooldown. See backoff.ts's
    // own comment on upload_post for the full schedule this produces.
    for (let attempt = 0; attempt < MAX_RETRY_LOOP_ITERATIONS; attempt++) {
      track = await step.run(`render-${attempt}`, async () => {
        const currentTrack = await fetchTrack(trackId)
        const currentPipeline = await fetchPipeline(pipelineId)
        await runRenderLanguageTrack(client, currentTrack, currentPipeline, avMerger, videoUploader, 20000, job.aspect_ratio ?? '9:16')
        return fetchTrack(trackId)
      })
      if (track.status === 'ready' || track.status === 'failed') break
      await step.sleep(`render-backoff-${attempt}`, RETRY_POLL_INTERVAL)
    }

    return { status: track.status }
  },
)
