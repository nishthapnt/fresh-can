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

// Dip-to-black-and-back at every INTERIOR scene join (never the video's
// very first frame or very last frame — the opening stays at full
// brightness, and the closing is already handled by buildMuxCommand's own
// end-of-video fade) — see buildSceneDurationMatchCommand's own header for
// why this lives there instead of as a crossfade in the concat pass.
// 0.25s per side (~0.5s total dark window spanning a join) is fast enough
// to read as a deliberate cut, not a slow dissolve, matching this app's
// fast-paced short-form ad pacing (scenes run ~5-10s each).
export const SCENE_TRANSITION_FADE_SECONDS = 0.25

interface CaptionCue {
  text: string
  startMs: number
  endMs: number
}

// Same fontsize buildCaptionAssFile renders at (fraction of frame HEIGHT,
// so it scales correctly across all three delivery resolutions — see that
// function's own header). Needed here too so chunking can budget each
// line's WIDTH against the same font size the render will actually use.
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
 * buildCaptionAssFile), so the same word list wraps into more/shorter
 * lines on a narrow 9:16 frame than on a wide 16:9 one. Falls back to a
 * fixed word count only when no frame width is known (kept for callers/
 * tests that don't care about exact wrapping). */
export function normalizeCaptionCues(
  timingData: unknown,
  frameWidthPx?: number,
  fontSizePx?: number,
  // Sorted ascending cut-point timestamps (ms) between consecutive scenes
  // in the combined caption timeline — e.g. [6580, 15750, ...] for a
  // 3+-scene track. When given, a cue is never allowed to contain words
  // from two different scenes, even if they'd otherwise fit on one line
  // together: a caption phrase continuing verbatim across an unrelated
  // scene cut reads as more jarring than the cut alone (confirmed against
  // two real renders — see docs/PROMPT_ARCHITECTURE.md's video section).
  // Independent of SCENE_TRANSITION_FADE_SECONDS's dip-to-black fix —
  // this helps regardless of which transition style the render uses.
  sceneBoundariesMs?: number[],
): CaptionCue[] {
  if (!Array.isArray(timingData)) return []
  const words = timingData.filter(
    (w): w is { text: unknown; start: unknown; end: unknown } =>
      typeof w === 'object' && w !== null && 'text' in w && 'start' in w && 'end' in w,
  )
  if (words.length === 0) return []

  const maxLineWidthPx = frameWidthPx ? frameWidthPx * SAFE_WIDTH_FRACTION : undefined
  const fallbackWordsPerLine = 7
  const boundaries = sceneBoundariesMs ?? []
  // Which scene (0-indexed) a timestamp falls in, given ascending cut points.
  const sceneIndexOf = (ms: number): number => {
    let idx = 0
    for (const b of boundaries) {
      if (ms >= b) idx++
      else break
    }
    return idx
  }

  const cues: CaptionCue[] = []
  let chunk: typeof words = []
  let chunkText = ''
  let chunkSceneIndex = 0

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
    const wordSceneIndex = boundaries.length > 0 ? sceneIndexOf(Number(w.start)) : 0
    if (chunk.length > 0 && wordSceneIndex !== chunkSceneIndex) {
      flush()
    }
    chunkSceneIndex = wordSceneIndex

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

/** Escapes text for an ASS subtitle event's Text field — ASS uses `{...}`
 *  for inline override tags, so a literal brace in real narration (never
 *  expected, but not impossible) could otherwise open/break tag parsing;
 *  stripped outright rather than risk a malformed override tag reaching
 *  libass, since ASS has no clean literal-brace escape. Backslash doubled
 *  for the same defensive reason (`\` also starts certain ASS sequences). */
function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/[{}]/g, '')
}

