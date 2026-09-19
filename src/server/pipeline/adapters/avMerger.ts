import { ASPECT_RATIO_RESOLUTIONS } from '../lib/videoResolution'
import { uploadPostSubmitLimiter } from '../lib/uploadPostRateLimiter'
import {
  ProviderCallError,
  type AVMerger,
  type AVMergeInput,
  type AVMergeJobRef,
  type AVMergeResult,
  type SceneClipScaler,
} from './types'

interface CaptionCue {
  text: string
  startMs: number
  endMs: number
}

// Same fontsize expression buildCaptionCommand burns in (fraction of frame
// HEIGHT, so it scales correctly across all three delivery resolutions —
// see that function's own header). Needed here too so chunking can budget
// each line's WIDTH against the same font size the render will actually use.
const CAPTION_FONTSIZE_RATIO = 0.033

// A generous (i.e. safety-biased) estimate of a Latin sans-serif
// character's average rendered width, as a fraction of its fontsize —
// mixed-case proportional fonts average closer to ~0.5, but this errs high
// on purpose: UNDER-estimating capacity just wraps one word earlier than
// strictly necessary (harmless), while OVER-estimating it is exactly the
// bug that let lines run off both edges of the frame (see the real
// generation this fixes — a caption clipped on both sides of a 9:16
// frame). ffmpeg's drawtext has no API to ask it for a real measurement
// ahead of time, so this heuristic is deliberately conservative rather
// than tuned to look tight.
const AVG_CHAR_WIDTH_RATIO = 0.62

// Leaves a real margin on each side rather than packing lines edge-to-edge
// — both because the width heuristic above is an estimate, not a
// measurement, and because text flush against the frame edge reads as a
// mistake even when it technically still fits.
const SAFE_WIDTH_FRACTION = 0.86

function estimatedTextWidthPx(text: string, fontSizePx: number): number {
  return text.length * fontSizePx * AVG_CHAR_WIDTH_RATIO
}

/** AssemblyAI word objects (see assemblyai.ts's TranscriptionPollResult.timingData)
 *  grouped into short caption lines. `captionTimingData` is typed `unknown` at
 *  the interface boundary since it crosses from one adapter's output to
 *  another's input — anything not shaped like a word array is treated as
 *  "no captions" rather than a hard error, since a render without burned-in
 *  captions is still a valid render.
 *
 * Chunking is WIDTH-aware, not a fixed word count (was `wordsPerLine = 7`
 * until 2026-09-19) — a real render came back with a caption line clipped
 * off both the left and right edges of a 9:16 frame: 7 words was sometimes
 * far too wide (long words like "struggle"/"partners"), and nothing ever
 * checked the actual rendered width against the frame. `frameWidthPx` lets
 * the caller pass the REAL pixel width the caption will render at (see
 * buildCaptionCommand), so the same word list wraps into more/shorter
 * lines on a narrow 9:16 frame than on a wide 16:9 one. Falls back to a
 * fixed word count only when no frame width is known (kept for callers/
 * tests that don't care about exact wrapping). */
export function normalizeCaptionCues(
  timingData: unknown,
  frameWidthPx?: number,
  fontSizePx?: number,
): CaptionCue[] {
  if (!Array.isArray(timingData)) return []
  const words = timingData.filter(
    (w): w is { text: unknown; start: unknown; end: unknown } =>
      typeof w === 'object' && w !== null && 'text' in w && 'start' in w && 'end' in w,
  )
  if (words.length === 0) return []

  const maxLineWidthPx = frameWidthPx ? frameWidthPx * SAFE_WIDTH_FRACTION : undefined
  const fallbackWordsPerLine = 7

  const cues: CaptionCue[] = []
  let chunk: typeof words = []
  let chunkText = ''

  const flush = () => {
    if (chunk.length === 0) return
    const startMs = Number(chunk[0]?.start)
    const endMs = Number(chunk[chunk.length - 1]?.end)
    if (chunkText && Number.isFinite(startMs) && Number.isFinite(endMs)) {
      cues.push({ text: chunkText, startMs, endMs })
    }
    chunk = []
    chunkText = ''
  }

  for (const w of words) {
    const word = String(w.text)
    if (!maxLineWidthPx || !fontSizePx) {
      // No real frame width known — fall back to the old fixed-count
      // behavior rather than guessing at a width budget with nothing to
      // size it against.
      chunk.push(w)
      chunkText = chunkText ? `${chunkText} ${word}` : word
      if (chunk.length >= fallbackWordsPerLine) flush()
      continue
    }

    const candidateText = chunkText ? `${chunkText} ${word}` : word
    // A single word wider than the whole safe budget on its own (a long
    // URL, a long name) still has to go out as its own line — there's no
    // narrower unit to fall back to — but every other word waits for the
    // next line rather than joining an already-full one.
    if (chunk.length > 0 && estimatedTextWidthPx(candidateText, fontSizePx) > maxLineWidthPx) {
      flush()
      chunk.push(w)
      chunkText = word
    } else {
      chunk.push(w)
      chunkText = candidateText
    }
  }
  flush()

  return cues
}

