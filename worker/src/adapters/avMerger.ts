import {
  ProviderCallError,
  type AVMerger,
  type AVMergeInput,
  type AVMergeJobRef,
  type AVMergeResult,
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
function normalizeCaptionCues(timingData: unknown, wordsPerLine = 7): CaptionCue[] {
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
 * Builds the raw ffmpeg command string upload-post.com's FFmpeg Editor API
 * executes (it has no built-in "merge these scenes with this audio and burn
 * in captions" primitive — the caller supplies the full command; see
 * docs.upload-post.com/api/ffmpeg-editor, confirmed 2026-09-12). Kept
 * separate from the HTTP adapter class so this real, non-trivial logic is
 * unit-testable without mocking fetch.
 *
 * Files are interleaved [clip0, audio0, clip1, audio1, ...] — scene i's clip
 * is input (2*i), its audio is input (2*i + 1) — and concatenated as
 * (video,audio) PAIRS, not video-then-audio separately: there is no
 * standalone audio-concatenation step (synthesizeVoice.ts produces one
 * audio file per scene, never one combined track-level file), so pairing
 * each clip with its own scene's audio here is what keeps sync correct.
 * Scene clips themselves have no audio stream (generated with sound=false,
 * see kie.ts's KieVideoGenerator) — concat=...:a=1 pulls the audio from
 * each PAIR's audio input, not from the clip.
 */
export function buildFfmpegCommand(input: AVMergeInput): {
  files: string[]
  fullCommand: string
  outputExtension: string
} {
  const sceneCount = input.scenes.length
  if (sceneCount === 0) {
    throw new Error('buildFfmpegCommand: at least one scene is required')
  }

  const files: string[] = []
  for (const scene of input.scenes) {
    files.push(scene.clipUrl, scene.audioUrl)
  }

  const concatInputs = input.scenes.map((_, i) => `[${2 * i}:v][${2 * i + 1}:a]`).join('')
  let filterComplex = `${concatInputs}concat=n=${sceneCount}:v=1:a=1[vconcat][aconcat]`

  const cues = normalizeCaptionCues(input.captionTimingData)
  let videoOutLabel = 'vconcat'
  if (cues.length > 0) {
    const drawtextStages = cues.map((cue, i) => {
      const inLabel = i === 0 ? 'vconcat' : `vcap${i - 1}`
      const outLabel = `vcap${i}`
      const startSec = (cue.startMs / 1000).toFixed(2)
      const endSec = (cue.endMs / 1000).toFixed(2)
      const text = escapeDrawtextValue(cue.text)
      return (
        `[${inLabel}]drawtext=text='${text}':fontcolor=white:fontsize=48:` +
        `x=(w-text_w)/2:y=h-120:box=1:boxcolor=black@0.5:boxborderw=10:` +
        `enable='between(t,${startSec},${endSec})'[${outLabel}]`
      )
    })
    filterComplex += ';' + drawtextStages.join(';')
    videoOutLabel = `vcap${cues.length - 1}`
  }

  const inputArgs = files.map((_, i) => `-i {input${i}}`).join(' ')
  const fullCommand =
    `ffmpeg -y ${inputArgs} ` +
    `-filter_complex "${filterComplex}" ` +
    `-map "[${videoOutLabel}]" -map "[aconcat]" ` +
    `-c:v libx264 -c:a aac -shortest {output}`

  return { files, fullCommand, outputExtension: 'mp4' }
}

export class UploadPostAVMerger implements AVMerger {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.upload-post.com',
  ) {}

  async submit(input: AVMergeInput): Promise<AVMergeJobRef> {
    const { files, fullCommand, outputExtension } = buildFfmpegCommand(input)

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

    const data = (await res.json()) as { status?: 'PENDING' | 'PROCESSING' | 'FINISHED' | 'ERROR' }

    if (data.status === 'FINISHED') {
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
    if (data.status === 'ERROR') {
      return { status: 'failed', detail: 'ffmpeg job reported status=ERROR' }
    }
    // 'PENDING' | 'PROCESSING'
    return { status: 'pending' }
  }
}
