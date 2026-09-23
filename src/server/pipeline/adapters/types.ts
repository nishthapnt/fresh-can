// Provider adapter interfaces — ARCHITECTURE.MD §8. Business logic (worker
// steps) depends only on these, never on a provider SDK/HTTP client directly.

export class ProviderCallError extends Error {
  constructor(
    public readonly provider: string,
    public readonly httpStatus: number | null,
    public readonly detail: string,
  ) {
    // `detail` is typed as string, but every call site derives it from an
    // untrusted JSON response cast (`as { msg?: string }` etc.) — TypeScript
    // doesn't validate that at runtime, and a real KIE.ai error response was
    // observed (2026-09-14) sending `msg` as a nested object, not a string.
    // Interpolating that directly used to silently render as "[object
    // Object]", discarding the actual error detail. JSON.stringify keeps it
    // readable; String(...) is only a last-resort fallback for the rare
    // value (e.g. one with a circular reference) that JSON.stringify itself
    // throws on.
    const safeDetail =
      typeof detail === 'string'
        ? detail
        : (() => {
            try {
              return JSON.stringify(detail)
            } catch {
              return String(detail)
            }
          })()
    super(`${provider} call failed (status ${httpStatus ?? 'n/a'}): ${safeDetail}`)
    this.name = 'ProviderCallError'
  }
}

export interface ScriptGenerationInput {
  systemPrompt: string
  userPrompt: string
  model?: string
  /** The calling step's own step_name (the same string it passes to
   *  recordStepAttempt) — e.g. 'generate_outline', 'generate_script'.
   *  OpenAIScriptGenerator (the real adapter) ignores this entirely; it
   *  exists purely so tests can route a fake generator's response by real
   *  step identity instead of sniffing the system prompt's wording, which
   *  breaks silently every time a prompt gets reworded (PROMPT_REFACTOR_BRIEF.md
   *  §13 — see the three *Pipeline.e2e.test.ts files). Optional so a caller
   *  that omits it still works identically against the real adapter. */
  stepName?: string
}

export interface ScriptGenerationResult {
  raw: string
  /** Best-effort JSON.parse of `raw`; null if the model didn't return valid JSON. */
  parsed: unknown | null
}

export interface ScriptGenerator {
  generate(input: ScriptGenerationInput): Promise<ScriptGenerationResult>
}

export interface ImageGenerationInput {
  prompt: string
  /**
   * A real photo of the branded subject (e.g. the Fresh-CAN truck) for the
   * model's image-editing mode — it edits/extends from this instead of
   * hallucinating the truck's appearance from a text description alone.
   * Three implementations, three wire shapes: KieImageGenerator's
   * dedicated flux/kontext/generate endpoint takes a single-URL
   * `inputImage`; KieSceneImageGenerator's unified Market endpoint
   * (`model: 'flux1-kontext'`) takes `image_urls: [url]`, an array;
   * NanoBananaImageGenerator (nano-banana-2, the permanent choice for all
   * three content types as of 2026-09-23) takes `image_input: [url]`,
   * also an array — each adapter maps this same field to its own
   * provider's shape.
   */
  referenceImageUrl?: string
  /**
   * Passed straight through to the underlying model's own aspect-ratio
   * param (`aspectRatio` on KieImageGenerator's endpoint, `aspect_ratio`
   * on KieSceneImageGenerator's AND NanoBananaImageGenerator's — the
   * latter's real param name, live-verified 2026-09-23 after discovering
   * its previous `image_size` key was silently ignored, see
   * nanoBanana.ts's own header). Video-only (content_jobs.aspect_ratio,
   * supabase/migrations/20260912120000) — blog/image_post callers never
   * set this and get NanoBananaImageGenerator's own '4:5' default,
   * unchanged from before this field existed. The scene video-clip model
   * (KieVideoGenerator) has no aspect-ratio param of its own — it
   * inherits the shape of whatever reference image it animates, so
   * setting this on character-ref/scene-image generation is sufficient to
   * get matching video clips too.
   */
  aspectRatio?: '9:16' | '1:1' | '16:9'
}