/** Escapes text for ffmpeg's drawtext filter, per ffmpeg's own escaping
 *  rules for text wrapped in single quotes inside a filtergraph string.
 *
 *  CONFIRMED BROKEN against a real render (2026-09-19): the single-quote
 *  replacement had an extra backslash — `'\\''` (two backslashes) instead
 *  of ffmpeg's actual documented close-escape-reopen sequence `'\''` (one
 *  backslash, the same trick POSIX shells use to embed an apostrophe in a
 *  single-quoted string). With the extra backslash, any narration
 *  containing a real apostrophe (e.g. "Fresh-CAN's", "farmer's") never
 *  properly closed and reopened the quote — ffmpeg kept reading raw
 *  filter syntax as literal quoted text from that point on, which is
 *  exactly why a real caption showed literal `:fontcolor=white:fontsize=
 *  h*0.033:x=(w-text_w)/2:y=h-h*0.083:box=1:...:enable=between(t,...)`
 *  burned into the frame as visible text instead of being applied as
 *  drawtext options. Fixed to the correct single-backslash sequence. */
function escapeDrawtextValue(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''")
}

/**
 * Builds the ffmpeg command for the VIDEO-ONLY half of the concat pass —
 * just the scene clips' video streams, concatenated, no audio at all
 * (v=1:a=0).
 *
 * This used to be one command that concatenated video AND audio together
 * in a single mixed `v=1:a=1` concat (interleaved [clip][audio] pairs).
 * That approach is broken: confirmed live 2026-09-12 against a real render
 * (2 scenes, ~5s clip + ~5.2s audio each) that the mixed concat's OUTPUT
 * audio was truncated to ~1.95s regardless — nowhere near either scene's
 * real audio length, let alone their sum — while the video side came out
 * fully correct (~10.3s). Splitting video and audio into two INDEPENDENT
 * concat filters (this function + buildAudioConcatCommand below), each
 * muxed together afterward (buildMuxCommand), produces full-length audio
 * every time — verified against the same real files (video 10.08s, audio
 * 10.31s, muxed final 10.08s after -shortest). Root cause on
 * upload-post.com's side isn't confirmed (their concat implementation
 * presumably mishandles a mixed v=1:a=1 graph over independently-sourced,
 * not-frame-aligned video+audio pairs), but the split-then-mux workaround
 * is a solid, empirically-verified fix regardless of the exact mechanism.
 */