/** ASS Dialogue timestamp format: `H:MM:SS.cc` (centiseconds, 2-digit). */
function msToAssTime(ms: number): string {
  const totalCentiseconds = Math.max(0, Math.round(ms / 10))
  const centiseconds = totalCentiseconds % 100
  const totalSeconds = Math.floor(totalCentiseconds / 100)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
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
// Shared bitrate-cap args for the deterministic, guaranteed-fit FALLBACK
// encode (buildVideoConcatCommandCapped/buildMuxCommandCapped/
// buildCaptionBurnCommandCapped), used only when a CRF-quality attempt's
// output exceeds SAFE_UPLOAD_BYTES (renderLanguageTrack.ts). CRF targets a
// QUALITY level, not a file size — it gives no ceiling on output size at
// all, so once a quality attempt comes back oversized, a fixed bitrate is
// what guarantees the retry actually fits. Math: worst case is 10 scenes x
// 10s = 100s; Supabase Storage's real upload ceiling is empirically
// confirmed at 50MB succeeds, 52MB fails ("object exceeded the maximum
// allowed size"), so 50MB is the target (not 52MB — the gap between the two
// was never itself tested). Reserving 2.5MB of that for the AAC audio track
// (`-c:a aac`/`-c:a copy` with no `-b:a` set uses ffmpeg's native-encoder
// default, ~128kbps for stereo; 2.5MB budgets ~192kbps over 100s, 1.5x that
// default as margin since the exact default isn't independently confirmed
// against upload-post.com's actual ffmpeg build) leaves 47.5MB / 100s =
// 3800kbps for video. Reused as-is for buildVideoConcatCommandCapped even
// though that pass's own output has no audio track to reserve budget for —
// the resulting extra headroom is harmless margin, not a case needing its
// own separately-tuned constant. Kept in one place so every capped builder
// can never drift apart from each other or from this math.
const CAPPED_VIDEO_ENCODE_ARGS = '-b:v 3800k -maxrate 3800k -bufsize 7600k'

/**
 * `crf` (default 23, quality-first, 2026-09-24 — see AVMerger.submitVideoConcat's
 * own doc comment, types.ts, for why this replaced an unconditional fixed
 * bitrate cap here). Unconstrained CRF, no bitrate cap, letting the encoder
 * pick bitrate per scene complexity — same posture as buildMuxCommand/
 * buildCaptionBurnCommand's own CRF-first passes. See
 * buildVideoConcatCommandCapped below for the deterministic fallback used
 * only when this comes back oversized.
 */
export function buildVideoConcatCommand(scenes: AVMergeInput['scenes'], crf = 23): {
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
  // -preset medium (2026-09-24 — bumped again from an intermediate
  // `veryfast` step; see this function's own history for why `ultrafast`
  // was chosen here originally): this pass decodes+re-encodes every real
  // scene clip (concat is a filter, not a stream copy — it forces a full
  // decode), the heaviest CPU work in the whole render. upload-post.com's
  // job for a real 7-scene render was observed to vanish (subsequent
  // status poll 404s, never an ERROR status) at a consistent ~9min mark on
  // two separate attempts — a fixed processing-time ceiling on their side,
  // not random flakiness (retrying the identical job just times out the
  // same way again). Trading libx264's default 'medium' preset for
  // 'ultrafast' was the safest lever to claw back margin without touching
  // the filtergraph shape — chosen BACK WHEN this pass's inputs were raw,
  // un-downscaled clips (native ~2MP). SceneClipScaler's per-clip downscale
  // (buildScaleCommand) now runs before every clip reaches this pass at
  // all (generateSceneVisual.ts's runSceneVideoClipStep only marks a clip
  // 'ready' — and therefore usable here — after its own scale pass
  // succeeds), so concat's real input today is uniformly 720p, not the
  // ~2MP case this ceiling was measured against.
  //
  // `veryfast` (the first bump) was confirmed live 2026-09-24 on a real
  // 4-scene render at 17.7s for THIS pass alone — ~30x margin under the
  // ~9min/540s ceiling, not just "some headroom." That real number is what
  // justifies going straight to libx264's own 'medium' default (matching
  // Kinetix-class output more closely) rather than inching up one preset
  // step at a time — even 'medium's typically-larger cost-per-frame than
  // 'veryfast' has enormous room left before approaching the ceiling. Keep
  // validating against real multi-scene renders' own elapsed-time logging
  // (renderLanguageTrack.ts's pipeline_steps.output_snapshot) if scene
  // count/duration ever grows well past what's been tested so far (4-7
  // scenes).
  //
  // -crf (default 23), not a fixed bitrate cap (2026-09-24, changed from an
  // unconditional -b:v/-maxrate/-bufsize 3800k): this pass decodes+
  // re-encodes every real scene clip at full quality — the heaviest single
  // re-encode in the whole render, and the FIRST one, so bitrate-capping it
  // unconditionally threw away detail no later CRF-based pass (mux,
  // caption-burn) could ever recover, even on an ordinary 4-7 scene render
  // (20-50s) nowhere near the 10-scene/100s worst case the old fixed cap
  // was actually sized for. CRF targets a QUALITY level, not a file size —
  // it gives no ceiling on output size at all, so this output's own size
  // must still be checked before it's re-hosted as an input to the mux
  // pass (a real 8-scene render's un-downscaled clips, back when NO
  // bitrate cap or downscale existed anywhere in this pipeline, summed to
  // 140.6MB and failed to re-upload past Supabase Storage's global upload
  // size limit) — buildVideoConcatCommandCapped below is the deterministic,
  // guaranteed-fit fallback for exactly that case, submitted only when this
  // CRF attempt's real output comes back over SAFE_UPLOAD_BYTES
  // (renderLanguageTrack.ts), the same quality-first-then-verify-size
  // pattern buildMuxCommand/buildCaptionBurnCommand already established.
  const fullCommand = `ffmpeg -y ${inputArgs} -filter_complex "${filterComplex}" -map "[vout]" -c:v libx264 -preset medium -crf ${crf} {output}`

  return { files, fullCommand, outputExtension: 'mp4' }
}

/**
 * Deterministic, guaranteed-fit fallback for buildVideoConcatCommand — see
 * CAPPED_VIDEO_ENCODE_ARGS's header for the size math (this pass's own
 * output carries no audio, so the 2.5MB reserved for an AAC track in that
 * math is unused headroom here, not a shortfall). Only ever submitted by
 * renderLanguageTrack.ts when a CRF-quality concat attempt's output exceeds
 * SAFE_UPLOAD_BYTES; never the default/first attempt.
 */
export function buildVideoConcatCommandCapped(scenes: AVMergeInput['scenes']): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const sceneCount = scenes.length
  if (sceneCount === 0) {
    throw new Error('buildVideoConcatCommandCapped: at least one scene is required')
  }

  const files = scenes.map((scene) => scene.clipUrl)
  const concatInputs = scenes.map((_, i) => `[${i}:v]`).join('')
  const filterComplex = `${concatInputs}concat=n=${sceneCount}:v=1:a=0[vout]`
  const inputArgs = files.map((_, i) => `-i {input${i}}`).join(' ')
  const fullCommand = `ffmpeg -y ${inputArgs} -filter_complex "${filterComplex}" -map "[vout]" -c:v libx264 -preset medium ${CAPPED_VIDEO_ENCODE_ARGS} {output}`

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

// Deterministic half of the "abrupt ending" fix (2026-09-21) — the other
// half asks composeSceneVideoPrompt's final scene to settle its own motion
// (compose.ts's FINAL_SCENE_SETTLE_CLAUSE), but that's model compliance,
// never a guarantee. This is: whatever the render's real final content
// looks like, a short fade-to-black/silence over the last FADE_OUT_SECONDS
// makes the cut read as an intentional ending rather than a hard jump-cut,
// unconditionally. Short enough (well under a second) to not read as its
// own deliberate "outro" moment — just enough to soften the literal edge.
const FADE_OUT_SECONDS = 0.6

function muxFadeArgs(totalDurationSeconds: number): string {
  const fadeStart = Math.max(0, totalDurationSeconds - FADE_OUT_SECONDS)
  return (
    `-vf "fade=t=out:st=${fadeStart.toFixed(2)}:d=${FADE_OUT_SECONDS.toFixed(2)}" ` +
    `-af "afade=t=out:st=${fadeStart.toFixed(2)}:d=${FADE_OUT_SECONDS.toFixed(2)}" `
  )
}

/**
 * Builds the ffmpeg command that muxes the (independently concatenated)
 * video-only and audio-only outputs back into one file, fading both to
 * black/silence over the last FADE_OUT_SECONDS of `totalDurationSeconds`
 * (the track's real total narration length — same value every scene's
 * duration-match pass targets, see buildSceneDurationMatchCommand). Re-
 * encodes (`-c:v libx264`/`-c:a aac`) rather than the previous `-c copy`
 * remux — required for `fade`/`afade` to apply at all, same trade-off the
 * caption-burn pass already accepts for its own filter. `-shortest` is
 * still meaningful: video and audio come from two genuinely separate
 * encodes that can differ by a fraction of a second, and this is the
 * single place that reconciles them into one final duration. Single input
 * per stream, single linear filter each, so — like buildScaleCommand —
 * this can never need a ';' regardless.
 *
 * `crf` (default 23, quality-first, 2026-09-23) — this is the "normal"
 * path when there are no captions (its own output IS the final render in
 * that case): unconstrained CRF, no bitrate cap, letting the encoder pick
 * bitrate per scene complexity. See buildMuxCommandCapped below for the
 * deterministic fallback used only when this comes back oversized.
 */
export function buildMuxCommand(
  videoUrl: string,
  audioUrl: string,
  totalDurationSeconds: number,
  crf = 23,
): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const fullCommand =
    `ffmpeg -y -i {input0} -i {input1} ` +
    muxFadeArgs(totalDurationSeconds) +
    `-c:v libx264 -preset medium -crf ${crf} -c:a aac -shortest {output}`
  return { files: [videoUrl, audioUrl], fullCommand, outputExtension: 'mp4' }
}