export interface ImageJobRef {
  providerRef: string
}

export type ImagePollResult =
  | { status: 'ready'; fileUrl: string }
  | { status: 'pending' }
  | { status: 'failed'; detail: string }

export interface ImageGenerator {
  submit(input: ImageGenerationInput): Promise<ImageJobRef>
  poll(jobRef: ImageJobRef): Promise<ImagePollResult>
}

export interface ImageValidationInput {
  /** The already-uploaded, permanent scene_image URL — never the provider's
   *  own temporary generation URL, so this survives past that URL's TTL. */
  imageUrl: string
  visualDescription: string
  shotNotes?: string | null
}

export interface ImageValidationResult {
  pass: boolean
  /** Short, human-readable phrases, one per real defect found — empty when
   *  pass is true. Feeds directly into generateSceneVisual.ts's targeted
   *  correction prompt for the next attempt, so these should read as
   *  something a regeneration instruction can act on (e.g. "unexplained
   *  hand on the right side of frame"), not a generic verdict. */
  issues: string[]
  /** Defects the validator reported but that did NOT count toward a
   *  rejection (minor severity, or not high confidence) — recorded for
   *  observability only, never fed into a regeneration. */
  ignoredIssues?: string[]
}

/**
 * Lightweight vision-based QA gate, run once per scene image, right after
 * generation and before that scene's video clip is ever submitted (see
 * generateSceneVisual.ts's runSceneImageStep) — catches the specific class
 * of defect a well-planned scene prompt can still produce: unexpected
 * people, unexplained/disembodied hands, duplicate limbs, floating or
 * unexplained objects, a missing required subject, major object
 * inconsistency, or an obviously illogical scene. Optional on every call
 * site that takes one (runSceneImageStep/runGenerateSceneVisual) — a caller
 * that omits it (every existing test, unless it opts in) just skips this
 * quality gate entirely, exactly like before it existed.
 */
export interface ImageValidator {
  validate(input: ImageValidationInput): Promise<ImageValidationResult>
}

// ─── Video-only adapters (M0 of the video migration) ───────────────────────

export interface VoiceSynthesisInput {
  text: string
  voiceId: string
}

export interface VoiceSynthesisResult {
  audioBuffer: Buffer
  /** ElevenLabs' TTS call is synchronous — there is no job id to poll, so
   *  this is just the request id from the response headers, kept for
   *  logging/pipeline_steps.output_snapshot, not for a future poll() call. */
  providerRef: string
}

/** ElevenLabs' text-to-speech endpoint returns audio bytes directly in the
 *  response — no submit/poll split, unlike every other adapter here. Forcing
 *  a job-ref shape onto a synchronous call would be manufactured complexity. */
export interface VoiceSynthesizer {
  synthesize(input: VoiceSynthesisInput): Promise<VoiceSynthesisResult>
}

export interface TranscriptionInput {
  audioUrl: string
}

export interface TranscriptionJobRef {
  providerRef: string
}

export type TranscriptionPollResult =
  | {
      status: 'ready'
      timingData: unknown
      text: string
      /** The REAL measured duration of this scene's audio file, straight
       *  from the transcription provider (AssemblyAI's own `audio_duration`
       *  field, in ms here) — not synthesizeVoice.ts's word-count ESTIMATE
       *  (video_scene_audio.duration_ms). transcribeAudio.ts uses this to
       *  offset the NEXT scene's caption timestamps, so captions drift back
       *  in sync with the real per-scene audio files that get concatenated
       *  at render time, instead of accumulating estimate-vs-reality error
       *  scene over scene. Optional/undefined for any provider or mock that
       *  doesn't report it — transcribeAudio.ts falls back to the estimate
       *  in that case, same as before this field existed. */
      audioDurationMs?: number
    }
  | { status: 'pending' }
  | { status: 'failed'; detail: string }