export function buildVideoConcatCommand(scenes: AVMergeInput['scenes']): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const sceneCount = scenes.length
  if (sceneCount === 0) {
    throw new Error('buildVideoConcatCommand: at least one scene is required')
  }

  const files = scenes.map((scene) => scene.clipUrl)
  const concatInputs = scenes.map((_, i) => `[${i}:v]`).join('')
  const filterComplex = `${concatInputs}concat=n=${sceneCount}:v=1:a=0[vout]`
  const inputArgs = files.map((_, i) => `-i {input${i}}`).join(' ')
  // -preset ultrafast: this pass decodes+re-encodes every real scene clip
  // (concat is a filter, not a stream copy — it forces a full decode), the
  // heaviest CPU work in the whole render. upload-post.com's job for a
  // real 7-scene render was observed to vanish (subsequent status poll
  // 404s, never an ERROR status) at a consistent ~9min mark on two
  // separate attempts — a fixed processing-time ceiling on their side, not
  // random flakiness (retrying the identical job just times out the same
  // way again). Trading libx264's default 'medium' preset for 'ultrafast'
  // is the safest lever to claw back margin without touching the
  // filtergraph shape.
  //
  // -b:v/-maxrate/-bufsize (3500k), not -crf: CRF targets a QUALITY level,
  // not a file size — it gives no ceiling on output size at all. A real
  // 8-scene render's un-downscaled clips (native ~2MP, no bitrate cap
  // anywhere) summed to 140.6MB and failed to re-upload past Supabase
  // Storage's global upload size limit; buildScaleCommand's per-clip
  // downscale (see that function's header) fixed THAT case, but a real
  // 9-scene/90s script at CRF 23 — still within the 4-10 scene range
  // composeVideoScriptSystemPrompt allows — hit the exact same failure
  // again post-downscale (confirmed live 2026-09-13/14), because CRF's
  // output size scales with content complexity as much as duration, not
  // just pixel count. 3500kbps bounds size by DURATION instead: even the
  // documented worst case (10 scenes x 10s = 100s) tops out at ~43.75MB,
  // leaving headroom under Supabase's global limit (confirmed empirically
  // at 50-52MB) for the AAC audio track this gets muxed with afterward.
  // Empirically confirmed against real Supabase Storage responses: 50MB
  // uploads succeed, 52MB fails with this exact "object exceeded the
  // maximum allowed size" error.
  const fullCommand = `ffmpeg -y ${inputArgs} -filter_complex "${filterComplex}" -map "[vout]" -c:v libx264 -preset ultrafast -b:v 3500k -maxrate 3500k -bufsize 7000k {output}`

  return { files, fullCommand, outputExtension: 'mp4' }
}

/**
 * Builds the ffmpeg command for the AUDIO-ONLY half of the concat pass —
 * just the scene narration files, concatenated, no video (v=0:a=1). See
 * buildVideoConcatCommand's header for why this is split out from video
 * rather than concatenated together in one mixed filter.
 */
export function buildAudioConcatCommand(scenes: AVMergeInput['scenes']): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const sceneCount = scenes.length
  if (sceneCount === 0) {
    throw new Error('buildAudioConcatCommand: at least one scene is required')
  }

  const files = scenes.map((scene) => scene.audioUrl)
  const concatInputs = scenes.map((_, i) => `[${i}:a]`).join('')
  const filterComplex = `${concatInputs}concat=n=${sceneCount}:v=0:a=1[aout]`
  const inputArgs = files.map((_, i) => `-i {input${i}}`).join(' ')
  const fullCommand = `ffmpeg -y ${inputArgs} -filter_complex "${filterComplex}" -map "[aout]" -c:a aac {output}`

  return { files, fullCommand, outputExtension: 'mp4' }
}

/**
 * Builds the ffmpeg command that muxes the (independently concatenated)
 * video-only and audio-only outputs back into one file — a plain `-c copy`
 * remux, no filtergraph at all, so it can never need a ';' regardless.
 * `-shortest` here is meaningful (unlike it apparently being a no-op in the
 * old mixed-concat command): video and audio come from two genuinely
 * separate encodes that can differ by a fraction of a second, and this is
 * the single place that reconciles them into one final duration.
 */
export function buildMuxCommand(videoUrl: string, audioUrl: string): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const fullCommand = `ffmpeg -y -i {input0} -i {input1} -c copy -shortest {output}`
  return { files: [videoUrl, audioUrl], fullCommand, outputExtension: 'mp4' }
}

/**
 * Picks the fontsize ratio (of frame height, same unit buildCaptionCommand
 * renders at) for ONE cue. Normally this is just the shared
 * CAPTION_FONTSIZE_RATIO every cue uses — but normalizeCaptionCues can still
 * emit a cue wider than the safe budget in exactly one case: a single
 * "word" (a long URL, a long name) with nothing narrower to fall back to.
 * Rather than let that one cue overflow the frame the way the original bug
 * did, shrink ONLY that cue's fontsize by exactly the ratio needed to bring
 * its estimated width back within budget — computed here in plain JS
 * (never as an ffmpeg-side expression/min(), which would need an escaped
 * comma in the filter string — see escapeDrawtextValue's own "not
 * independently verified" flag; not worth that additional escaping risk for
 * a rare edge case).
 */