/**
 * Deterministic, guaranteed-fit fallback for buildMuxCommand — see
 * CAPPED_VIDEO_ENCODE_ARGS's header for the size math. Only ever submitted
 * by renderLanguageTrack.ts when a CRF-quality mux attempt's output
 * exceeds SAFE_UPLOAD_BYTES; never the default/first attempt.
 */
export function buildMuxCommandCapped(videoUrl: string, audioUrl: string, totalDurationSeconds: number): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const fullCommand =
    `ffmpeg -y -i {input0} -i {input1} ` +
    muxFadeArgs(totalDurationSeconds) +
    `-c:v libx264 -preset medium ${CAPPED_VIDEO_ENCODE_ARGS} -c:a aac -shortest {output}`
  return { files: [videoUrl, audioUrl], fullCommand, outputExtension: 'mp4' }
}

/**
 * Builds the ASS (Advanced SubStation Alpha) subtitle FILE CONTENT for one
 * render's captions — the caller uploads this (see renderLanguageTrack.ts)
 * and hands its URL to buildCaptionBurnCommand below. Replaces the old
 * chained-drawtext approach (removed 2026-09-21) after a real render was
 * flatly rejected by upload-post.com: `{"error":"Comando contiene
 * caracteres o patrones no permitidos: rm "}`. Their backend runs some
 * command-injection guard against the FULL command string, and the old
 * approach embedded real transcribed narration TEXT directly into that
 * string (`drawtext=text='...'`) — any word merely CONTAINING "rm " as a
 * substring (warm, farm, term, confirm, perform...), all entirely
 * plausible in this brand's own narration, tripped their filter, with no
 * way to predict or avoid every such word from our side. (The old
 * escapeDrawtextValue's own header already documented one earlier,
 * related incident — a broken apostrophe escape — from this exact same
 * "real narration text lives inside the ffmpeg command string" design.)
 * This rewrite removes that whole class of risk: caption text now lives
 * in an uploaded FILE, so the ffmpeg command string itself only ever
 * contains a filename, never any actual narration content — no future
 * word or character pattern in real narration can trip upload-post.com's
 * filter this way again.
 *
 * Returns null when there are no cues — caller skips the caption pass
 * entirely in that case (the mux pass's own output is already a valid
 * final render).
 *
 * Style block mirrors the old drawtext styling as closely as ASS allows:
 * white text (PrimaryColour), a semi-transparent black box behind it
 * (BackColour + BorderStyle=3, ASS's "opaque box" mode — the direct
 * equivalent of drawtext's box=1:boxcolor=black@0.5), bottom-center
 * placement (Alignment=2) with MarginV computed the same way the old
 * y=h-h*0.083 was. PlayResX/PlayResY pin ASS's own coordinate system to
 * the real delivery resolution, so pixel sizes below need no further
 * scaling math the way drawtext's `h*ratio` expressions did.
 */
