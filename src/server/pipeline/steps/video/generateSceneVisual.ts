import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  ImageGenerator,
  VideoGenerator,
  SceneClipScaler,
  ImageValidator,
  ImageValidationResult,
} from '../../adapters/types'
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
  getLastFailedStepAttempt,
  getVideoPlanDraftData,
  countFailedStepAttemptsWithPrefix,
  type PipelineRow,
  type VideoSceneRow,
  type VisualAssetRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'
import { ASPECT_RATIO_RESOLUTIONS } from '../../lib/videoResolution'
import { pickClipDurationSeconds } from '../../lib/sceneClipDuration'
import {
  BRAND_PROFILE,
  composeSceneImagePrompt,
  composeSceneImageEditPrompt,
  composeSceneVideoPrompt,
} from '../../prompts/index'
import type { CastBibleEntry, VideoScriptLook } from '../../prompts/types'
import { extractVisualState, extractSceneLayer2Fields, normalizeLook, normalizeCastBible } from './generateScript'

const IMAGE_POLL_INTERVAL_MS = 2000
// Raised from 60_000 (2026-09-22): a real 6-scene concurrent wave had
// every one of the 6 scenes time out on at least one attempt at 60s, with
// 2 of them exhausting all 5 retries this way — the same class of problem
// VIDEO_POLL_TIMEOUT_MS was already bumped for below, just never applied
// to the image side. Doubled, matching that fix's own ratio, pending real
// timing data on how long KIE.ai's Flux Kontext endpoint actually takes
// under concurrent submission load.
const IMAGE_POLL_TIMEOUT_MS = 120_000
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
// Raised from 5000 (2026-09-23): this poll is gated by the SAME
// account-wide uploadPostSubmitLimiter every submission also shares (see
// avMerger.ts's poll(), and uploadPostRateLimiter.ts's own 45-req/60s cap
// — confirmed live 2026-09-19 that polling ALONE, with no new submissions,
// can blow that budget). A flat 5s interval means N concurrently-
// downscaling scenes nominally demand N polls every 5s — for the video
// script schema's own documented max of 10 scenes (composeVideoScriptSystemPrompt),
// that's 120 polls/min against a 45/min account-wide budget. The limiter's
// acquire() BLOCKS rather than rejects when exhausted, so that overrun
// doesn't error — it silently eats into each scene's own fixed
// SCALE_POLL_TIMEOUT_MS deadline as queuing delay, indistinguishable from
// the provider itself being slow. Confirmed live 2026-09-22/23: a real
// 5-scene job's downscale step timed out repeatedly this way, even though
// this same file's own history (below) already established that real
// upload-post.com jobs typically finish in under a second — the work was
// almost certainly done; we just weren't checking back often enough to
// notice within our own deadline. Widened to 20s so even 10 concurrent
// scenes (10 x 3/min = 30 polls/min) stay comfortably under the 45/min cap
// with real headroom for jitter and any other upload-post.com traffic
// sharing the same account (mux/concat/caption/social-publish calls).
const SCALE_POLL_INTERVAL_MS = 20_000
// Real evidence (2026-09-13) that a single-file re-encode via this same
// provider completes in under a second (buildVideoConcatCommand's own
// 2-scene concat took 0.73-0.77s) — a single clip's downscale should be at
// least as fast. Generous margin over that anyway, rather than a tight
// timeout, since we don't yet have a real timing sample for a full-length
// (~10s) clip specifically. Still comfortably fits several poll attempts
// (9, at the 20s interval above) even under the contention that motivated
// widening the interval.
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
// runSceneImageStep's next attempt (via getLastFailedStepAttempt), whose
// output_snapshot carries the rejected image's URL + issues for an edit-mode
// retry (see composeSceneImageEditPrompt). Rows written before that
// snapshot existed fall back to the old regenInstructions correction. See this file's own header for
// why this rides the EXISTING error_message column instead of a new one.
const VALIDATION_RETRY_PREFIX = 'VALIDATION_RETRY:'

// Validation-driven regenerations get their OWN budget, separate from
// MAX_ATTEMPTS.kie (which exists for genuine provider failures). Before
// this (2026-09-23), both shared the 5-attempt KIE budget, so one scene
// could burn up to 5 paid KIE images on the validator's opinion alone.
// Real data across 4 jobs: 54 validation rejections over 18 scenes, 8 of
// which exhausted every retry and were accepted anyway with the SAME
// issue still present — those regenerations bought nothing. One targeted
// retry, then accept.
const MAX_VALIDATION_RETRIES = 1