function fontsizeRatioFor(text: string, baseFontSizePx: number, maxLineWidthPx: number): string {
  const estimatedWidthPx = estimatedTextWidthPx(text, baseFontSizePx)
  if (estimatedWidthPx <= maxLineWidthPx) return String(CAPTION_FONTSIZE_RATIO)
  return (CAPTION_FONTSIZE_RATIO * (maxLineWidthPx / estimatedWidthPx)).toFixed(4)
}

/**
 * Builds the raw ffmpeg command string for the CAPTION-BURN pass: a single
 * input (the mux pass's output), burning in drawtext cues via `-vf`
 * (ffmpeg's *simple* filtergraph — a linear ','-chain with no named pads at
 * all), while the audio stream is passed straight through with `-c:a copy`.
 * Because `-vf` never needs bracket-labeled pads, this command structurally
 * cannot require a ';' regardless of how many caption cues there are — see
 * buildVideoConcatCommand's header for why avoiding ';' matters here too
 * (upload-post.com's full_command denylist).
 *
 * Caller is expected to skip this pass entirely when there are no cues
 * (normalizeCaptionCues(...).length === 0) — the mux pass's own output is
 * already a valid final render in that case.
 *
 * `aspectRatio` (added 2026-09-19, default '9:16' matching the rest of the
 * pipeline) resolves to the job's REAL delivery resolution
 * (ASPECT_RATIO_RESOLUTIONS — the exact pixel size every scene clip is
 * already downscaled to before this pass ever runs), which is what lets
 * normalizeCaptionCues wrap lines against the actual frame width instead of
 * a fixed word count. Fixes a real generation where a caption line ran off
 * both the left and right edges of a 9:16 frame: the old `wordsPerLine = 7`
 * chunking had no idea how wide the frame was or how wide 7 words would
 * render, so a line of long words (e.g. "...struggle. FreshCan partners
 * wi...") simply overflowed with nothing to stop it.
 */
export function buildCaptionCommand(
  mergedVideoUrl: string,
  captionTimingData: unknown,
  aspectRatio: '9:16' | '1:1' | '16:9' = '9:16',
): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const { width: frameWidthPx, height: frameHeightPx } = ASPECT_RATIO_RESOLUTIONS[aspectRatio]
  const baseFontSizePx = frameHeightPx * CAPTION_FONTSIZE_RATIO
  const maxLineWidthPx = frameWidthPx * SAFE_WIDTH_FRACTION

  const cues = normalizeCaptionCues(captionTimingData, frameWidthPx, baseFontSizePx)
  if (cues.length === 0) {
    throw new Error('buildCaptionCommand: no caption cues to burn in — caller should skip this pass')
  }

  // fontsize/y as fractions of frame height (drawtext evaluates these as
  // expressions, not just plain ints), not fixed pixel values — this used
  // to be a hardcoded fontsize=48/y=h-120, tuned by eye against the square
  // 1440x1440 frames every render produced before aspect ratio became
  // selectable (worker/src/adapters/kie.ts's aspectRatio param). Fixed
  // pixels only looked right at that one frame height; a 9:16 (1080x1920)
  // or 16:9 (1920x1080) render would get disproportionately tiny/huge text
  // and a bottom margin that's too close to or too far from the edge. The
  // fractions below (0.033/0.083) are exactly what 48px/120px worked out
  // to at h=1440, so the square case looks identical and every other
  // aspect ratio now scales correctly too.
  const drawtextFilters = cues.map((cue) => {
    const startSec = (cue.startMs / 1000).toFixed(2)
    const endSec = (cue.endMs / 1000).toFixed(2)
    const text = escapeDrawtextValue(cue.text)
    const fontsizeRatio = fontsizeRatioFor(cue.text, baseFontSizePx, maxLineWidthPx)
    return (
      `drawtext=text='${text}':fontcolor=white:fontsize=h*${fontsizeRatio}:` +
      `x=(w-text_w)/2:y=h-h*0.083:box=1:boxcolor=black@0.5:boxborderw=10:` +
      `enable='between(t,${startSec},${endSec})'`
    )
  })
  const vf = drawtextFilters.join(',')

  // Same -preset ultrafast rationale as buildConcatCommand — this pass also
  // re-encodes the full video stream (drawtext forces it), just over one
  // input instead of several. Same -b:v/-maxrate/-bufsize bitrate cap as
  // buildVideoConcatCommand too, and for the same reason: this pass's
  // OUTPUT is the final render uploaded to Supabase Storage, so a CRF-only
  // re-encode here could re-inflate a video-concat pass that was correctly
  // size-bounded going in.
  //
  // {input}, not {input0}: confirmed live 2026-09-12 that upload-post.com's
  // backend rejects a single-file full_command containing an indexed
  // placeholder — it calls a single-input code path (_full_cmd(cmd,
  // fin_list[0], fout)) that does literal string substitution on the bare
  // {input}/{output} tokens, and raises "full_command debe contener
  // {input} y {output}" (a ValueError, not a timeout) if {input0} is used
  // instead. Only relevant for exactly one file — buildConcatCommand's
  // multi-file {input0}/{input1}/... indexing is a different, working code
  // path on their side.
  const fullCommand = `ffmpeg -y -i {input} -vf "${vf}" -c:v libx264 -preset ultrafast -b:v 3500k -maxrate 3500k -bufsize 7000k -c:a copy {output}`

  return { files: [mergedVideoUrl], fullCommand, outputExtension: 'mp4' }
}