export interface TranscriptionService {
  submit(input: TranscriptionInput): Promise<TranscriptionJobRef>
  poll(jobRef: TranscriptionJobRef): Promise<TranscriptionPollResult>
}

export interface VideoGenerationInput {
  prompt: string
  /** The scene's already-generated scene_image asset — KIE.ai's
   *  image-to-video model animates FROM this frame, which is what keeps the
   *  character/likeness consistent (it was already locked by Flux Kontext's
   *  character-ref editing at the image stage, not re-derived here). */
  referenceImageUrl: string
  /** '5' or '10' seconds — a Kling-2.6-era constraint (that model only
   *  accepted those two values) lib/sceneClipDuration.ts's pickClipDurationSeconds
   *  still buckets into, even now that KieVideoGenerator targets a
   *  different model (see kie.ts) that would accept an arbitrary duration;
   *  keeping the bucketing means swapping the underlying model doesn't also
   *  require touching the scene-duration-picking logic. */
  durationSeconds: '5' | '10'
  /** content_jobs.aspect_ratio, the same value already sent to Flux
   *  Kontext for character-ref/scene-image generation. Kling never needed
   *  this (it inherited the shape of whatever frame it animated), but
   *  Seedance 1.5 Pro requires an explicit `aspect_ratio` input — see
   *  kie.ts's KieVideoGenerator header. */
  aspectRatio: '9:16' | '1:1' | '16:9'
}

export interface VideoJobRef {
  providerRef: string
}

export type VideoPollResult =
  | { status: 'ready'; fileUrl: string }
  | { status: 'pending' }
  | { status: 'failed'; detail: string }

export interface VideoGenerator {
  submit(input: VideoGenerationInput): Promise<VideoJobRef>
  poll(jobRef: VideoJobRef): Promise<VideoPollResult>
}

export interface AVMergeInput {
  /** Ordered per-scene (video clip, audio) pairs. synthesizeVoice.ts
   *  produces one audio file PER SCENE, never one combined track-level
   *  file, so there's no standalone pre-combined audio track to hand over —
   *  the clip/audio pairing here is just "which files belong to which
   *  scene," concatenated independently per-track (video-only, audio-only —
   *  see avMerger.ts's buildVideoConcatCommand/buildAudioConcatCommand),
   *  NOT interleaved into one mixed concat. An earlier version concatenated
   *  video and audio together in a single filter; confirmed live
   *  2026-09-12 that this truncates the resulting audio to ~2 seconds
   *  regardless of scene count or real audio length. */
  scenes: Array<{ clipUrl: string; audioUrl: string }>
}

export interface AVMergeJobRef {
  providerRef: string
}

export type AVMergeResult =
  // fileBuffer, not fileUrl: unlike KIE.ai's plain public URLs, upload-post.com's
  // download endpoint requires the same `Apikey` auth header as every other
  // call to it — handing back a bare URL would leak that requirement into
  // every caller. The adapter downloads it itself and returns the bytes.
  | { status: 'ready'; fileBuffer: Buffer }
  | { status: 'pending' }
  | { status: 'failed'; detail: string }