export function buildCaptionAssFile(
  captionTimingData: unknown,
  aspectRatio: '9:16' | '1:1' | '16:9' = '9:16',
  sceneBoundariesMs?: number[],
): string | null {
  const { width: frameWidthPx, height: frameHeightPx } = ASPECT_RATIO_RESOLUTIONS[aspectRatio]
  const baseFontSizePx = Math.round(frameHeightPx * CAPTION_FONTSIZE_RATIO)
  const maxLineWidthPx = frameWidthPx * SAFE_WIDTH_FRACTION
  const marginVPx = Math.round(frameHeightPx * 0.083)

  const cues = normalizeCaptionCues(captionTimingData, frameWidthPx, baseFontSizePx, sceneBoundariesMs)
  if (cues.length === 0) return null

  // Per-cue fontsize override via ASS's inline `{\fsN}` tag — same rare
  // edge case the old fontsizeRatioFor handled (normalizeCaptionCues can
  // still emit one cue wider than the safe budget: a single "word" — a
  // long URL, a long name — with nothing narrower to fall back to), just
  // expressed as an ASS override tag instead of an ffmpeg `h*ratio`
  // expression. Scoped to that one Dialogue line only; every other line
  // uses the Style's own Fontsize.
  const events = cues
    .map((cue) => {
      const estimatedWidthPx = estimatedTextWidthPx(cue.text, baseFontSizePx)
      const fontsizeOverride =
        estimatedWidthPx > maxLineWidthPx
          ? `{\\fs${Math.round(baseFontSizePx * (maxLineWidthPx / estimatedWidthPx))}}`
          : ''
      const text = `${fontsizeOverride}${escapeAssText(cue.text)}`
      return `Dialogue: 0,${msToAssTime(cue.startMs)},${msToAssTime(cue.endMs)},Default,,0,0,0,,${text}`
    })
    .join('\n')

  return (
    '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    `PlayResX: ${frameWidthPx}\n` +
    `PlayResY: ${frameHeightPx}\n` +
    'ScaledBorderAndShadow: yes\n\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, ' +
    'Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, ' +
    'MarginR, MarginV, Encoding\n' +
    // Arial: not a real guarantee the render host has it installed, but the
    // conventional fallback-safe choice for libass/fontconfig setups (most
    // map it to a substitute like Liberation Sans rather than failing) —
    // NOT independently confirmed against upload-post.com's actual font
    // availability, same "flag the live-unconfirmed assumption" pattern
    // this codebase already uses elsewhere (see kie.ts's Seedance duration
    // comment for the convention).
    `Style: Default,Arial,${baseFontSizePx},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,` +
    `${Math.round(baseFontSizePx * 0.2)},0,2,10,10,${marginVPx},1\n\n` +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    `${events}\n`
  )
}