/**
 * Builds the ffmpeg command for downscaling ONE scene clip to its aspect
 * ratio's standard social-delivery resolution — 1080x1920 (9:16),
 * 1080x1080 (1:1), or 1920x1080 (16:9), matched to whatever the job's
 * content_jobs.aspect_ratio selected (worker/src/adapters/kie.ts's own
 * aspectRatio param already requests this shape from Flux Kontext/Kling,
 * but their native output can still land slightly above it — e.g. a real
 * 9:16 clip came back at 1084x1912, and a 1:1 one at 1440x1440, both
 * modestly over their ~2-megapixel-budget target). A single input, single
 * linear `-vf scale=` chain, so — like buildCaptionCommand — it
 * structurally can never need a ';' regardless of target size.
 *
 * {input}, not {input0}: same single-file rule buildCaptionCommand's
 * header documents — confirmed live 2026-09-12 that upload-post.com's
 * single-input code path rejects an indexed placeholder outright
 * (ValueError, not a timeout). An EARLIER version of this same downscale
 * step existed, used `{input0}`, and was removed after every attempt
 * crashed on exactly that mismatch (worker/src/steps/video/
 * generateSceneVisual.ts's history) — reintroducing it with the bare
 * `{input}` this file's other single-input commands already use.
 */
export function buildScaleCommand(
  videoUrl: string,
  width: number,
  height: number,
): { files: string[]; fullCommand: string; outputExtension: string } {
  // -an: KIE.ai's scene clips are generated with sound=false (no audio
  // stream at all — see kie.ts) — dropping audio explicitly rather than
  // assuming there's none to carry through. -crf 23: same "make the
  // existing default explicit" reasoning as buildVideoConcatCommand — the
  // downscale itself (fewer pixels in) is what actually shrinks the file;
  // this isn't lowering the quality target.
  const fullCommand = `ffmpeg -y -i {input} -vf "scale=${width}:${height}" -c:v libx264 -preset ultrafast -crf 23 -an {output}`
  return { files: [videoUrl], fullCommand, outputExtension: 'mp4' }
}

/**
 * Matches ONE scene's shared video clip to THIS language track's real
 * narration length — holding the last frame if the clip is shorter than
 * the audio, trimming if it's longer. This is the render-time
 * reconciliation ARCHITECTURE.MD §4.2 always called for ("the render step
 * handles per-scene sync by holding the last frame... or trimming
 * trailing silence...") but that was never actually implemented — video
 * clips are generated at a fixed, quantized duration (5 or 10s, matched
 * to the shared script's own target_duration_seconds BUDGET, see
 * lib/sceneClipDuration.ts's pickClipDurationSeconds) before any language's
 * real narration exists, so a clip almost never matches a specific
 * language's real audio length exactly. Confirmed live (2026-09-19): a
 * real 7-scene render's total video length (35s, all 5s clips) drifted
 * 7.4s short of its real total audio length (42.4s) — the final mux
 * pass's `-shortest` was silently truncating the last ~7.4s of narration
 * and captions instead of anything ever reconciling scene-by-scene.
 *
 * `currentDurationSeconds` doesn't need to be measured/probed — Kling/
 * Hailuo reliably render at the exact duration requested
 * (pickClipDurationSeconds's own '5'|'10'), so callers recompute it
 * deterministically from the same scene.target_duration_ms input rather
 * than reading it off the file. `tpad`'s `stop_duration` is the amount of
 * ADDITIONAL padding to add (not a target total), so it's computed here
 * as the shortfall; the trailing `-t` always hard-caps the output to
 * exactly targetDurationSeconds regardless of which direction padding
 * went, so one command handles both "clip too short" (tpad extends it,
 * `-t` is then a no-op) and "clip too long" (tpad adds nothing, `-t`
 * trims it down) with no branching. Single input, single linear `-vf`
 * chain, so — like buildScaleCommand — it structurally can never need a
 * ';' regardless of the numbers involved.
 */
