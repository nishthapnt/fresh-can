import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImageGenerator, VideoGenerator, SceneClipScaler, ImageValidator } from '../../adapters/types'
import { ProviderCallError } from '../../adapters/types'
import type { VideoStorageUploader } from '../../adapters/storage'
import {
  claimPipeline,
  hasSucceededStep,
  recordStepAttempt,
  markPipelineFailed,
  upsertVisualAsset,
  getVisualAssets,
  getVideoScenes,
  isPipelineFailed,
  getLastFailedStepErrorMessage,
  type PipelineRow,
  type VideoSceneRow,
  type VisualAssetRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'
import { ASPECT_RATIO_RESOLUTIONS } from '../../lib/videoResolution'
import { pickClipDurationSeconds } from '../../lib/sceneClipDuration'
import { BRAND_PROFILE, composeSceneImagePrompt, composeSceneVideoPrompt } from '../../prompts/index'
import { extractVisualState, extractSceneLayer2Fields } from './generateScript'

const IMAGE_POLL_INTERVAL_MS = 2000
const IMAGE_POLL_TIMEOUT_MS = 60_000
// Kling clips take meaningfully longer than a still image to generate.
// Raised from 180_000 (2026-09-14): a real 9-scene run had 3 of 9 scenes
// (1, 4, 7) time out on their first poll window at 180s, and scene 7 timed
// out on all 5 retry attempts in a row, exhausting MAX_ATTEMPTS.kie and
// hard-failing the whole shared-visuals phase — burning ~50 minutes and 5
// KIE.ai video-generation charges on one scene with nothing to show for it.
// 360s gives real in-flight generations more room to finish before the
// worker gives up and pays for a fresh attempt.
const VIDEO_POLL_INTERVAL_MS = 5000
const VIDEO_POLL_TIMEOUT_MS = 360_000
// A per-scene downscale pass (via upload-post.com's FFmpeg Editor API, same
// provider as the render step) used to run here before each clip is
// stored. A previous version of this existed, was removed, then
// reintroduced (2026-09-13) — the removal was based on a wrong diagnosis:
// every attempt was actually crashing INSTANTLY on a full_command shape
// mismatch ({input0} instead of the bare {input} a single-file command
// needs — see avMerger.ts's buildScaleCommand), and a separate bug in this
// adapter's poll() (checking for the wrong-case status strings) meant we
// never saw that crash — every attempt just looked like a ~5-8min timeout
// instead. Both bugs are fixed now. Reintroduced because un-downscaled
// clips are a real problem on their own: a real 8-scene 9:16 render's raw
// clips (native resolution, no bitrate cap) summed to 140.6MB and failed
// to re-upload past Supabase Storage's project-wide size limit when the
// render step tried to re-host its own concat output. Downscaling each
// clip to its aspect ratio's standard delivery resolution before it's ever
// stored keeps the eventual concatenated file well within that limit,
// without a perceptible quality loss (nothing downstream displays more
// than that resolution anyway).
const SCALE_POLL_INTERVAL_MS = 5000
// Real evidence (2026-09-13) that a single-file re-encode via this same
// provider completes in under a second (buildVideoConcatCommand's own
// 2-scene concat took 0.73-0.77s) — a single clip's downscale should be at
// least as fast. Generous margin over that anyway, rather than a tight
// timeout, since we don't yet have a real timing sample for a full-length
// (~10s) clip specifically.
const SCALE_POLL_TIMEOUT_MS = 3 * 60_000

/** A poll() call throwing (connection reset, "fetch failed", etc.) means the
 *  STATUS CHECK failed, not the generation itself — the KIE job submitted
 *  earlier is still running server-side. Swallowing it and retrying the same
 *  poll, rather than letting it propagate as a step failure, avoids
 *  discarding a perfectly good in-flight job and paying for a brand-new
 *  generation on retry — confirmed live (2026-09-14): concurrent scene
 *  submissions produced bursts of transient "fetch failed" poll errors
 *  (also seen hitting plain Supabase calls the same session, so this looks
 *  like local network/egress flakiness under concurrent connections, not a
 *  KIE-side rejection) that were previously restarting whole scenes from
 *  scratch for no reason. `result.status === 'failed'` (an explicit KIE
 *  failure response) and the deadline-based timeout below are untouched —
 *  only "the poll request itself didn't complete" now retries in place.
 *
 *  A 404/"not found" response is the one exception: that means the provider
 *  itself has no record of this task (genuinely expired/purged), not a
 *  transient network hiccup, so retrying the same poll forever would just
 *  burn the full timeout window for nothing. Treated as an immediate,
 *  definite failure instead — this is what lets a RESUMED task (see
 *  runSceneImageStep/runSceneVideoClipStep below) correctly fall through to
 *  a fresh, legitimate resubmission rather than hanging until timeout.
 *
 *  `isCancelled` (added 2026-09-22, P0 fix): checked at the TOP of every
 *  loop iteration, before the next provider poll — see isPipelineFailed's
 *  own header (db.ts) for why a poll loop needs to notice cancellation
 *  itself rather than only being stopped BETWEEN steps. KIE.ai and
 *  upload-post.com have no documented cancel/stop endpoint for an
 *  already-submitted task (confirmed against both providers' docs the same
 *  day), so this can't make the PROVIDER stop the work already in flight —
 *  what it CAN do, and what actually matters here, is stop OUR side from
 *  continuing to wait on it and, critically, from ever proceeding to the
 *  next expensive step once cancellation is noticed (see the `cancelled`
 *  outcome's handling in runSceneImageStep/runSceneVideoClipStep below). */
async function pollUntilDone<
  TResult extends { status: 'ready' } | { status: 'pending' } | { status: 'failed'; detail: string },
>(
  poll: () => Promise<TResult>,
  timeoutMs: number,
  intervalMs: number,
  logLabel: string,
  isCancelled: () => Promise<boolean>,
): Promise<Extract<TResult, { status: 'ready' }> | { failed: true; detail: string } | { timedOut: true } | { cancelled: true }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isCancelled()) {
      console.log(`[${logLabel}] cancelled — stopping poll early, task left resumable`)
      return { cancelled: true }
    }
    let result: TResult
    try {
      result = await poll()
    } catch (err) {
      if (err instanceof ProviderCallError && err.httpStatus === 404) {
        console.warn(`[${logLabel}] provider reports task not found (404) — treating as genuinely failed, not transient`)
        return { failed: true, detail: err.detail }
      }
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[${logLabel}] transient poll error, retrying same job: ${message}`)
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      continue
    }
    if (result.status === 'ready') return result as Extract<TResult, { status: 'ready' }>
    if (result.status === 'failed') return { failed: true, detail: result.detail }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { timedOut: true }
}

async function pollImageUntilDone(
  client: SupabaseClient,
  pipelineId: string,
  imageGenerator: ImageGenerator,
  jobRef: { providerRef: string },
): Promise<{ fileUrl: string } | { failed: true; detail: string } | { timedOut: true } | { cancelled: true }> {
  return pollUntilDone(
    () => imageGenerator.poll(jobRef),
    IMAGE_POLL_TIMEOUT_MS,
    IMAGE_POLL_INTERVAL_MS,
    'generate_scene_visual:image',
    () => isPipelineFailed(client, pipelineId),
  )
}

async function pollVideoUntilDone(
  client: SupabaseClient,
  pipelineId: string,
  videoGenerator: VideoGenerator,
  jobRef: { providerRef: string },
): Promise<{ fileUrl: string } | { failed: true; detail: string } | { timedOut: true } | { cancelled: true }> {
  return pollUntilDone(
    () => videoGenerator.poll(jobRef),
    VIDEO_POLL_TIMEOUT_MS,
    VIDEO_POLL_INTERVAL_MS,
    'generate_scene_visual:clip',
    () => isPipelineFailed(client, pipelineId),
  )
}

async function pollScaleUntilDone(
  client: SupabaseClient,
  pipelineId: string,
  scaler: SceneClipScaler,
  jobRef: { providerRef: string },
): Promise<{ fileBuffer: Buffer } | { failed: true; detail: string } | { timedOut: true } | { cancelled: true }> {
  return pollUntilDone(
    () => scaler.poll(jobRef),
    SCALE_POLL_TIMEOUT_MS,
    SCALE_POLL_INTERVAL_MS,
    'generate_scene_visual:scale',
    () => isPipelineFailed(client, pipelineId),
  )
}

function findAsset(
  assets: VisualAssetRow[],
  sceneId: string,
  assetType: 'scene_image' | 'scene_video_clip',
): VisualAssetRow | undefined {
  return assets.find((a) => a.video_scene_id === sceneId && a.asset_type === assetType)
}

// Marks a failed_retryable step attempt's error_message as carrying a
// validation correction rather than a genuine provider error — read back by
// runSceneImageStep's next attempt (via getLastFailedStepErrorMessage) to
// build that attempt's regenInstructions. See this file's own header for
// why this rides the EXISTING error_message column instead of a new one.
const VALIDATION_RETRY_PREFIX = 'VALIDATION_RETRY:'

/** Turns the validator's issue list into a short, targeted correction
 *  instruction — never a full re-plan of the scene (request #6: "do NOT
 *  regenerate the entire creative concept from scratch"). Reuses
 *  composeSceneImagePrompt's existing regenInstructions channel, so this is
 *  the ONLY new prompt content a validation-triggered retry adds. */
function buildCorrectionInstruction(issues: string[]): string {
  return (
    `Fix this specific issue: ${issues.join('; ')}. Preserve everything else — the established people, ` +
    'objects, composition, and lighting — exactly as already generated.'
  )
}

async function runSceneImageStep(
  client: SupabaseClient,
  pipeline: PipelineRow,
  scene: VideoSceneRow,
  characterRefUrl: string,
  imageGenerator: ImageGenerator,
  uploader: VideoStorageUploader,
  backoffBaseDelayMs: number,
  aspectRatio?: '9:16' | '1:1' | '16:9',
  /** The immediately preceding scene (by scene_number), if any — its
   *  visual_state is spliced into this scene's image prompt as compact
   *  continuity context (composeSceneImagePrompt's previousVisualState).
   *  Undefined for scene 1, or when the caller has no scene list handy. */
  previousScene?: VideoSceneRow,
  /** Optional vision-based QA gate (see ImageValidator's own header,
   *  adapters/types.ts) — omitted entirely by every existing caller/test,
   *  which just skips this quality gate, same as before it existed. */
  imageValidator?: ImageValidator,
): Promise<boolean> {
  const generation = pipeline.current_generation
  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentPipelineId: pipeline.id },
    `generate_scene_visual:image:${scene.scene_number}`,
    generation,
  )
  if (alreadySucceeded) return false

  const assets = await getVisualAssets(client, pipeline.id, generation)
  const existing = findAsset(assets, scene.id, 'scene_image')
  if (existing?.status === 'ready') return false

  const stepName = `generate_scene_visual:image:${scene.scene_number}`

  let attemptNumber = 1
  let jobRef: { providerRef: string } | undefined

  if (existing?.status === 'generating' && existing.provider_ref) {
    // submit() already succeeded and was already billed for this attempt —
    // the worker just never got to observe the result (most commonly:
    // killed/restarted mid-poll by tsx watch or a deploy). Resuming this
    // EXACT task instead of submitting a new one is what makes this step
    // safe to interrupt: an interruption can never turn one paid generation
    // into two. Never gated by backoff below — backoff paces NEW attempts
    // after a CONFIRMED failure, not checking on work already in flight.
    attemptNumber = existing.attempt_number
    jobRef = { providerRef: existing.provider_ref }
    console.log(`[${stepName}] RESUMED existing task ${jobRef.providerRef} (attempt ${attemptNumber}) — no new submission`)
  } else if (existing && (existing.status === 'failed' || existing.status === 'generating')) {
    // status === 'generating' with no provider_ref here means the process
    // died before submit() even returned — nothing was ever billed, so
    // there is genuinely nothing to resume.
    const ready = isReadyToRetry({
      lastError: 'previous attempt did not succeed',
      retryCount: existing.attempt_number,
      updatedAt: new Date(existing.updated_at),
      baseDelayMs: backoffBaseDelayMs,
    })
    if (!ready) return false
    attemptNumber = existing.attempt_number + 1
    console.log(`[${stepName}] RETRY — attempt ${existing.attempt_number} left no resumable task, submitting fresh (attempt ${attemptNumber})`)
  }

  try {
    if (!jobRef) {
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'scene_image',
        videoSceneId: scene.id,
        status: 'generating',
        attemptNumber,
      })

      // Targeted regeneration (request #6): if the PREVIOUS attempt at this
      // exact scene image failed because the validator rejected it (never a
      // genuine provider failure — those don't carry this prefix), recover
      // its correction instruction and feed it in as regenInstructions —
      // the same channel a user's own Regenerate-dialog guidance already
      // uses. Never a re-plan of the scene, just one targeted fix on top of
      // it.
      let regenInstructions = pipeline.regen_instructions
      if (existing?.status === 'failed') {
        const lastError = await getLastFailedStepErrorMessage(
          client,
          { contentPipelineId: pipeline.id },
          stepName,
          generation,
        )
        if (lastError?.startsWith(VALIDATION_RETRY_PREFIX)) {
          const correction = lastError.slice(VALIDATION_RETRY_PREFIX.length)
          regenInstructions = [pipeline.regen_instructions, correction].filter(Boolean).join(' ')
        }
      }

      // referenceImageUrl comes from the composition itself, not
      // characterRefUrl directly — composeSceneImagePrompt gates whether
      // the unit's reference photo is used at all on this scene's own
      // unit_presence (Layer 2 plan field, PROMPT_REFACTOR_BRIEF.md §4.3/
      // §8 — replaces the old isVideoSceneAboutUnit keyword-regex gate), so
      // a 'none' scene returns undefined here and gets a pure text-to-image
      // generation instead of forcing the unit in as an edit source.
      const layer2 = extractSceneLayer2Fields(scene.narration_intent)
      const { prompt, referenceImageUrl } = composeSceneImagePrompt(BRAND_PROFILE, {
        pipelineId: pipeline.id,
        sceneNumber: scene.scene_number,
        visualDescription: scene.visual_description,
        shotNotes: scene.shot_notes,
        characterRefUrl,
        regenInstructions,
        previousVisualState: previousScene ? extractVisualState(previousScene.narration_intent) : undefined,
        unitPresence: layer2.unit_presence,
        containsFood: layer2.contains_food,
      })

      console.log(`[${stepName}] NEW SUBMISSION (attempt ${attemptNumber})`)
      jobRef = await imageGenerator.submit({ prompt, referenceImageUrl, aspectRatio })

      // Persist the task id BEFORE polling — this is the fix. Previously
      // this row only ever recorded providerRef on the FINAL, successful
      // upsert below, so an interruption anywhere during the poll below
      // lost the task id forever, making a resume (above) impossible and
      // forcing every retry into a brand-new paid submission (confirmed
      // live 2026-09-17: a worker restarted by tsx watch on every save to
      // index.ts orphaned in-flight Hailuo clip requests this exact way,
      // burning ~300+ duplicate credits across 6 scenes in one test).
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'scene_image',
        videoSceneId: scene.id,
        status: 'generating',
        providerRef: jobRef.providerRef,
        attemptNumber,
      })
    }

    const outcome = await pollImageUntilDone(client, pipeline.id, imageGenerator, jobRef)

    if ('cancelled' in outcome) {
      // Leave the asset exactly as-is (status 'generating', provider_ref
      // set) — the same resumable shape a mid-poll crash already leaves
      // (see the RESUMED branch above): no failure is recorded, so a
      // future retry/regenerate picks up this EXACT KIE task instead of
      // paying for a new one, and nothing here starts the next expensive
      // step (the video-clip generation this image would have fed).
      console.log(`[${stepName}] cancelled mid-poll — leaving task ${jobRef.providerRef} resumable, not recording a failure`)
      return true
    }

    if ('fileUrl' in outcome) {
      const permanentUrl = await uploader.uploadFromUrl(
        `${pipeline.job_id}/scene-${scene.scene_number}-image.png`,
        outcome.fileUrl,
      )

      // Lightweight vision QA gate (request #5), run once per scene image,
      // BEFORE this scene's video clip is ever submitted — runGenerateSceneVisual's
      // own gating (an image asset must already be 'ready' before
      // runSceneVideoClipStep is even called) is what actually enforces
      // "before video generation" here; this function just has to avoid
      // marking the asset 'ready' until validation says so.
      let validation: { pass: boolean; issues: string[] } = { pass: true, issues: [] }
      if (imageValidator) {
        try {
          validation = await imageValidator.validate({
            imageUrl: permanentUrl,
            visualDescription: scene.visual_description,
            shotNotes: scene.shot_notes,
          })
        } catch (err) {
          // Fail OPEN — see OpenAIImageValidator's own header (adapters/
          // openai.ts): a validator outage must never block an otherwise-
          // successful, already-paid-for image from proceeding.
          const message = err instanceof Error ? err.message : String(err)
          console.warn(`[${stepName}] image validation call failed, proceeding without it: ${message}`)
        }
      }

      if (!validation.pass && !hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.kie)) {
        // Targeted regeneration (request #6) — reject this image and let
        // the EXISTING retry/backoff machinery pick it up next wave, same
        // as a genuine provider failure. The correction instruction that
        // drives the next attempt's prompt is recovered from this exact
        // error_message on that next call (see the regenInstructions block
        // above) — never a new DB column.
        console.log(`[${stepName}] image validation FAILED (attempt ${attemptNumber}): ${validation.issues.join('; ')}`)
        await upsertVisualAsset(client, {
          contentPipelineId: pipeline.id,
          generation,
          assetType: 'scene_image',
          videoSceneId: scene.id,
          status: 'failed',
          attemptNumber,
        })
        await recordStepAttempt(client, {
          contentPipelineId: pipeline.id,
          stepName,
          generation,
          attemptNumber,
          status: 'failed_retryable',
          provider: 'openai',
          errorMessage: `${VALIDATION_RETRY_PREFIX}${buildCorrectionInstruction(validation.issues)}`,
        })
        return true
      }

      // Either validation passed, or a validation-driven correction
      // genuinely ran out of its retry budget — accepted as-is rather than
      // hard-failing the whole scene over a soft quality gate; a subjective
      // vision-model disagreement should never be able to block delivery
      // the way a real provider failure does.
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'scene_image',
        videoSceneId: scene.id,
        status: 'ready',
        providerRef: jobRef.providerRef,
        fileUrl: permanentUrl,
        attemptNumber,
      })
      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName,
        generation,
        attemptNumber,
        status: 'succeeded',
        provider: 'kie',
        outputSnapshot: { fileUrl: permanentUrl, validationIssues: validation.issues },
      })
    } else {
      const detail = 'failed' in outcome ? outcome.detail : 'KIE.ai poll timed out'
      throw new ProviderCallError('kie', null, detail)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // No providerRef passed here — this attempt's task (whether just
    // submitted or resumed above) is now CONFIRMED done-for (explicit
    // failure, 404, or timeout), so upsertVisualAsset defaults provider_ref
    // back to null. That's deliberate: the next attempt (if any) legitimately
    // needs a fresh, paid submission — there is nothing left to resume.
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation,
      assetType: 'scene_image',
      videoSceneId: scene.id,
      status: 'failed',
      attemptNumber,
    })
    await recordStepAttempt(client, {
      contentPipelineId: pipeline.id,
      stepName,
      generation,
      attemptNumber,
      status: 'failed_retryable',
      provider: 'kie',
      errorMessage: message,
    })
    if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.kie)) {
      await markPipelineFailed(client, pipeline.id, `scene ${scene.scene_number} image: ${message}`)
    }
  }
  return true
}

async function runSceneVideoClipStep(
  client: SupabaseClient,
  pipeline: PipelineRow,
  scene: VideoSceneRow,
  sceneImageUrl: string,
  videoGenerator: VideoGenerator,
  uploader: VideoStorageUploader,
  backoffBaseDelayMs: number,
  scaler: SceneClipScaler,
  isFinalScene: boolean,
  aspectRatio: '9:16' | '1:1' | '16:9' = '9:16',
): Promise<boolean> {
  const generation = pipeline.current_generation
  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentPipelineId: pipeline.id },
    `generate_scene_visual:clip:${scene.scene_number}`,
    generation,
  )
  if (alreadySucceeded) return false

  const assets = await getVisualAssets(client, pipeline.id, generation)
  const existing = findAsset(assets, scene.id, 'scene_video_clip')
  if (existing?.status === 'ready') return false

  const stepName = `generate_scene_visual:clip:${scene.scene_number}`

  let attemptNumber = 1
  let jobRef: { providerRef: string } | undefined
  // Set the moment KIE.ai's video generation succeeds (see the 'fileUrl' in
  // outcome branch below), or resumed here from a previous attempt's row —
  // see raw_file_url's own doc comment (db.ts's VisualAssetRow) for the
  // real incident this fixes: a downscale failure used to discard this
  // already-paid-for KIE output entirely, forcing every retry to resubmit
  // to KIE just to redo the (free, KIE-independent) downscale step.
  // Confirmed live 2026-09-19: a real 6-scene job burned 18 KIE charges
  // this way (3 attempts x 6 scenes, every single one failing on the exact
  // same "downscale poll timed out") before being cancelled.
  let rawUrl: string | undefined

  if (existing?.raw_file_url) {
    // KIE already succeeded and was already billed on a previous attempt —
    // only the downscale step failed. Retry that alone; never resubmit to
    // KIE for this scene again in this generation. Same backoff gate as the
    // ordinary retry branch below, just keyed off this row instead.
    const ready = isReadyToRetry({
      lastError: 'previous downscale attempt did not succeed',
      retryCount: existing.attempt_number,
      updatedAt: new Date(existing.updated_at),
      baseDelayMs: backoffBaseDelayMs,
    })
    if (!ready) return false
    attemptNumber = existing.attempt_number + 1
    rawUrl = existing.raw_file_url
    console.log(`[${stepName}] RESUMED FROM RAW KIE CLIP (attempt ${attemptNumber}) — retrying downscale only, no new KIE charge`)
  } else if (existing?.status === 'generating' && existing.provider_ref) {
    // submit() already succeeded and was already billed for this attempt —
    // the worker just never got to observe the result (most commonly:
    // killed/restarted mid-poll by tsx watch or a deploy). Resuming this
    // EXACT task instead of submitting a new one is what makes this step
    // safe to interrupt: an interruption can never turn one paid generation
    // into two. Never gated by backoff below — backoff paces NEW attempts
    // after a CONFIRMED failure, not checking on work already in flight.
    attemptNumber = existing.attempt_number
    jobRef = { providerRef: existing.provider_ref }
    console.log(`[${stepName}] RESUMED existing task ${jobRef.providerRef} (attempt ${attemptNumber}) — no new submission`)
  } else if (existing && (existing.status === 'failed' || existing.status === 'generating')) {
    // status === 'generating' with no provider_ref here means the process
    // died before submit() even returned — nothing was ever billed, so
    // there is genuinely nothing to resume.
    const ready = isReadyToRetry({
      lastError: 'previous attempt did not succeed',
      retryCount: existing.attempt_number,
      updatedAt: new Date(existing.updated_at),
      baseDelayMs: backoffBaseDelayMs,
    })
    if (!ready) return false
    attemptNumber = existing.attempt_number + 1
    console.log(`[${stepName}] RETRY — attempt ${existing.attempt_number} left no resumable task, submitting fresh (attempt ${attemptNumber})`)
  }

  try {
    if (!rawUrl) {
      if (!jobRef) {
        await upsertVisualAsset(client, {
          contentPipelineId: pipeline.id,
          generation,
          assetType: 'scene_video_clip',
          videoSceneId: scene.id,
          status: 'generating',
          attemptNumber,
        })

        const prompt = composeSceneVideoPrompt({
          visualDescription: scene.visual_description,
          shotNotes: scene.shot_notes,
          isFinalScene,
        })

        console.log(`[${stepName}] NEW SUBMISSION (attempt ${attemptNumber})`)
        jobRef = await videoGenerator.submit({
          prompt,
          referenceImageUrl: sceneImageUrl,
          durationSeconds: pickClipDurationSeconds(scene.target_duration_ms),
          aspectRatio,
        })

        // Persist the task id BEFORE polling — this is the fix. Previously
        // this row only ever recorded providerRef on the FINAL, successful
        // upsert below, so an interruption anywhere during the poll below
        // lost the task id forever, making a resume (above) impossible and
        // forcing every retry into a brand-new paid submission (confirmed
        // live 2026-09-17: a worker restarted by tsx watch on every save to
        // index.ts orphaned in-flight Hailuo clip requests this exact way,
        // burning ~300+ duplicate credits across 6 scenes in one test).
        await upsertVisualAsset(client, {
          contentPipelineId: pipeline.id,
          generation,
          assetType: 'scene_video_clip',
          videoSceneId: scene.id,
          status: 'generating',
          providerRef: jobRef.providerRef,
          attemptNumber,
        })
      }

      const outcome = await pollVideoUntilDone(client, pipeline.id, videoGenerator, jobRef)
      if ('cancelled' in outcome) {
        // Same resumable-no-failure treatment as the image step above —
        // critically, this also means the downscale pass just below never
        // starts, since we return before ever reaching it.
        console.log(`[${stepName}] cancelled mid-poll — leaving task ${jobRef.providerRef} resumable, not recording a failure`)
        return true
      }
      if (!('fileUrl' in outcome)) {
        const detail = 'failed' in outcome ? outcome.detail : 'KIE.ai poll timed out'
        throw new ProviderCallError('kie', null, detail)
      }

      rawUrl = outcome.fileUrl
      // THE FIX: persist the raw KIE clip URL now, before the downscale
      // pass runs. If downscale fails below, the catch block keeps this
      // value (see rawFileUrl there) instead of discarding it, so the next
      // attempt resumes straight into the raw_file_url branch above rather
      // than paying for another KIE video generation.
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'scene_video_clip',
        videoSceneId: scene.id,
        status: 'generating',
        providerRef: jobRef.providerRef,
        rawFileUrl: rawUrl,
        attemptNumber,
      })
    }

    const target = ASPECT_RATIO_RESOLUTIONS[aspectRatio]
    const scaleJobRef = await scaler.submitScale(rawUrl, target.width, target.height)
    const scaleOutcome = await pollScaleUntilDone(client, pipeline.id, scaler, scaleJobRef)
    if ('cancelled' in scaleOutcome) {
      // rawUrl is already persisted (raw_file_url, above) — a future
      // retry/regenerate resumes straight into redoing only the downscale,
      // never re-paying KIE, same as the ordinary "downscale failed" path.
      console.log(`[${stepName}] cancelled mid-poll — raw KIE clip already saved, not recording a failure`)
      return true
    }
    if (!('fileBuffer' in scaleOutcome)) {
      const detail = 'failed' in scaleOutcome ? scaleOutcome.detail : 'downscale poll timed out'
      throw new ProviderCallError('upload_post', null, detail)
    }

    const permanentUrl = await uploader.uploadBuffer(
      `${pipeline.job_id}/scene-${scene.scene_number}-clip.mp4`,
      scaleOutcome.fileBuffer,
      'video/mp4',
    )
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation,
      assetType: 'scene_video_clip',
      videoSceneId: scene.id,
      status: 'ready',
      providerRef: jobRef?.providerRef,
      fileUrl: permanentUrl,
      // rawFileUrl omitted deliberately — defaults back to null now that
      // the asset is ready and the raw clip is no longer needed.
      attemptNumber,
    })
    await recordStepAttempt(client, {
      contentPipelineId: pipeline.id,
      stepName,
      generation,
      attemptNumber,
      status: 'succeeded',
      provider: 'kie',
      outputSnapshot: { fileUrl: permanentUrl },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // No providerRef passed here — the KIE task (whether just submitted or
    // resumed above) is now CONFIRMED done-for (explicit failure, 404, or
    // timeout before rawUrl was ever obtained), so upsertVisualAsset
    // defaults provider_ref back to null: a future retry legitimately needs
    // a fresh, paid submission. rawFileUrl IS passed through when set —
    // that's the fix: a downscale failure (rawUrl already obtained) must
    // keep it so the next attempt never re-pays for KIE just to redo the
    // downscale step.
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation,
      assetType: 'scene_video_clip',
      videoSceneId: scene.id,
      status: 'failed',
      rawFileUrl: rawUrl,
      attemptNumber,
    })
    // provider/max-attempts reflect which provider actually failed: once
    // rawUrl exists, KIE already succeeded and every subsequent failure is
    // upload-post.com's downscale step, cheap and unbilled — its own
    // (higher) retry budget applies, never KIE's.
    const failedProvider = rawUrl ? 'upload_post' : 'kie'
    await recordStepAttempt(client, {
      contentPipelineId: pipeline.id,
      stepName,
      generation,
      attemptNumber,
      status: 'failed_retryable',
      provider: failedProvider,
      errorMessage: message,
    })
    if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS[failedProvider])) {
      await markPipelineFailed(client, pipeline.id, `scene ${scene.scene_number} clip: ${message}`)
    }
  }
  return true
}

/**
 * Recomputes scenes_visuals_ready_count from the actual asset rows and
 * persists it — always a full recompute, never an in-memory increment, so
 * a retried step or a second worker touching the same pipeline can't
 * double-count or drift. `lastPersistedCount`/`announcedInProgress` are
 * only a cheap "did this specific value change since the last write THIS
 * call made" guard against redundant writes — not the source of truth.
 *
 * Called after EVERY scene in runGenerateSceneVisual's loop below, not
 * once at the very end — see that function's header for why that
 * distinction is load-bearing, not cosmetic.
 */
async function refreshVisualsProgress(
  client: SupabaseClient,
  pipeline: PipelineRow,
  scenes: VideoSceneRow[],
  generation: number,
  lastPersistedCount: number,
  announcedInProgress: boolean,
): Promise<{ lastPersistedCount: number; announcedInProgress: boolean; reachedReady: boolean }> {
  const assets = await getVisualAssets(client, pipeline.id, generation)
  const readyCount = scenes.filter((scene) => {
    const img = findAsset(assets, scene.id, 'scene_image')
    const clip = findAsset(assets, scene.id, 'scene_video_clip')
    return img?.status === 'ready' && clip?.status === 'ready'
  }).length

  if (readyCount === scenes.length) {
    // CAS — a no-op if another call already made this same transition
    // (e.g. this function reaching the ready count on what turns out to be
    // its last, redundant loop iteration after an earlier iteration's
    // refresh already flipped the pipeline to 'ready').
    await claimPipeline(client, pipeline.id, 'generating', 'ready', {
      scenes_visuals_ready_count: readyCount,
      current_step: 'visuals_ready',
    })
    return { lastPersistedCount: readyCount, announcedInProgress: true, reachedReady: true }
  }

  if (readyCount !== lastPersistedCount || !announcedInProgress) {
    await client
      .from('content_pipelines')
      .update({
        scenes_visuals_ready_count: readyCount,
        current_step: 'generating_scene_visuals',
        updated_at: new Date().toISOString(),
      })
      .eq('id', pipeline.id)
    return { lastPersistedCount: readyCount, announcedInProgress: true, reachedReady: false }
  }

  return { lastPersistedCount, announcedInProgress, reachedReady: false }
}

/**
 * Shared, pipeline-scoped step — fanned per scene (ARCHITECTURE.MD §4.2
 * step 4, §7.1's fan-in, minus the queue framing this codebase doesn't
 * have). For each of this pipeline's video_scenes rows: scene_image first
 * (Flux Kontext editing FROM the character_ref asset — see
 * generateCharacterRef.ts — never a fresh, independent reference), then
 * scene_video_clip (Kling image-to-video animating FROM that exact
 * scene_image). Neither sub-step imports anything from a track-scoped step
 * file, and neither is reachable from a per-language trigger — this is what
 * makes "EN and FR share the identical scene visuals" a structural fact,
 * not a convention.
 *
 * Scenes are mutually independent — every scene_image edits from the SAME
 * shared character_ref (never from another scene's output), and a
 * scene_video_clip only ever depends on its OWN scene's image. Nothing here
 * reads or waits on a sibling scene. So instead of a sequential for-loop
 * (measured live, 2026-09-13/14: ~20s/image + ~2min/clip, serialized across
 * 6+ scenes — the single biggest contributor to a ~20min shared-visual
 * phase), every scene's pending step (image or clip, whichever it needs
 * next) is launched concurrently below. What actually paces the real KIE.ai
 * traffic is kieRateLimiter (worker/src/lib/kieRateLimiter.ts), gating each
 * adapter's .submit() against KIE's documented account-wide 20-requests/10s
 * limit — not a hand-picked concurrency cap here, since polling (which
 * dominates wall-clock time per scene) isn't rate-limited and shouldn't be
 * serialized just because submission is paced.
 *
 * refreshVisualsProgress is attached to EVERY scene's task (not read back
 * once after they all settle) for the same reason it used to run after
 * every loop iteration: content_pipelines' scenes_visuals_ready_count/
 * current_step — which the dashboard's "Shared production" card
 * (src/app/dashboard/jobs/[job_id]/page.tsx) reads verbatim — needs to
 * advance as each scene actually finishes, not only once the slowest one
 * does. Concurrent tasks reading/writing the same lastPersistedCount/
 * announcedInProgress closure variables can race and occasionally trigger
 * a redundant write; that's fine — refreshVisualsProgress always recomputes
 * readyCount fresh from the asset rows and its own claimPipeline call is
 * already CAS-safe (see that function's header), so a stale local guard
 * only costs an extra no-op write, never an incorrect one.
 */
export async function runGenerateSceneVisual(
  client: SupabaseClient,
  pipeline: PipelineRow,
  characterRefUrl: string,
  imageGenerator: ImageGenerator,
  videoGenerator: VideoGenerator,
  uploader: VideoStorageUploader,
  scaler: SceneClipScaler,
  backoffBaseDelayMs = 5000,
  aspectRatio?: '9:16' | '1:1' | '16:9',
  /** Optional vision-based QA gate for scene images — see ImageValidator's
   *  own header (adapters/types.ts) and runSceneImageStep below. Omitted by
   *  every existing test, which keeps their exact prior behavior. */
  imageValidator?: ImageValidator,
): Promise<{ ran: boolean }> {
  if (pipeline.status !== 'generating') return { ran: false }

  const generation = pipeline.current_generation
  const scenes = await getVideoScenes(client, pipeline.id)
  if (scenes.length === 0) return { ran: false }
  // Not "last element of scenes" — getVideoScenes's ordering isn't a
  // contract this file should depend on. Used to tell
  // composeSceneVideoPrompt which scene is the video's actual ending, so
  // it can ask that scene's motion to settle instead of getting cut off
  // mid-movement — see compose.ts's FINAL_SCENE_SETTLE_CLAUSE.
  const maxSceneNumber = Math.max(...scenes.map((s) => s.scene_number))

  let lastPersistedCount = pipeline.scenes_visuals_ready_count
  let announcedInProgress = pipeline.current_step === 'generating_scene_visuals'

  const assets = await getVisualAssets(client, pipeline.id, generation)

  const tasks = scenes.map(async (scene) => {
    const imageAsset = findAsset(assets, scene.id, 'scene_image')
    const clipAsset = findAsset(assets, scene.id, 'scene_video_clip')

    let ran = false
    if (clipAsset?.status !== 'ready') {
      if (!imageAsset || imageAsset.status !== 'ready') {
        const previousScene = scenes.find((s) => s.scene_number === scene.scene_number - 1)
        ran = await runSceneImageStep(
          client,
          pipeline,
          scene,
          characterRefUrl,
          imageGenerator,
          uploader,
          backoffBaseDelayMs,
          aspectRatio,
          previousScene,
          imageValidator,
        )
      } else {
        ran = await runSceneVideoClipStep(
          client,
          pipeline,
          scene,
          imageAsset.file_url!,
          videoGenerator,
          uploader,
          backoffBaseDelayMs,
          scaler,
          scene.scene_number === maxSceneNumber,
          aspectRatio,
        )
      }
    }

    const refreshed = await refreshVisualsProgress(
      client,
      pipeline,
      scenes,
      generation,
      lastPersistedCount,
      announcedInProgress,
    )
    lastPersistedCount = refreshed.lastPersistedCount
    announcedInProgress = refreshed.announcedInProgress

    return ran
  })

  const results = await Promise.allSettled(tasks)
  const anyRan = results.some((result) => result.status === 'fulfilled' && result.value === true)

  return { ran: anyRan }
}