/**
 * Builds the ffmpeg command for the CAPTION-BURN pass: the mux pass's
 * output plus the already-uploaded ASS file (buildCaptionAssFile's
 * output, re-hosted by the caller — see renderLanguageTrack.ts), burned
 * in via ffmpeg's `subtitles=` filter — the standard, purpose-built ffmpeg
 * mechanism for this (unlike the old per-cue drawtext chain, it reads
 * caption content from a FILE, never embedding it in the command string
 * itself — see buildCaptionAssFile's header for why that matters).
 * `-c:a copy`: audio passes through untouched, same as the old version.
 * Single input, single linear `-vf` chain, so — like buildScaleCommand —
 * this can never need a ';' regardless.
 *
 * NOT YET CONFIRMED live: that upload-post.com's `{inputN}` placeholder
 * substitution works for a token used INSIDE a filter argument
 * (`subtitles={input1}`), not just immediately after `-i` the way every
 * other use of `{inputN}` in this file is written (see
 * buildVideoConcatCommand/buildMuxCommand). If their substitution turns
 * out to be `-i`-position-specific, add a harmless unused `-i {input1}`
 * too — ffmpeg tolerates an extra unmapped input — with the filter still
 * referencing the same local-path token.
 *
 * `crf` (default 23, quality-first, 2026-09-23) — this is the pass whose
 * output actually gets uploaded as the final render whenever captions are
 * present, so it gets the same unconstrained-CRF treatment buildMuxCommand
 * uses for the no-caption case: no bitrate cap, encoder picks bitrate per
 * scene complexity. `-c:a copy` means no audio re-encode happens here to
 * budget for either way. See buildCaptionBurnCommandCapped below for the
 * deterministic fallback used only when this comes back oversized — was
 * itself the unconditional default from 2026-09-23 until this same day,
 * when it was demoted to fallback-only in favor of CRF-first.
 */