export function buildSceneDurationMatchCommand(
  clipUrl: string,
  currentDurationSeconds: number,
  targetDurationSeconds: number,
): { files: string[]; fullCommand: string; outputExtension: string } {
  const padSeconds = Math.max(0, targetDurationSeconds - currentDurationSeconds)
  const fullCommand =
    `ffmpeg -y -i {input} -vf "tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(2)}" ` +
    `-t ${targetDurationSeconds.toFixed(2)} -c:v libx264 -preset ultrafast -crf 23 -an {output}`
  return { files: [clipUrl], fullCommand, outputExtension: 'mp4' }
}

export class UploadPostAVMerger implements AVMerger, SceneClipScaler {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.upload-post.com',
  ) {}

  async submitVideoConcat(input: AVMergeInput): Promise<AVMergeJobRef> {
    return this.submitCommand(buildVideoConcatCommand(input.scenes))
  }

  async submitAudioConcat(input: AVMergeInput): Promise<AVMergeJobRef> {
    return this.submitCommand(buildAudioConcatCommand(input.scenes))
  }

  /** videoUrl/audioUrl are submitVideoConcat's/submitAudioConcat's outputs,
   *  re-hosted by the caller (see buildMuxCommand's header). */
  async submitMux(videoUrl: string, audioUrl: string): Promise<AVMergeJobRef> {
    return this.submitCommand(buildMuxCommand(videoUrl, audioUrl))
  }

  /** Only ever called when there are caption cues to burn in (see
   *  buildCaptionCommand's header); mergedVideoUrl is the mux pass's
   *  output, re-hosted by the caller so upload-post.com's `files` field (a
   *  list of fetchable URLs, same as every other input it takes) can see it. */
  async submitCaptionBurn(
    mergedVideoUrl: string,
    captionTimingData: unknown,
    aspectRatio?: '9:16' | '1:1' | '16:9',
  ): Promise<AVMergeJobRef> {
    return this.submitCommand(buildCaptionCommand(mergedVideoUrl, captionTimingData, aspectRatio))
  }

  /** Called from generateSceneVisual.ts, not renderLanguageTrack.ts — see
   *  SceneClipScaler's header (types.ts) for why this is a separate
   *  interface from AVMerger even though this same class implements both. */
  async submitScale(videoUrl: string, width: number, height: number): Promise<AVMergeJobRef> {
    return this.submitCommand(buildScaleCommand(videoUrl, width, height))
  }

  /** Called from renderLanguageTrack.ts, once per scene, before the video
   *  concat pass — see buildSceneDurationMatchCommand's own header. */
  async submitSceneDurationMatch(
    clipUrl: string,
    currentDurationSeconds: number,
    targetDurationSeconds: number,
  ): Promise<AVMergeJobRef> {
    return this.submitCommand(buildSceneDurationMatchCommand(clipUrl, currentDurationSeconds, targetDurationSeconds))
  }

  private async submitCommand(command: {
    files: string[]
    fullCommand: string
    outputExtension: string
  }): Promise<AVMergeJobRef> {
    const { files, fullCommand, outputExtension } = command

    // Confirmed live (2026-09-19): a real 8-scene BOTH render hit a 429
    // whose body gave the account's exact limit (62 requests/60s) — see
    // uploadPostRateLimiter.ts's own header for the full incident. This is
    // the ONE place every avMerger.ts pass (scale, duration-match,
    // concat/mux/caption) submits a job, so gating here covers all of them
    // uniformly with no per-call-site wiring.
    await uploadPostSubmitLimiter.acquire()

    const res = await this.fetchImpl(`${this.baseUrl}/api/uploadposts/ffmpeg/jobs/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Confirmed scheme is "Apikey", not "Bearer" — differs from every
        // other adapter in this codebase (docs.upload-post.com, 2026-09-12).
        Authorization: `Apikey ${this.apiKey}`,
      },
      body: JSON.stringify({ files, full_command: fullCommand, output_extension: outputExtension }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('upload-post', res.status, detail)
    }

    const data = (await res.json()) as { job_id?: string }
    if (!data.job_id) {
      throw new ProviderCallError('upload-post', res.status, 'response had no job_id')
    }

    return { providerRef: data.job_id }
  }

  async poll(jobRef: AVMergeJobRef): Promise<AVMergeResult> {
    // Confirmed live (2026-09-19): submitCommand's acquire() above was NOT
    // enough on its own — a real recovery attempt (7 scenes retrying their
    // downscale poll concurrently, every SCALE_POLL_INTERVAL_MS=5s each)
    // hit a DIFFERENT 429 within the same minute, this time on the per-min
    // window specifically ("count":63+,"limit":62), with ZERO new
    // submissions involved — it was the STATUS-CHECK polling alone that
    // blew through the account-wide budget, since only submitCommand was
    // ever gated. Every real call to this provider shares one account-wide
    // budget (uploadPostRateLimiter.ts's own header), so poll() needs the
    // exact same gate submitCommand already has.
    await uploadPostSubmitLimiter.acquire()

    const res = await this.fetchImpl(
      `${this.baseUrl}/api/uploadposts/ffmpeg/jobs/${encodeURIComponent(jobRef.providerRef)}`,
      { headers: { Authorization: `Apikey ${this.apiKey}` } },
    )

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('upload-post', res.status, detail)
    }

    // The real API returns lowercase job statuses (queued/started/finished/
    // failed — an RQ-backed job queue, confirmed live 2026-09-12), NOT the
    // 'PENDING'/'PROCESSING'/'FINISHED'/'ERROR' this used to check for. That
    // mismatch meant 'finished' and 'failed' both silently fell through to
    // "pending" below, FOREVER — every render this worker ever attempted
    // actually completed in under a second (verified live: duration_sec
    // 0.73 for a real 2-scene concat) or failed instantly, but this code
    // never noticed either outcome. It kept polling until upload-post.com's
    // own job-record TTL expired (~500s, almost certainly RQ's default
    // result_ttl) and the status endpoint started 404ing — which then
    // surfaced as a generic "poll timed out"/404 failure with no connection
    // to what actually happened. Matched case-insensitively since we don't
    // have a documented guarantee on exact casing going forward.
    const data = (await res.json()) as { status?: string; exc_info?: string | null }
    const status = (data.status ?? '').toLowerCase()

    if (status === 'finished') {
      // Same account-wide budget as the status check above and
      // submitCommand — this is still a real call to this provider.
      await uploadPostSubmitLimiter.acquire()
      // The download endpoint needs the same Apikey header as every other
      // call to this provider — downloaded here, not left to the caller, so
      // no downstream code needs to know upload-post.com's auth scheme.
      const downloadRes = await this.fetchImpl(
        `${this.baseUrl}/api/uploadposts/ffmpeg/jobs/${jobRef.providerRef}/download`,
        { headers: { Authorization: `Apikey ${this.apiKey}` } },
      )
      if (!downloadRes.ok) {
        const detail = await downloadRes.text().catch(() => '')
        throw new ProviderCallError('upload-post', downloadRes.status, `download failed: ${detail}`)
      }
      const fileBuffer = Buffer.from(await downloadRes.arrayBuffer())
      return { status: 'ready', fileBuffer }
    }
    if (status === 'failed' || status === 'error' || status === 'canceled' || status === 'stopped') {
      // exc_info is the real Python traceback upload-post.com's RQ worker
      // captured (e.g. a full_command shape violation) — surfacing it
      // directly is what makes a real failure actually diagnosable, instead
      // of every failure looking identical ("status=ERROR").
      return { status: 'failed', detail: data.exc_info ?? `ffmpeg job reported status=${data.status}` }
    }
    // 'queued' | 'started' | anything else unrecognized — still in flight.
    return { status: 'pending' }
  }
}
