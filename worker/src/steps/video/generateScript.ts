import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator } from '../../adapters/types.js'
import {
  claimPipeline,
  hasSucceededStep,
  recordStepAttempt,
  recordPipelineRetryableFailure,
  markPipelineFailed,
  upsertVideoScriptDraft,
  upsertVideoScenes,
  getVideoScenes,
  type PipelineRow,
} from '../../db.js'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff.js'
import { BRAND_PROFILE, composeVideoScriptSystemPrompt } from '../../prompts/index.js'

export interface VideoScriptJobInput {
  topic: string
  keywords: string
  category: string
  targetAudience: string
  scriptType: string
  /** The job's own intent-only language value (EN|FR|BOTH) — used only to
   *  populate content_drafts' legacy `language` column so this row can
   *  reuse the existing (job_id, content_type, language) unique constraint
   *  (see upsertVideoScriptDraft's doc comment). Never used to decide
   *  wording — scenes stay language-neutral regardless of this value. */
  jobLanguage: string
  /** User-selected target total runtime, in seconds (supabase/migrations/
   *  20260914000000) — one of the dashboard's fixed options (src/app/
   *  dashboard/new/page.tsx's VIDEO_DURATIONS, 24-52s). A target passed to
   *  the model, not a hard cap it's expected to hit exactly — see
   *  composeVideoScriptSystemPrompt's own header for why. */
  durationSeconds: number
}

export interface ScriptSceneOutput {
  scene_number: number
  visual_description: string
  shot_notes?: string
  narration_intent: string
  target_duration_seconds: number
}

export interface VideoScriptOutput {
  script: string
  visual_description: string
  duration_seconds: number
  scenes: ScriptSceneOutput[]
}

/** Coerces a numeric-looking string to a number — models routinely quote
 *  numbers in JSON (e.g. "scene_number": "1") even when explicitly asked
 *  for a bare number, the same class of quirk composeVideoScriptSystemPrompt
 *  already has to work around for JSON formatting generally. Returns null
 *  (not 0) for anything that isn't a real number, so a genuinely missing/
 *  malformed field still fails validation instead of silently becoming 0. */
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

/** Normalizes a parsed script response into VideoScriptOutput, or returns
 *  null if it's missing/malformed in a way that can't be safely coerced.
 *  Deliberately lenient on number-as-string (see coerceNumber) and on
 *  optional/blank shot_notes, but never invents a script/visual_description/
 *  narration_intent — those are exactly the content this step exists to
 *  produce, so a missing one is a real failure, not something to paper over. */
export function normalizeScriptOutput(parsed: unknown): VideoScriptOutput | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (typeof p.script !== 'string' || typeof p.visual_description !== 'string') return null
  const durationSeconds = coerceNumber(p.duration_seconds)
  if (durationSeconds === null) return null
  if (!Array.isArray(p.scenes) || p.scenes.length === 0) return null

  const scenes: ScriptSceneOutput[] = []
  for (const s of p.scenes) {
    if (!s || typeof s !== 'object') return null
    const scene = s as Record<string, unknown>
    const sceneNumber = coerceNumber(scene.scene_number)
    const targetDurationSeconds = coerceNumber(scene.target_duration_seconds)
    if (
      sceneNumber === null ||
      targetDurationSeconds === null ||
      typeof scene.visual_description !== 'string' ||
      typeof scene.narration_intent !== 'string'
    ) {
      return null
    }
    scenes.push({
      scene_number: sceneNumber,
      visual_description: scene.visual_description,
      shot_notes: typeof scene.shot_notes === 'string' ? scene.shot_notes : undefined,
      narration_intent: scene.narration_intent,
      target_duration_seconds: targetDurationSeconds,
    })
  }

  return { script: p.script, visual_description: p.visual_description, duration_seconds: durationSeconds, scenes }
}

/**
 * Shared, pipeline-scoped step — the ONLY generation step that runs before
 * user approval (ARCHITECTURE.MD §6.4: video gates expensive spend behind
 * one approval, unlike Blog/Image). Produces the script AND the scene plan
 * in one OpenAI call (§17.1), writes the master content_drafts row (no
 * per-language draft exists for video) and the video_scenes rows that
 * generate_character_ref/generate_scene_visual (M2) will read.
 *
 * Deliberately stops at 'draft_ready', not 'generating' — unlike
 * generateOutline.ts (Blog has no approval gate). POST /video/approve
 * (not this step) is what advances draft_ready -> approved.
 */
