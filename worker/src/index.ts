// Content worker process entrypoint. Polls content_pipelines/content_language_tracks
// directly by status (no separate queue table — see ARCHITECTURE.MD §7 /
// docs/IMPLEMENTATION_PLAN.md Phase 2) and dispatches to the step handlers
// in src/steps/{blog,image,video}/, per content_type. Each step handler is independently
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
import { runGenerateOutline, type OutlineJobInput } from './steps/blog/generateOutline.js'
import { runGenerateScript, type VideoScriptJobInput } from './steps/video/generateScript.js'
import { runGenerateCharacterRef } from './steps/video/generateCharacterRef.js'
import { runGenerateSceneVisual } from './steps/video/generateSceneVisual.js'
import { runLocalizeScript } from './steps/video/localizeScript.js'
import { runSynthesizeVoice } from './steps/video/synthesizeVoice.js'
import { runTranscribeAudio } from './steps/video/transcribeAudio.js'
import { runRenderLanguageTrack } from './steps/video/renderLanguageTrack.js'
import { runGenerateVisualImage } from './steps/blog/generateVisualImage.js'
import { runGenerateCopy } from './steps/blog/generateCopy.js'
import { runFinalizeDraft } from './steps/blog/finalizeDraft.js'
import { runGenerateAdCopy } from './steps/image/generateAdCopy.js'
import { runGeneratePhoto } from './steps/image/generatePhoto.js'
import { runGenerateCaption } from './steps/image/generateCaption.js'
import { runFinalizeImageContent } from './steps/image/finalizeImageContent.js'
import { OpenAIScriptGenerator } from './adapters/openai.js'
import { KieImageGenerator, KieVideoGenerator } from './adapters/kie.js'
import { NanoBananaImageGenerator } from './adapters/nanoBanana.js'
import type { ImageGenerator } from './adapters/types.js'
import { SupabasePhotoStorageUploader, SupabaseVideoStorageUploader } from './adapters/storage.js'
import { ElevenLabsVoiceSynthesizer } from './adapters/elevenlabs.js'
import { AssemblyAITranscriptionService } from './adapters/assemblyai.js'
import { UploadPostAVMerger } from './adapters/avMerger.js'
import { env } from './env.js'
import { BRAND_PROFILE, composeHeroPrompt, composeInlinePrompt, composePhotoPrompt, composeCharacterRefPrompt, type ImageStyle } from './prompts/index.js'
import { parseAdCopy } from './lib/adCopy.js'

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000)
// 'video': generate_script (M1, created/drafting -> draft_ready),
// generate_character_ref + generate_scene_visual (M2, approved -> generating
// -> ready/"visuals_ready"). Per-language audio/caption/render (M3/M4)
// aren't built yet — a track created by POST /video/approve just sits at
// waiting_on_shared until then.
const PIPELINE_CONTENT_TYPES = ['blog', 'image_post', 'video'] as const

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
  // video-only — script_type is required by new/page.tsx whenever 'video'
  // is a selected content type; language is the job-level intent-only value
  // (EN|FR|BOTH, ARCHITECTURE.MD §5) used only to populate content_drafts'
  // legacy language column for the master script draft, never to decide
  // wording (see generateScript.ts's VideoScriptJobInput.jobLanguage).
  scriptType: string | null
  jobLanguage: string
  // video-only — user-selected per job (supabase/migrations/20260912120000),
  // passed straight to Flux Kontext's own aspectRatio param for character-ref/
  // scene-image generation (worker/src/adapters/kie.ts). Kling has no
  // aspect-ratio param of its own; it inherits whatever reference image it
  // animates, so this one setting is enough for matching video clips too.
  aspectRatio: '9:16' | '1:1' | '16:9'
  // video-only — user-selected per job (supabase/migrations/20260914000000),
  // passed to generate_script as a target total runtime (VideoScriptJobInput.
  // durationSeconds -> composeVideoScriptSystemPrompt). A target, not a hard
  // cap — see that prompt's own header for why the script can run slightly
  // short or long of this instead of truncating a scene's narration.
  videoDurationSeconds: number
}

