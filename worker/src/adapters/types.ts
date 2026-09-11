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
  /** Ordered per-scene (video clip, audio) pairs, concatenated in order.
   *  No standalone audio-concatenation service exists (synthesizeVoice.ts
   *  produces one audio file PER SCENE, never one combined track-level
   *  file) — pairing each clip with its own scene's audio here, and
   *  concatenating pairs together (not video-then-audio separately), is
   *  what produces a properly synced render without needing one. */
  scenes: Array<{ clipUrl: string; audioUrl: string }>
  /** Caption timing data (from TranscriptionPollResult.timingData, already
   *  combined across scenes with cumulative offsets by transcribeAudio.ts)
   *  — used to build the ffmpeg drawtext filter for burned-in captions.
   *  Optional: a render with no captions burned in is still a valid render. */
  captionTimingData?: unknown
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
 *  buildFfmpegCommand for that logic, tested independently of the HTTP call. */
export interface AVMerger {
  submit(input: AVMergeInput): Promise<AVMergeJobRef>
  poll(jobRef: AVMergeJobRef): Promise<AVMergeResult>
}