/** Wraps upload-post.com's FFmpeg Editor API (confirmed against
 *  docs.upload-post.com 2026-09-12). Unlike every other adapter here, the
 *  provider doesn't know how to "merge scenes with audio" — it executes a
 *  raw ffmpeg command string the caller builds. See avMerger.ts's
 *  buildVideoConcatCommand/buildAudioConcatCommand/buildMuxCommand/
 *  buildCaptionCommand for that logic, tested independently of the HTTP
 *  call.
 *
 *  Multi-pass by necessity, not by choice, for two independent reasons:
 *  (1) upload-post.com's API rejects any ';' in full_command (part of a
 *  fixed command-injection denylist), and burning captions into a
 *  concatenated multi-scene video requires routing concat's two named
 *  outputs (video, audio) to different downstream filters, which ffmpeg's
 *  filtergraph grammar can only express with a ';'-separated filterchain —
 *  so caption burn-in (submitCaptionBurn) is always its own pass, over the
 *  single merged file, via -vf (a linear chain that never needs ';').
 *  (2) concatenating video and audio TOGETHER in one mixed v=1:a=1 concat
 *  filter — what an earlier version of this did in a single submit() call —
 *  silently truncates the resulting audio to ~2 seconds regardless of
 *  scene count (confirmed live 2026-09-12), so video and audio are instead
 *  concatenated INDEPENDENTLY (submitVideoConcat/submitAudioConcat) and
 *  reunited by a fade-to-black/silence remux (submitMux). See
 *  renderLanguageTrack.ts for the full orchestration (including the temp
 *  re-uploads needed between passes, since this provider's `files` field
 *  takes fetchable URLs, not raw bytes). */
export interface AVMerger {
  submitVideoConcat(input: AVMergeInput): Promise<AVMergeJobRef>
  submitAudioConcat(input: AVMergeInput): Promise<AVMergeJobRef>
  /** videoUrl/audioUrl are submitVideoConcat's/submitAudioConcat's own
   *  outputs, re-hosted by the caller so this provider can fetch them as
   *  plain input files. totalDurationSeconds is the track's real total
   *  narration length (sum of every scene's real audio duration) — see
   *  avMerger.ts's buildMuxCommand for why it's needed (fades the last
   *  ~0.6s to black/silence, the deterministic half of the "abrupt
   *  ending" fix). */
  submitMux(videoUrl: string, audioUrl: string, totalDurationSeconds: number): Promise<AVMergeJobRef>
  /** Only ever called when there are caption cues to burn in — a render
   *  with no captions stops after the mux pass (its output IS the final
   *  render). mergedVideoUrl is the mux pass's output; assFileUrl is the
   *  caller's own upload of buildCaptionAssFile's generated ASS subtitle
   *  content (see avMerger.ts's buildCaptionAssFile for why caption text
   *  lives in an uploaded FILE here, not inline in the command string —
   *  2026-09-21, a real render was rejected by upload-post.com's command
   *  filter over an ordinary narration word). Both URLs re-hosted by the
   *  caller so this provider can fetch them as plain input files. */
  submitCaptionBurn(mergedVideoUrl: string, assFileUrl: string): Promise<AVMergeJobRef>
  /** Matches ONE scene's shared video clip to the CALLING track's real
   *  narration length (hold last frame / trim — see avMerger.ts's
   *  buildSceneDurationMatchCommand) before that scene's clip is fed into
   *  submitVideoConcat. Deliberately on THIS interface, not
   *  SceneClipScaler — this runs from renderLanguageTrack.ts, at render
   *  time, per language track; SceneClipScaler's downscale runs from
   *  generateSceneVisual.ts, once per shared clip, right after KIE.ai
   *  generates it. Keeping them on separate interfaces documents which
   *  step actually uses which capability, same reasoning SceneClipScaler's
   *  own header gives for being split from this interface in the first
   *  place.
   *
   *  No `currentDurationSeconds` parameter (removed 2026-09-21) — the clip's
   *  real input length is deliberately never assumed here; see
   *  buildSceneDurationMatchCommand's header for the caption/audio desync
   *  this fixed. */
  submitSceneDurationMatch(clipUrl: string, targetDurationSeconds: number): Promise<AVMergeJobRef>
  poll(jobRef: AVMergeJobRef): Promise<AVMergeResult>
}