async function fetchJobInputs(client: SupabaseClient, jobId: string): Promise<JobInputs> {
  const { data, error } = await client
    .from('content_jobs')
    .select(
      'topic, keywords, category, target_audience, province, city, scene_notes, image_answers, image_style, content_angle, script_type, language, aspect_ratio, video_duration_seconds',
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
    scriptType: (data.script_type as string | null) ?? null,
    jobLanguage: (data.language as string | null) ?? 'EN',
    aspectRatio: (data.aspect_ratio as '9:16' | '1:1' | '16:9' | null) ?? '9:16',
    videoDurationSeconds: (data.video_duration_seconds as number | null) ?? 36,
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
  videoGenerator: KieVideoGenerator,
  videoUploader: SupabaseVideoStorageUploader,
  clipScaler: UploadPostAVMerger,
): Promise<void> {
  const { data: pipelines, error } = await client
    .from('content_pipelines')
    .select('*')
    // 'approved' is video-only (script locked, pre-visual-generation) — blog
    // and image_post never reach it (no pre-generation approval gate).
    .in('content_type', PIPELINE_CONTENT_TYPES)
    .in('status', ['created', 'drafting', 'approved', 'generating'])

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
      } else if (pipeline.content_type === 'video') {
        if (pipeline.status === 'created' || pipeline.status === 'drafting') {
          const scriptInput: VideoScriptJobInput = {
            topic: jobInputs.topic,
            keywords: jobInputs.keywords,
            category: jobInputs.category,
            targetAudience: jobInputs.targetAudience,
            scriptType: jobInputs.scriptType ?? 'SOLUTION',
            jobLanguage: jobInputs.jobLanguage,
            durationSeconds: jobInputs.videoDurationSeconds,
          }
          await runGenerateScript(client, pipeline, scriptInput, scriptGenerator)
        } else if (pipeline.status === 'approved' || pipeline.status === 'generating') {
          // M2 scope: character_ref (once) then per-scene visuals. Neither
          // step is reachable from a per-language trigger — see
          // generateSceneVisual.ts's header for why that's load-bearing,
          // not just documentation.
          const characterRefPrompt = composeCharacterRefPrompt(BRAND_PROFILE, {
            pipelineId: pipeline.id,
            regenInstructions: pipeline.regen_instructions,
          })
          await runGenerateCharacterRef(
            client,
            pipeline,
            characterRefPrompt.prompt,
            imageGenerator,
            videoUploader,
            5000,
            characterRefPrompt.referenceImageUrl,
            jobInputs.aspectRatio,
          )

          // Re-fetch — generate_character_ref may have just advanced this
          // pipeline's status/current_step.
          const { data: freshPipeline } = await client
            .from('content_pipelines')
            .select('*')
            .eq('id', pipeline.id)
            .single()
          if (freshPipeline && (freshPipeline as PipelineRow).status === 'generating') {
            const assets = await client
              .from('content_visual_assets')
              .select('*')
              .eq('content_pipeline_id', pipeline.id)
              .eq('generation', pipeline.current_generation)
              .eq('asset_type', 'character_ref')
              .maybeSingle()
            const characterRefUrl = (assets.data?.file_url as string | undefined) ?? undefined
            if (characterRefUrl) {
              await runGenerateSceneVisual(
                client,
                freshPipeline as PipelineRow,
                characterRefUrl,
                imageGenerator,
                videoGenerator,
                videoUploader,
                clipScaler,
                5000,
                jobInputs.aspectRatio,
              )
            }
          }
        }
      }
    } catch (err) {
      console.error(`[worker] pipeline ${pipeline.id} tick failed:`, err)
    }
  }
}