export async function runGenerateScript(
  client: SupabaseClient,
  pipeline: PipelineRow,
  input: VideoScriptJobInput,
  scriptGenerator: ScriptGenerator,
  backoffBaseDelayMs = 5000,
): Promise<{ ran: boolean }> {
  let working: PipelineRow

  if (pipeline.status === 'created') {
    const claimed = await claimPipeline(client, pipeline.id, 'created', 'drafting')
    if (!claimed) return { ran: false } // lost the race to another worker
    working = claimed
  } else if (pipeline.status === 'drafting') {
    if (!pipeline.last_error) return { ran: false } // no error recorded — already in flight, not our turn
    if (
      !isReadyToRetry({
        lastError: pipeline.last_error,
        retryCount: pipeline.retry_count,
        updatedAt: new Date(pipeline.updated_at),
        baseDelayMs: backoffBaseDelayMs,
      })
    ) {
      return { ran: false } // backoff window hasn't elapsed yet
    }
    working = pipeline
  } else {
    return { ran: false } // wrong state entirely for this step
  }

  const generation = working.current_generation
  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentPipelineId: pipeline.id },
    'generate_script',
    generation,
  )

  if (!alreadySucceeded) {
    const attemptNumber = working.retry_count + 1
    try {
      const result = await scriptGenerator.generate({
        systemPrompt: composeVideoScriptSystemPrompt(BRAND_PROFILE, {
          category: input.category,
          scriptType: input.scriptType,
          targetDurationSeconds: input.durationSeconds,
        }),
        userPrompt:
          `Topic: ${input.topic}\nKeywords: ${input.keywords}\nCategory: ${input.category}\n` +
          `Audience: ${input.targetAudience}\nScript type: ${input.scriptType}` +
          // Set by POST /video/regenerate { scope: "script" } — the only
          // regeneration scope that reruns this step, so this is always a
          // genuine user request to redo the script/scene plan differently,
          // never stale guidance from an unrelated earlier regen.
          (working.regen_instructions ? `\nThe user asked for this rewrite: ${working.regen_instructions}` : ''),
      })

      const output = normalizeScriptOutput(result.parsed)
      if (!output) {
        // Includes a truncated raw snippet — this exact failure previously
        // surfaced to the user as just "model output did not match the
        // required JSON shape", which no longer distinguishes "the model
        // returned non-JSON prose" from "valid JSON, wrong shape" and can't
        // be diagnosed after the fact (the raw content was never persisted
        // anywhere). last_error is shown directly in the dashboard's
        // "Shared production" failed state (VideoTabContent).
        const snippet = result.raw.slice(0, 500)
        throw new Error(
          `generate_script: model output did not match the required JSON shape (missing/invalid scenes). ` +
          `Raw response (truncated): ${snippet}`,
        )
      }

      await upsertVideoScriptDraft(client, {
        jobId: pipeline.job_id,
        language: input.jobLanguage,
        contentPipelineId: pipeline.id,
        draftData: {
          script: output.script,
          visual_description: output.visual_description,
          duration_seconds: output.duration_seconds,
          scenes: output.scenes,
        },
      })

      await upsertVideoScenes(client, {
        contentPipelineId: pipeline.id,
        generation,
        scenes: output.scenes.map((s) => ({
          sceneNumber: s.scene_number,
          visualDescription: s.visual_description,
          shotNotes: s.shot_notes ?? null,
          narrationIntent: { text: s.narration_intent },
          targetDurationMs: Math.round(s.target_duration_seconds * 1000),
        })),
      })

      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName: 'generate_script',
        generation,
        attemptNumber,
        status: 'succeeded',
        provider: 'openai',
        outputSnapshot: output,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName: 'generate_script',
        generation,
        attemptNumber,
        status: 'failed_retryable',
        provider: 'openai',
        errorMessage: message,
      })
      if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.openai)) {
        await markPipelineFailed(client, pipeline.id, message)
      } else {
        await recordPipelineRetryableFailure(client, pipeline.id, attemptNumber, message)
      }
      return { ran: true }
    }
  }

  // scenes_total must be set regardless of whether THIS call did the work or
  // found it already done (resumed-worker case) — read back from the DB
  // rather than trusting a locally-held count that may not exist on resume.
  const scenes = await getVideoScenes(client, pipeline.id)
  await claimPipeline(client, pipeline.id, 'drafting', 'draft_ready', { scenes_total: scenes.length })
  return { ran: true }
}
