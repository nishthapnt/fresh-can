import {
  ProviderCallError,
  type AVMerger,
  type AVMergeInput,
  type AVMergeJobRef,
  type AVMergeResult,
  type SceneClipScaler,
} from './types.js'

interface CaptionCue {
  text: string
  startMs: number
  endMs: number
}

/** AssemblyAI word objects (see assemblyai.ts's TranscriptionPollResult.timingData)
 *  grouped into short caption lines. `captionTimingData` is typed `unknown` at
 *  the interface boundary since it crosses from one adapter's output to
 *  another's input — anything not shaped like a word array is treated as
 *  "no captions" rather than a hard error, since a render without burned-in
 *  captions is still a valid render. */
export function normalizeCaptionCues(timingData: unknown, wordsPerLine = 7): CaptionCue[] {
  if (!Array.isArray(timingData)) return []
  const words = timingData.filter(
    (w): w is { text: unknown; start: unknown; end: unknown } =>
      typeof w === 'object' && w !== null && 'text' in w && 'start' in w && 'end' in w,
  )

  const cues: CaptionCue[] = []
  for (let i = 0; i < words.length; i += wordsPerLine) {
    const chunk = words.slice(i, i + wordsPerLine)
    const text = chunk.map((w) => String(w.text)).join(' ').trim()
    const startMs = Number(chunk[0]?.start)
    const endMs = Number(chunk[chunk.length - 1]?.end)
    if (text && Number.isFinite(startMs) && Number.isFinite(endMs)) {
      cues.push({ text, startMs, endMs })
    }
  }
  return cues
}

/** Escapes text for ffmpeg's drawtext filter, per ffmpeg's own escaping
 *  rules for text wrapped in single quotes inside a filtergraph string.
 *  NOT independently verified against a real render yet — flagged the same
 *  way kie.ts flags its unverified endpoints; confirm against a real
 *  upload-post.com FFmpeg job before trusting this on user-facing text that
 *  contains punctuation. */
function escapeDrawtextValue(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\\\''")
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
 */
export function buildCaptionCommand(
  mergedVideoUrl: string,
  captionTimingData: unknown,
): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const cues = normalizeCaptionCues(captionTimingData)
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
    return (
      `drawtext=text='${text}':fontcolor=white:fontsize=h*0.033:` +
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
  async submitCaptionBurn(mergedVideoUrl: string, captionTimingData: unknown): Promise<AVMergeJobRef> {
    return this.submitCommand(buildCaptionCommand(mergedVideoUrl, captionTimingData))
  }

  /** Called from generateSceneVisual.ts, not renderLanguageTrack.ts — see
   *  SceneClipScaler's header (types.ts) for why this is a separate
   *  interface from AVMerger even though this same class implements both. */
  async submitScale(videoUrl: string, width: number, height: number): Promise<AVMergeJobRef> {
    return this.submitCommand(buildScaleCommand(videoUrl, width, height))
  }

  private async submitCommand(command: {
    files: string[]
    fullCommand: string
    outputExtension: string
  }): Promise<AVMergeJobRef> {
    const { files, fullCommand, outputExtension } = command

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