async function tickTracks(
  client: SupabaseClient,
  scriptGenerator: OpenAIScriptGenerator,
  voiceSynthesizer: ElevenLabsVoiceSynthesizer,
  transcriptionService: AssemblyAITranscriptionService,
  videoUploader: SupabaseVideoStorageUploader,
  avMerger: UploadPostAVMerger,
): Promise<void> {
  const { data: tracks, error } = await client
    .from('content_language_tracks')
    .select('*')
    // 'awaiting_shared'/'rendering' are video-only (M3/M4) — Blog/Image
    // tracks never reach them (no render step, no shared-visual gate after
    // their own text-generation step).
    .in('status', ['waiting_on_shared', 'generating', 'awaiting_shared', 'rendering'])

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
      } else if (pipeline.content_type === 'video') {
        // localize_script -> synthesize_voice (per scene) ->
        // transcribe_captions (M3) -> render (M4, gated on the pipeline's
        // shared visuals AND generation fencing — see renderLanguageTrack.ts).
        await runLocalizeScript(client, track, pipeline.id, scriptGenerator)

        const { data: afterLocalize } = await client
          .from('content_language_tracks')
          .select('*')
          .eq('id', track.id)
          .single()
        if (afterLocalize) {
          await runSynthesizeVoice(
            client,
            afterLocalize as TrackRow,
            pipeline.id,
            pipeline.job_id,
            voiceSynthesizer,
            videoUploader,
          )
        }

        const { data: afterSynthesize } = await client
          .from('content_language_tracks')
          .select('*')
          .eq('id', track.id)
          .single()
        if (afterSynthesize) {
          await runTranscribeAudio(client, afterSynthesize as TrackRow, pipeline.id, transcriptionService)
        }

        const { data: afterTranscribe } = await client
          .from('content_language_tracks')
          .select('*')
          .eq('id', track.id)
          .single()
        if (afterTranscribe) {
          await runRenderLanguageTrack(
            client,
            afterTranscribe as TrackRow,
            pipeline as PipelineRow,
            avMerger,
            videoUploader,
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
  videoGenerator: KieVideoGenerator,
  videoUploader: SupabaseVideoStorageUploader,
  voiceSynthesizer: ElevenLabsVoiceSynthesizer,
  transcriptionService: AssemblyAITranscriptionService,
  avMerger: UploadPostAVMerger,
): Promise<void> {
  await tickPipelines(
    client,
    scriptGenerator,
    imageGenerator,
    nanoBananaGenerator,
    uploader,
    videoGenerator,
    videoUploader,
    avMerger,
  )
  await tickTracks(client, scriptGenerator, voiceSynthesizer, transcriptionService, videoUploader, avMerger)
}

async function main(): Promise<void> {
  const client = createServiceClient()
  const scriptGenerator = new OpenAIScriptGenerator(env.OPENAI_API_KEY)
  const imageGenerator = new KieImageGenerator(env.KIE_API_KEY)
  const nanoBananaGenerator = new NanoBananaImageGenerator(env.KIE_API_KEY)
  const uploader = new SupabasePhotoStorageUploader(client)
  const videoGenerator = new KieVideoGenerator(env.KIE_API_KEY)
  const videoUploader = new SupabaseVideoStorageUploader(client)
  const voiceSynthesizer = new ElevenLabsVoiceSynthesizer(env.ELEVENLABS_API_KEY)
  const transcriptionService = new AssemblyAITranscriptionService(env.ASSEMBLYAI_API_KEY)
  const avMerger = new UploadPostAVMerger(env.UPLOAD_POST_API_KEY)

  let stopping = false
  const stop = () => {
    console.log('[worker] shutdown signal received, stopping after current tick')
    stopping = true
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  console.log(`[worker] started, polling every ${POLL_INTERVAL_MS}ms`)
  while (!stopping) {
    await tick(
      client,
      scriptGenerator,
      imageGenerator,
      nanoBananaGenerator,
      uploader,
      videoGenerator,
      videoUploader,
      voiceSynthesizer,
      transcriptionService,
      avMerger,
    )
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  console.log('[worker] stopped')
}

main().catch((err) => {
  console.error('[worker] fatal error:', err)
  process.exit(1)
})