/**
 * Downscales a single scene clip to its aspect ratio's standard delivery
 * resolution — one input, one simple `-vf scale=` chain, no concat, so it
 * can never need a ';' regardless of target size. A separate, narrower
 * interface from AVMerger even though UploadPostAVMerger implements both:
 * this is called from generateSceneVisual.ts (right after KIE.ai generates
 * each scene's clip), never from renderLanguageTrack.ts — keeping the two
 * capabilities in separate interfaces means a step's dependency list
 * documents which capability it actually uses, the same reasoning
 * ImageGenerator/VideoGenerator/AVMerger are already split apart instead of
 * one do-everything interface.
 *
 * Exists to keep concatenated/rendered output within Supabase Storage's
 * project-wide file size limit without a perceptible quality loss: Flux
 * Kontext/Seedance's native output for a given aspect ratio already targets
 * roughly the right pixel budget (kie.ts's own aspectRatio param), but can
 * still land a bit over it — confirmed live 2026-09-13, a real 8-scene
 * 9:16 render's un-downscaled clips summed to 140.6MB and failed to
 * re-upload for the mux pass. Downscaling to the exact resolution nothing
 * downstream (TikTok/Reels/Shorts, or this app's own preview players) ever
 * displays past is free size reduction, not a quality tradeoff.
 */
export interface SceneClipScaler {
  submitScale(videoUrl: string, width: number, height: number): Promise<AVMergeJobRef>
  poll(jobRef: AVMergeJobRef): Promise<AVMergeResult>
}

// ─── Social publishing (replaces n8n's social branch — ARCHITECTURE.MD §2.5) ─

/** Matches src/types/content.ts's PlatformType (the app only ever lets a
 *  user pick from these three) — upload-post.com itself supports many more
 *  platforms, but nothing in this codebase ever selects them. */
export type SocialPlatform = 'instagram' | 'facebook' | 'twitter'

export interface SocialPublishInput {
  /** 'video' → POST /api/upload; 'image_post'/'blog' → POST /api/upload_photos
   *  (confirmed live 2026-09-17 via docs.upload-post.com's OpenAPI spec —
   *  see socialPublisher.ts's header for what's confirmed vs. assumed). */
  contentType: 'video' | 'image_post' | 'blog'
  platforms: SocialPlatform[]
  caption: string
  hashtags: string[]
  /** Publicly fetchable URL of the already-rendered/generated asset
   *  (generated_content.file_url) — upload-post.com accepts a public URL
   *  in place of a raw file upload for both /api/upload and
   *  /api/upload_photos. */
  mediaUrl: string
}

/** upload-post.com's own request_id (async path) or job_id (scheduled
 *  path) — see socialPublisher.ts. Stored as social_platform_logs.provider_job_ref. */
export type SocialPublishJobRef =
  | { kind: 'request'; requestId: string }
  | { kind: 'job'; jobId: string }

export interface SocialPlatformOutcome {
  platform: SocialPlatform
  success: boolean
  url?: string
  error?: string
}

export type SocialPublishOutcome =
  | { status: 'ready'; perPlatform: SocialPlatformOutcome[] }
  | { status: 'pending'; jobRef: SocialPublishJobRef }
  | { status: 'failed'; detail: string }

export type SocialPublishPollResult =
  | { status: 'ready'; perPlatform: SocialPlatformOutcome[] }
  | { status: 'pending' }
  | { status: 'failed'; detail: string }

/** Wraps upload-post.com's publish API (docs.upload-post.com, confirmed
 *  live 2026-09-17 — see socialPublisher.ts's header for exactly what was
 *  and wasn't confirmed against the real OpenAPI spec). Unlike every other
 *  adapter here, a single call can resolve synchronously (small/fast
 *  uploads) OR return a request_id/job_id to poll (uploads over ~59s, or
 *  explicitly scheduled) — publish()'s return type reflects both outcomes
 *  instead of forcing every caller through a poll loop even when the
 *  provider already had the answer. */
export interface SocialPublisher {
  publish(input: SocialPublishInput): Promise<SocialPublishOutcome>
  poll(jobRef: SocialPublishJobRef): Promise<SocialPublishPollResult>
}

