// Provider adapter interfaces — ARCHITECTURE.MD §8. Business logic (worker
// steps) depends only on these, never on a provider SDK/HTTP client directly.

export class ProviderCallError extends Error {
  constructor(
    public readonly provider: string,
    public readonly httpStatus: number | null,
    public readonly detail: string,
  ) {
    super(`${provider} call failed (status ${httpStatus ?? 'n/a'}): ${detail}`)
    this.name = 'ProviderCallError'
  }
}

export interface ScriptGenerationInput {
  systemPrompt: string
  userPrompt: string
  model?: string
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
   * A real photo of the branded subject (e.g. the Fresh-CAN truck) for
   * Flux Kontext's image-editing mode — the model edits/extends from this
   * instead of hallucinating the truck's appearance from a text description
   * alone. Flux Kontext's `inputImage` field accepts exactly one URL (see
   * docs.kie.ai/flux-kontext-api/generate-or-edit-image, confirmed
   * 2026-09-10) — never an array.
   */
  referenceImageUrl?: string
  /**
   * Passed straight through to Flux Kontext's own `aspectRatio` param.
   * Video-only (content_jobs.aspect_ratio, supabase/migrations/
   * 20260912120000) — blog/image_post callers never set this and get the
   * adapter's '1:1' default, unchanged from before this field existed.
   * Kling image-to-video (KieVideoGenerator) has no aspect-ratio param of
   * its own — it inherits the shape of whatever reference image it
   * animates, so setting this on character-ref/scene-image generation is
   * sufficient to get matching video clips too.
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
  | { status: 'ready'; timingData: unknown; text: string }
  | { status: 'pending' }
  | { status: 'failed'; detail: string }

export interface TranscriptionService {
  submit(input: TranscriptionInput): Promise<TranscriptionJobRef>
  poll(jobRef: TranscriptionJobRef): Promise<TranscriptionPollResult>
}

export interface VideoGenerationInput {
  prompt: string
  /** The scene's already-generated scene_image asset — KIE.ai's Kling
   *  image-to-video model animates FROM this frame, which is what keeps the
   *  character/likeness consistent (it was already locked by Flux Kontext's
   *  character-ref editing at the image stage, not re-derived here). */
  referenceImageUrl: string
  /** Kling 2.6 only accepts "5" or "10" (seconds) — callers must round the
   *  scene's target_duration_ms to the nearest allowed value. */
  durationSeconds: '5' | '10'
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
 *  reunited by a plain -c copy remux (submitMux). See renderLanguageTrack.ts
 *  for the full orchestration (including the temp re-uploads needed
 *  between passes, since this provider's `files` field takes fetchable
 *  URLs, not raw bytes). */
export interface AVMerger {
  submitVideoConcat(input: AVMergeInput): Promise<AVMergeJobRef>
  submitAudioConcat(input: AVMergeInput): Promise<AVMergeJobRef>
  /** videoUrl/audioUrl are submitVideoConcat's/submitAudioConcat's own
   *  outputs, re-hosted by the caller so this provider can fetch them as
   *  plain input files. */
  submitMux(videoUrl: string, audioUrl: string): Promise<AVMergeJobRef>
  /** Only ever called when there are caption cues to burn in — a render
   *  with no captions stops after the mux pass (its output IS the final
   *  render). mergedVideoUrl is the mux pass's output, re-hosted by the
   *  caller so this provider can fetch it as a plain input file. */
  submitCaptionBurn(mergedVideoUrl: string, captionTimingData: unknown): Promise<AVMergeJobRef>
  poll(jobRef: AVMergeJobRef): Promise<AVMergeResult>
}