export function buildCaptionBurnCommand(
  mergedVideoUrl: string,
  assFileUrl: string,
  crf = 23,
): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const fullCommand =
    `ffmpeg -y -i {input0} -vf "subtitles={input1}" ` +
    `-c:v libx264 -preset medium -crf ${crf} -c:a copy {output}`
  return { files: [mergedVideoUrl, assFileUrl], fullCommand, outputExtension: 'mp4' }
}

/**
 * Deterministic, guaranteed-fit fallback for buildCaptionBurnCommand — see
 * CAPPED_VIDEO_ENCODE_ARGS's header for the size math. Only ever submitted
 * by renderLanguageTrack.ts when a CRF-quality caption-burn attempt's
 * output exceeds SAFE_UPLOAD_BYTES; never the default/first attempt.
 */
export function buildCaptionBurnCommandCapped(mergedVideoUrl: string, assFileUrl: string): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const fullCommand =
    `ffmpeg -y -i {input0} -vf "subtitles={input1}" ` +
    `-c:v libx264 -preset medium ${CAPPED_VIDEO_ENCODE_ARGS} -c:a copy {output}`
  return { files: [mergedVideoUrl, assFileUrl], fullCommand, outputExtension: 'mp4' }
}

/**
 * Builds the ffmpeg command for downscaling ONE scene clip to its aspect
 * ratio's standard social-delivery resolution — 1080x1920 (9:16),
 * 1080x1080 (1:1), or 1920x1080 (16:9), matched to whatever the job's
 * content_jobs.aspect_ratio selected (worker/src/adapters/kie.ts's own
 * aspectRatio param already requests this shape from Flux Kontext/Seedance,
 * but their native output can still land slightly above it — e.g. a real
 * 9:16 clip came back at 1084x1912, and a 1:1 one at 1440x1440, both
 * modestly over their ~2-megapixel-budget target). A single input, single
 * linear `-vf scale=` chain, so — like buildMuxCommand — it structurally
 * can never need a ';' regardless of target size.
 *
 * {input}, not {input0}: confirmed live 2026-09-12 that upload-post.com's
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
  // -an: KIE.ai's scene clips are generated with generate_audio=false (no
  // audio stream at all — see kie.ts) — dropping audio explicitly rather than
  // assuming there's none to carry through. -crf 23: same "make the
  // existing default explicit" reasoning as buildVideoConcatCommand — the
  // downscale itself (fewer pixels in) is what actually shrinks the file;
  // this isn't lowering the quality target.
  //
  // -preset veryfast, not ultrafast (2026-09-23): this pass processes ONE
  // short scene clip at a time, never the whole render — it was never the
  // step the ~9min upload-post.com queue ceiling was measured against
  // (buildVideoConcatCommand's header), so there's no timing reason to sit
  // on x264's worst quality-per-bit preset here. This runs once per scene
  // per pipeline generation (not per language track), so the softness it
  // adds is baked into content_visual_assets' shared clip and compounds
  // through every later pass (duration-match, concat, mux, caption-burn) —
  // worth paying a small, safe preset step for.
  const fullCommand = `ffmpeg -y -i {input} -vf "scale=${width}:${height}" -c:v libx264 -preset veryfast -crf 23 -an {output}`
  return { files: [videoUrl], fullCommand, outputExtension: 'mp4' }
}

/**
 * Matches ONE scene's shared video clip to THIS language track's real
 * narration length — holding the last frame if the clip is shorter than
 * the audio, trimming if it's longer. This is the render-time
 * reconciliation ARCHITECTURE.MD §4.2 always called for ("the render step
 * handles per-scene sync by holding the last frame... or trimming
 * trailing silence...") but that was never actually implemented — video
 * clips are generated once, shared across every language, at a REQUESTED
 * duration close to (2026-09-24) or, before that, quantized to a fixed 5/10s
 * bucket regardless of (2026-09-21 - 2026-09-24) the shared script's own
 * target_duration_seconds BUDGET (see lib/sceneClipDuration.ts's
 * pickClipDurationSeconds for the full history) — either way, before any
 * SPECIFIC language's real narration exists, so a clip almost never matches
 * one language's real audio length exactly, request-duration tightening or
 * not — this function is still what actually closes that gap per language.
 * Confirmed live (2026-09-19): a
 * real 7-scene render's total video length (35s, all 5s clips) drifted
 * 7.4s short of its real total audio length (42.4s) — the final mux
 * pass's `-shortest` was silently truncating the last ~7.4s of narration
 * and captions instead of anything ever reconciling scene-by-scene.
 *
 * Rewritten 2026-09-21 to drop the `currentDurationSeconds` parameter this
 * used to take — that value was never measured/probed, it was recomputed
 * from the same `pickClipDurationSeconds` bucket used to REQUEST the clip
 * ('5'|'10'), on the assumption the video model reliably renders at exactly
 * that requested duration. True for Kling/Hailuo, confirmed NOT reliably
 * true for Seedance 1.5 Pro (swapped in 2026-09-21) — a real render showed
 * caption/audio desync traced to exactly this: when a real clip comes back
 * shorter than the assumed bucket, `padSeconds = target - assumed`
 * under-pads, the video track ends up shorter than the audio/caption
 * track, video-concat and audio-concat are built independently (see
 * buildVideoConcatCommand/buildAudioConcatCommand below) then only
 * stream-copy-muxed with a trim-only `-shortest` — so a single scene's
 * shortfall shifts every LATER scene's picture earlier relative to the
 * correctly-timed narration/captions, and any net shortfall truncates
 * trailing audio/captions off the end.
 *
 * Fix: pad by the FULL targetDurationSeconds (a known-real value — the
 * calling track's own AssemblyAI-measured narration length) instead of a
 * computed shortfall against an assumed input length. This makes the
 * command correct regardless of the real input clip's actual duration,
 * which this function no longer needs to know at all: `tpad`'s
 * stop_duration only ever needs to be AT LEAST as long as the real
 * shortfall, and any excess is just a static hold on the clip's own last
 * frame — content-free padding the trailing `-t` always trims back off,
 * whether that excess came from over-padding (this fix) or from the input
 * already being longer than target (the original "clip too long" case,
 * unaffected). One command still handles both directions with no
 * branching, and stays a single input / single linear `-vf` chain — like
 * buildScaleCommand, it structurally can never need a ';'.
 *
 * `transition` (2026-09-25) — dip-to-black at scene JOINS, added here
 * rather than as a crossfade in buildVideoConcatCommand. A real crossfade
 * (ffmpeg's `xfade`) needs a SEPARATE filter call per pair of clips beyond
 * the first two, chained with ';' — upload-post.com's API rejects any ';'
 * in full_command outright (a fixed command-injection denylist, see
 * AVMerger's own doc comment in types.ts), and running one xfade pass per
 * transition instead would roughly double this render's already-scarce
 * upload-post.com FFmpeg-minutes usage (see this repo's own recent quota-
 * exhaustion incidents). A plain `fade` (single-stream, in/out, defaults
 * to black) fits this pass's existing single-input/single-`-vf`-chain
 * shape for free — no new provider round trip, no extra quota, and
 * renderLanguageTrack.ts's own concat pass right after this one needs no
 * changes at all. `fadeInSeconds` is 0 for the FIRST scene (nothing to
 * transition FROM) and `fadeOutSeconds` is 0 for the LAST scene
 * (buildMuxCommand's own end-of-video fade already covers that beat) —
 * the caller decides which, this function just applies whatever it's
 * given. Each side is clamped to at most a quarter of
 * targetDurationSeconds so a pathologically short scene can never fade
 * through most of its own runtime.
 */