/** Plan-level (pipeline-wide) Layer 2 fields from the script draft, loaded
 *  once per runGenerateSceneVisual call and shared by every scene. */
interface ScenePlanContext {
  look?: VideoScriptLook
  castBible?: CastBibleEntry[]
}

/** Shape of a validation-rejected attempt's output_snapshot. */
interface RejectedImageSnapshot {
  rejectedImageUrl?: unknown
  issues?: unknown
}

/** Legacy fallback only (a rejection recorded before rejected-image URLs
 *  were stored) — turns the validator's issue list into a short, targeted correction
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
  plan: ScenePlanContext = {},
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
      // exact scene image was rejected by the validator (never a genuine
      // provider failure — those don't carry this prefix), EDIT that
      // rejected image to fix just its defects, rather than regenerating
      // the scene from scratch — see composeSceneImageEditPrompt's header
      // for why a from-scratch retry kept reproducing the same defect.
      let regenInstructions = pipeline.regen_instructions
      let editFrom: { rejectedImageUrl: string; issues: string[] } | undefined
      if (existing?.status === 'failed') {
        const last = await getLastFailedStepAttempt(client, { contentPipelineId: pipeline.id }, stepName, generation)
        if (last?.errorMessage?.startsWith(VALIDATION_RETRY_PREFIX)) {
          const snapshot = last.outputSnapshot as RejectedImageSnapshot | null
          const issues = Array.isArray(snapshot?.issues)
            ? snapshot.issues.filter((i): i is string => typeof i === 'string')
            : []
          if (typeof snapshot?.rejectedImageUrl === 'string' && issues.length > 0) {
            editFrom = { rejectedImageUrl: snapshot.rejectedImageUrl, issues }
          } else {
            const correction = last.errorMessage.slice(VALIDATION_RETRY_PREFIX.length)
            regenInstructions = [pipeline.regen_instructions, correction].filter(Boolean).join(' ')
          }
        }
      }

      // referenceImageUrl comes from the composition itself, not
      // characterRefUrl directly — composeSceneImagePrompt gates whether
      // the unit's reference photo is used at all on this scene's own
      // unit_presence (Layer 2 plan field, PROMPT_REFACTOR_BRIEF.md §4.3/
      // §8 — replaces the old isVideoSceneAboutUnit keyword-regex gate), so
      // a 'none' scene returns undefined here and gets a pure text-to-image
      // generation instead of forcing the unit in as an edit source. An
      // edit-mode retry instead uses the rejected image itself as the edit
      // source.
      const layer2 = extractSceneLayer2Fields(scene.narration_intent)
      const castIds = new Set(layer2.cast_present ?? [])
      const { prompt, referenceImageUrl } = editFrom
        ? composeSceneImageEditPrompt(BRAND_PROFILE, { ...editFrom, unitPresence: layer2.unit_presence })
        : composeSceneImagePrompt(BRAND_PROFILE, {
            pipelineId: pipeline.id,
            sceneNumber: scene.scene_number,
            visualDescription: scene.visual_description,
            shotNotes: scene.shot_notes,
            characterRefUrl,
            regenInstructions,
            previousVisualState: previousScene ? extractVisualState(previousScene.narration_intent) : undefined,
            unitPresence: layer2.unit_presence,
            containsFood: layer2.contains_food,
            // Only people this scene explicitly lists — an unknown/empty
            // cast_present never pulls a recurring person into the frame.
            cast: plan.castBible?.filter((c) => castIds.has(c.id)),
            look: plan.look,
          })

      if (editFrom) {
        console.log(`[${stepName}] EDIT-MODE RETRY (attempt ${attemptNumber}) — fixing: ${editFrom.issues.join('; ')}`)
      }
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
        // Per-generation, per-attempt path — a validation-rejected image
        // must survive the retry, since the retry edits it (see editFrom
        // above) rather than regenerating from scratch.
        `${pipeline.job_id}/scene-${scene.scene_number}-image-g${generation}-a${attemptNumber}.png`,
        outcome.fileUrl,
      )

      // Lightweight vision QA gate (request #5), run once per scene image,
      // BEFORE this scene's video clip is ever submitted — runGenerateSceneVisual's
      // own gating (an image asset must already be 'ready' before
      // runSceneVideoClipStep is even called) is what actually enforces
      // "before video generation" here; this function just has to avoid
      // marking the asset 'ready' until validation says so.
      let validation: ImageValidationResult = { pass: true, issues: [] }
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

      // Only queried on a rejection — the common (passing) path costs no
      // extra DB round-trip.
      const validationRetriesUsed = validation.pass
        ? 0
        : await countFailedStepAttemptsWithPrefix(
            client,
            { contentPipelineId: pipeline.id },
            stepName,
            generation,
            VALIDATION_RETRY_PREFIX,
          )

      if (
        !validation.pass &&
        validationRetriesUsed < MAX_VALIDATION_RETRIES &&
        !hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.kie)
      ) {
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
          outputSnapshot: { rejectedImageUrl: permanentUrl, issues: validation.issues },
        })
        return true
      }

      if (!validation.pass) {
        console.log(
          `[${stepName}] image validation FAILED again after ${validationRetriesUsed} validation retr${validationRetriesUsed === 1 ? 'y' : 'ies'} — accepting as-is, no further KIE spend: ${validation.issues.join('; ')}`,
        )
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
        outputSnapshot: {
          fileUrl: permanentUrl,
          validationIssues: validation.issues,
          ...(validation.ignoredIssues?.length ? { validationIgnoredIssues: validation.ignoredIssues } : {}),
        },
      })
    } else if ('timedOut' in outcome && !hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.kie)) {
      // Resume, don't discard: our poll gave up, but KIE never confirmed
      // failure — the task may still be running server-side. Keeping
      // provider_ref (instead of clearing it, as the genuine-failure path
      // below does) means the next attempt's RESUMED branch re-polls this
      // EXACT task instead of paying for and re-queuing a brand new
      // submission — the same "an interruption can never turn one paid
      // generation into two" reasoning the crash-recovery RESUMED branch
      // above already relies on, just extended to a timeout as well as a
      // process crash. Still recorded as failed_retryable and still
      // counted against MAX_ATTEMPTS.kie (not a free retry) — this only
      // stops a slow response from ALSO costing a wasted duplicate
      // submission on top of its own slowness (confirmed live 2026-09-22:
      // a 6-scene concurrent wave regularly exceeded the poll window, and
      // every timeout unconditionally discarded the in-flight task).
      console.log(
        `[${stepName}] poll timed out (attempt ${attemptNumber}) — leaving task ${jobRef.providerRef} resumable, not resubmitting`,
      )
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'scene_image',
        videoSceneId: scene.id,
        status: 'generating',
        providerRef: jobRef.providerRef,
        attemptNumber: attemptNumber + 1,
      })
      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName,
        generation,
        attemptNumber,
        status: 'failed_retryable',
        provider: 'kie',
        errorMessage: 'KIE.ai poll timed out (task left resumable, not resubmitted)',
      })
      return true
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
  plan: ScenePlanContext = {},
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
  // Set only when a downscale job was already submitted (and billed, though
  // upload-post.com's downscale is unbilled today) and left unresolved by a
  // previous attempt — same "provider_ref set + status still 'generating'"
  // resumability signal the KIE branches use, just scoped to the scale
  // step. provider_ref is safe to reuse for this once raw_file_url exists:
  // the KIE clip it originally referred to is already fully captured by
  // raw_file_url at that point, so nothing downstream ever needs to resume
  // the OLD KIE task via provider_ref again.
  let scaleJobRef: { providerRef: string } | undefined

  if (existing?.raw_file_url) {
    rawUrl = existing.raw_file_url
    if (existing.status === 'generating' && existing.provider_ref) {
      // A downscale job was already submitted for this exact raw clip and
      // the worker just never observed its result (timeout or crash).
      // Resuming it — never gated by backoff, same reasoning as the KIE
      // RESUMED branch below — is what stops a slow-but-still-running
      // downscale from also costing a wasted duplicate submission on top
      // of its own slowness (confirmed live 2026-09-22: a real run had
      // scene 1/3/5's downscale time out repeatedly in a row, each timeout
      // previously discarding the in-flight job and resubmitting fresh).
      attemptNumber = existing.attempt_number
      scaleJobRef = { providerRef: existing.provider_ref }
      console.log(`[${stepName}] RESUMED existing downscale task ${scaleJobRef.providerRef} (attempt ${attemptNumber}) — no new submission`)
    } else {
      // KIE already succeeded and was already billed on a previous attempt —
      // only the downscale step failed (or was never yet attempted). Retry
      // that alone; never resubmit to KIE for this scene again in this
      // generation. Same backoff gate as the ordinary retry branch below,
      // just keyed off this row instead.
      const ready = isReadyToRetry({
        lastError: 'previous downscale attempt did not succeed',
        retryCount: existing.attempt_number,
        updatedAt: new Date(existing.updated_at),
        baseDelayMs: backoffBaseDelayMs,
      })
      if (!ready) return false
      attemptNumber = existing.attempt_number + 1
      console.log(`[${stepName}] RESUMED FROM RAW KIE CLIP (attempt ${attemptNumber}) — retrying downscale only, no new KIE charge`)
    }
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
          look: plan.look,
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
      if ('timedOut' in outcome && !hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.kie)) {
        // Resume, don't discard — same reasoning as the image step's own
        // timeout branch above: our poll gave up, KIE never confirmed
        // failure, so the clip may still be rendering server-side.
        // Keeping provider_ref means the next attempt's RESUMED branch
        // re-polls this EXACT task instead of paying for and re-queuing a
        // brand new video generation, which is meaningfully more
        // expensive to duplicate than an image. Still recorded as
        // failed_retryable and still counted against MAX_ATTEMPTS.kie.
        console.log(
          `[${stepName}] poll timed out (attempt ${attemptNumber}) — leaving task ${jobRef.providerRef} resumable, not resubmitting`,
        )
        await upsertVisualAsset(client, {
          contentPipelineId: pipeline.id,
          generation,
          assetType: 'scene_video_clip',
          videoSceneId: scene.id,
          status: 'generating',
          providerRef: jobRef.providerRef,
          attemptNumber: attemptNumber + 1,
        })
        await recordStepAttempt(client, {
          contentPipelineId: pipeline.id,
          stepName,
          generation,
          attemptNumber,
          status: 'failed_retryable',
          provider: 'kie',
          errorMessage: 'KIE.ai poll timed out (task left resumable, not resubmitted)',
        })
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
    if (!scaleJobRef) {
      scaleJobRef = await scaler.submitScale(rawUrl, target.width, target.height)
      // Persist the scale task id BEFORE polling — same "persist before
      // poll" fix the KIE clip submission above already relies on, so an
      // interruption (crash or timeout) can resume this exact downscale
      // job next attempt instead of discarding it and resubmitting.
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'scene_video_clip',
        videoSceneId: scene.id,
        status: 'generating',
        providerRef: scaleJobRef.providerRef,
        rawFileUrl: rawUrl,
        attemptNumber,
      })
    }
    const scaleOutcome = await pollScaleUntilDone(client, pipeline.id, scaler, scaleJobRef)
    if ('cancelled' in scaleOutcome) {
      // rawUrl and the scale task id are already persisted above — a future
      // retry/regenerate resumes straight into this exact downscale job,
      // never re-paying KIE and never resubmitting to upload-post.com.
      console.log(`[${stepName}] cancelled mid-poll — raw KIE clip + downscale task already saved, not recording a failure`)
      return true
    }
    if ('timedOut' in scaleOutcome && !hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.upload_post)) {
      // Resume, don't discard — same reasoning as the KIE timeout branches
      // above: our poll gave up, upload-post.com never confirmed failure,
      // so the downscale may still be running server-side. Still recorded
      // as failed_retryable and still counted against
      // MAX_ATTEMPTS.upload_post (not a free retry) — this only stops a
      // slow response from also costing a wasted duplicate submission
      // (confirmed live 2026-09-22: scenes 1/3/5's downscale all timed out
      // repeatedly in the same run this was found in, each timeout
      // previously discarding the in-flight job and resubmitting fresh).
      console.log(
        `[${stepName}] downscale poll timed out (attempt ${attemptNumber}) — leaving task ${scaleJobRef.providerRef} resumable, not resubmitting`,
      )
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'scene_video_clip',
        videoSceneId: scene.id,
        status: 'generating',
        providerRef: scaleJobRef.providerRef,
        rawFileUrl: rawUrl,
        attemptNumber: attemptNumber + 1,
      })
      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName,
        generation,
        attemptNumber,
        status: 'failed_retryable',
        provider: 'upload_post',
        errorMessage: 'downscale poll timed out (task left resumable, not resubmitted)',
      })
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

  // Plan-level look + cast bible (Layer 2), read once and shared by every
  // scene — see ScenePlanContext. A missing/legacy draft just means both
  // are undefined and the composers fall back to their defaults.
  const planData = await getVideoPlanDraftData(client, pipeline.id)
  const plan: ScenePlanContext = {
    look: normalizeLook(planData?.look),
    castBible: normalizeCastBible(planData?.cast_bible),
  }

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
          plan,
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
          plan,
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
