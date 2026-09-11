import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator } from '../adapters/types.js'
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
} from '../db.js'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../lib/backoff.js'
import { BRAND_PROFILE, composeVideoScriptSystemPrompt } from '../prompts/index.js'

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
}

interface ScriptSceneOutput {
  scene_number: number
  visual_description: string
  shot_notes?: string
  narration_intent: string
  target_duration_seconds: number
}

interface VideoScriptOutput {
  script: string
  visual_description: string
  duration_seconds: number
  scenes: ScriptSceneOutput[]
}

function isValidScriptOutput(parsed: unknown): parsed is VideoScriptOutput {
  if (!parsed || typeof parsed !== 'object') return false
  const p = parsed as Record<string, unknown>
  if (typeof p.script !== 'string' || typeof p.visual_description !== 'string') return false
  if (!Array.isArray(p.scenes) || p.scenes.length === 0) return false
  return p.scenes.every((s) => {
    if (!s || typeof s !== 'object') return false
    const scene = s as Record<string, unknown>
    return (
      typeof scene.scene_number === 'number' &&
      typeof scene.visual_description === 'string' &&
      typeof scene.narration_intent === 'string' &&
      typeof scene.target_duration_seconds === 'number'
    )
  })
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
        }),
        userPrompt:
          `Topic: ${input.topic}\nKeywords: ${input.keywords}\nCategory: ${input.category}\n` +
          `Audience: ${input.targetAudience}\nScript type: ${input.scriptType}`,
      })

      if (!isValidScriptOutput(result.parsed)) {
        throw new Error(
          'generate_script: model output did not match the required JSON shape (missing/invalid scenes)',
        )
      }
      const output = result.parsed

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
  const scenes = await getVideoScenes(client, pipeline.id, generation)
  await claimPipeline(client, pipeline.id, 'drafting', 'draft_ready', { scenes_total: scenes.length })
  return { ran: true }
}