export function buildSceneDurationMatchCommand(
  clipUrl: string,
  targetDurationSeconds: number,
  transition: { fadeInSeconds?: number; fadeOutSeconds?: number } = {},
): { files: string[]; fullCommand: string; outputExtension: string } {
  const maxFade = targetDurationSeconds / 4
  const fadeIn = Math.max(0, Math.min(transition.fadeInSeconds ?? 0, maxFade))
  const fadeOut = Math.max(0, Math.min(transition.fadeOutSeconds ?? 0, maxFade))

  let vf = `tpad=stop_mode=clone:stop_duration=${targetDurationSeconds.toFixed(2)}`
  if (fadeIn > 0) vf += `,fade=t=in:st=0:d=${fadeIn.toFixed(2)}`
  if (fadeOut > 0) {
    const fadeOutStart = targetDurationSeconds - fadeOut
    vf += `,fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeOut.toFixed(2)}`
  }

  // -preset veryfast, not ultrafast (2026-09-23) — same reasoning as
  // buildScaleCommand just above: this is a per-scene, per-language-track
  // pass on one short clip, never the whole-render pass the ~9min queue
  // ceiling was actually measured against.
  const fullCommand = `ffmpeg -y -i {input} -vf "${vf}" -t ${targetDurationSeconds.toFixed(2)} -c:v libx264 -preset veryfast -crf 23 -an {output}`
  return { files: [clipUrl], fullCommand, outputExtension: 'mp4' }
}

export class UploadPostAVMerger implements AVMerger, SceneClipScaler {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.upload-post.com',
  ) {}

  async submitVideoConcat(input: AVMergeInput, crf?: number): Promise<AVMergeJobRef> {
    return this.submitCommand(buildVideoConcatCommand(input.scenes, crf))
  }

  /** See buildVideoConcatCommandCapped's header — only ever called by
   *  renderLanguageTrack.ts's size guard, after a quality-tier
   *  submitVideoConcat came back over SAFE_UPLOAD_BYTES. */
  async submitVideoConcatCapped(input: AVMergeInput): Promise<AVMergeJobRef> {
    return this.submitCommand(buildVideoConcatCommandCapped(input.scenes))
  }

  async submitAudioConcat(input: AVMergeInput): Promise<AVMergeJobRef> {
    return this.submitCommand(buildAudioConcatCommand(input.scenes))
  }

  /** videoUrl/audioUrl are submitVideoConcat's/submitAudioConcat's outputs,
   *  re-hosted by the caller (see buildMuxCommand's header). */
  async submitMux(videoUrl: string, audioUrl: string, totalDurationSeconds: number, crf?: number): Promise<AVMergeJobRef> {
    return this.submitCommand(buildMuxCommand(videoUrl, audioUrl, totalDurationSeconds, crf))
  }

  /** See buildMuxCommandCapped's header — only ever called by
   *  renderLanguageTrack.ts's size guard, after a quality-tier submitMux
   *  came back over SAFE_UPLOAD_BYTES. */
  async submitMuxCapped(videoUrl: string, audioUrl: string, totalDurationSeconds: number): Promise<AVMergeJobRef> {
    return this.submitCommand(buildMuxCommandCapped(videoUrl, audioUrl, totalDurationSeconds))
  }

  /** Only ever called when there are caption cues to burn in (see
   *  buildCaptionAssFile's header); mergedVideoUrl is the mux pass's
   *  output and assFileUrl is buildCaptionAssFile's own output, both
   *  re-hosted by the caller so upload-post.com's `files` field (a list of
   *  fetchable URLs, same as every other input it takes) can see them. */
  async submitCaptionBurn(mergedVideoUrl: string, assFileUrl: string, crf?: number): Promise<AVMergeJobRef> {
    return this.submitCommand(buildCaptionBurnCommand(mergedVideoUrl, assFileUrl, crf))
  }

  /** See buildCaptionBurnCommandCapped's header — only ever called by
   *  renderLanguageTrack.ts's size guard, after a quality-tier
   *  submitCaptionBurn came back over SAFE_UPLOAD_BYTES. */
  async submitCaptionBurnCapped(mergedVideoUrl: string, assFileUrl: string): Promise<AVMergeJobRef> {
    return this.submitCommand(buildCaptionBurnCommandCapped(mergedVideoUrl, assFileUrl))
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
    targetDurationSeconds: number,
    transition?: { fadeInSeconds?: number; fadeOutSeconds?: number },
  ): Promise<AVMergeJobRef> {
    return this.submitCommand(buildSceneDurationMatchCommand(clipUrl, targetDurationSeconds, transition))
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
