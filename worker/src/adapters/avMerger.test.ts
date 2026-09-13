import { describe, it, expect, vi } from 'vitest'
import {
  buildVideoConcatCommand,
  buildAudioConcatCommand,
  buildMuxCommand,
  buildCaptionCommand,
  buildScaleCommand,
  UploadPostAVMerger,
} from './avMerger.js'
import { ProviderCallError } from './types.js'

const THREE_SCENES = [
  { clipUrl: 'https://example.com/s1.mp4', audioUrl: 'https://example.com/a1.mp3' },
  { clipUrl: 'https://example.com/s2.mp4', audioUrl: 'https://example.com/a2.mp3' },
  { clipUrl: 'https://example.com/s3.mp4', audioUrl: 'https://example.com/a3.mp3' },
]

describe('buildVideoConcatCommand', () => {
  it('throws when there are no scenes', () => {
    expect(() => buildVideoConcatCommand([])).toThrow()
  })

  it('takes only the clip URLs, in order, as files', () => {
    const { files } = buildVideoConcatCommand(THREE_SCENES)
    expect(files).toEqual(['https://example.com/s1.mp4', 'https://example.com/s2.mp4', 'https://example.com/s3.mp4'])
  })

  it('builds a video-only concat filter (a=0) sized to the scene count', () => {
    const { fullCommand, outputExtension } = buildVideoConcatCommand(THREE_SCENES)
    expect(fullCommand).toContain('-i {input0} -i {input1} -i {input2}')
    expect(fullCommand).toContain('[0:v][1:v][2:v]concat=n=3:v=1:a=0[vout]')
    expect(fullCommand).toContain('-map "[vout]"')
    expect(outputExtension).toBe('mp4')
  })

  it('never contains a semicolon (upload-post.com rejects any ";")', () => {
    const { fullCommand } = buildVideoConcatCommand(THREE_SCENES)
    expect(fullCommand).not.toContain(';')
  })

  it('caps bitrate instead of using CRF — CRF has no size ceiling, and a real 9-scene/90s render at CRF23 exceeded Supabase Storage\'s upload size limit even after per-clip downscaling', () => {
    const { fullCommand } = buildVideoConcatCommand(THREE_SCENES)
    expect(fullCommand).toContain('-b:v 3500k')
    expect(fullCommand).toContain('-maxrate 3500k')
    expect(fullCommand).toContain('-bufsize 7000k')
    expect(fullCommand).not.toContain('-crf')
  })
})

describe('buildAudioConcatCommand', () => {
  it('throws when there are no scenes', () => {
    expect(() => buildAudioConcatCommand([])).toThrow()
  })

  it('takes only the audio URLs, in order, as files', () => {
    const { files } = buildAudioConcatCommand(THREE_SCENES)
    expect(files).toEqual(['https://example.com/a1.mp3', 'https://example.com/a2.mp3', 'https://example.com/a3.mp3'])
  })

  it('builds an audio-only concat filter (v=0) sized to the scene count', () => {
    const { fullCommand, outputExtension } = buildAudioConcatCommand(THREE_SCENES)
    expect(fullCommand).toContain('-i {input0} -i {input1} -i {input2}')
    expect(fullCommand).toContain('[0:a][1:a][2:a]concat=n=3:v=0:a=1[aout]')
    expect(fullCommand).toContain('-map "[aout]"')
    expect(outputExtension).toBe('mp4')
  })

  it('never contains a semicolon (upload-post.com rejects any ";")', () => {
    const { fullCommand } = buildAudioConcatCommand(THREE_SCENES)
    expect(fullCommand).not.toContain(';')
  })
})

describe('buildMuxCommand', () => {
  it('takes the video and audio URLs as its two inputs, remuxed via -c copy', () => {
    const { files, fullCommand, outputExtension } = buildMuxCommand(
      'https://example.com/video.mp4',
      'https://example.com/audio.mp4',
    )
    expect(files).toEqual(['https://example.com/video.mp4', 'https://example.com/audio.mp4'])
    expect(fullCommand).toContain('-i {input0} -i {input1}')
    expect(fullCommand).toContain('-c copy')
    expect(fullCommand).toContain('-shortest')
    expect(outputExtension).toBe('mp4')
  })

  it('never contains a semicolon or filter_complex (no filtergraph at all)', () => {
    const { fullCommand } = buildMuxCommand('https://example.com/video.mp4', 'https://example.com/audio.mp4')
    expect(fullCommand).not.toContain(';')
    expect(fullCommand).not.toContain('-filter_complex')
  })
})

describe('buildCaptionCommand', () => {
  it('throws when there are no caption cues', () => {
    expect(() => buildCaptionCommand('https://example.com/merged.mp4', { not: 'an array' })).toThrow()
    expect(() => buildCaptionCommand('https://example.com/merged.mp4', undefined)).toThrow()
  })

  it('takes the merged video as its sole input and passes audio through with -c:a copy', () => {
    const words = [{ text: 'hello', start: 0, end: 400 }]
    const { files, fullCommand } = buildCaptionCommand('https://example.com/merged.mp4', words)
    expect(files).toEqual(['https://example.com/merged.mp4'])
    // Bare {input}, not {input0} — confirmed live that upload-post.com's
    // single-file code path rejects an indexed placeholder outright.
    expect(fullCommand).toContain('-i {input}')
    expect(fullCommand).not.toContain('{input0}')
    expect(fullCommand).toContain('-c:a copy')
  })

  it('chains drawtext filters for caption cues via -vf, chunked into lines, in timeline order', () => {
    const words = [
      { text: 'hello', start: 0, end: 400 },
      { text: 'world', start: 400, end: 800 },
      { text: 'this', start: 1000, end: 1200 },
      { text: 'is', start: 1200, end: 1300 },
      { text: 'fresh-can', start: 1300, end: 1800 },
      { text: 'foods', start: 1800, end: 2100 },
      { text: 'today', start: 2100, end: 2400 },
      { text: 'and', start: 2400, end: 2500 },
    ]
    const { fullCommand } = buildCaptionCommand('https://example.com/merged.mp4', words)
    // 8 words / 7 per line -> 2 cues
    expect(fullCommand).toContain("drawtext=text='hello world this is fresh-can foods today'")
    expect(fullCommand).toContain("drawtext=text='and'")
    expect(fullCommand).toContain('-vf "')
  })

  it('escapes colons and single quotes in caption text', () => {
    const words = [{ text: "it's: fresh", start: 0, end: 500 }]
    const { fullCommand } = buildCaptionCommand('https://example.com/merged.mp4', words)
    expect(fullCommand).toContain("it'\\\\''s\\: fresh")
  })

  it('never contains a semicolon or bracket-labeled pads, regardless of cue count', () => {
    const words = Array.from({ length: 20 }, (_, i) => ({
      text: `word${i}`,
      start: i * 300,
      end: i * 300 + 250,
    }))
    const { fullCommand } = buildCaptionCommand('https://example.com/merged.mp4', words)
    expect(fullCommand).not.toContain(';')
    expect(fullCommand).not.toContain('[vconcat]')
    expect(fullCommand).not.toContain('-filter_complex')
  })

  it('caps bitrate instead of using CRF — this pass re-encodes the final render, so an uncapped CRF here could re-inflate an already size-bounded video-concat pass', () => {
    const words = [{ text: 'hello', start: 0, end: 400 }]
    const { fullCommand } = buildCaptionCommand('https://example.com/merged.mp4', words)
    expect(fullCommand).toContain('-b:v 3500k')
    expect(fullCommand).toContain('-maxrate 3500k')
    expect(fullCommand).toContain('-bufsize 7000k')
    expect(fullCommand).not.toContain('-crf')
  })
})

describe('buildScaleCommand', () => {
  it('takes the clip URL as its sole input', () => {
    const { files, outputExtension } = buildScaleCommand('https://example.com/clip.mp4', 1080, 1920)
    expect(files).toEqual(['https://example.com/clip.mp4'])
    expect(outputExtension).toBe('mp4')
  })

  it('scales to the exact given width/height and drops audio', () => {
    const { fullCommand } = buildScaleCommand('https://example.com/clip.mp4', 1080, 1920)
    expect(fullCommand).toContain('-vf "scale=1080:1920"')
    expect(fullCommand).toContain('-an')
  })

  it('uses the bare {input} placeholder, not {input0} (single-file commands crash on the indexed form)', () => {
    const { fullCommand } = buildScaleCommand('https://example.com/clip.mp4', 1080, 1920)
    expect(fullCommand).toContain('-i {input}')
    expect(fullCommand).not.toContain('{input0}')
  })

  it('sets -crf 23 explicitly — the same quality target libx264 already defaults to, not a reduction', () => {
    const { fullCommand } = buildScaleCommand('https://example.com/clip.mp4', 1080, 1920)
    expect(fullCommand).toContain('-crf 23')
  })

  it('never contains a semicolon', () => {
    const { fullCommand } = buildScaleCommand('https://example.com/clip.mp4', 1080, 1920)
    expect(fullCommand).not.toContain(';')
  })
})

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string; arrayBufferBody?: Uint8Array }) {
  return vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
    arrayBuffer: async () => (response.arrayBufferBody ?? new Uint8Array([])).buffer,
  })) as unknown as typeof fetch
}

const ONE_SCENE = { scenes: [{ clipUrl: 'https://example.com/s1.mp4', audioUrl: 'https://example.com/a1.mp3' }] }

describe('UploadPostAVMerger', () => {
  it('submitVideoConcat() sends Apikey auth (not Bearer) and the built video-concat command', async () => {
    let capturedHeaders: Record<string, string> = {}
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-1', status: 'PENDING' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitVideoConcat(ONE_SCENE)
    expect(ref.providerRef).toBe('job-1')
    expect(capturedHeaders.Authorization).toBe('Apikey secret-key')
    const body = JSON.parse(capturedBody!)
    expect(body).toMatchObject({ output_extension: 'mp4' })
    expect(body.files).toEqual(['https://example.com/s1.mp4'])
    expect(body.full_command).not.toContain(';')
  })

  it('submitAudioConcat() sends the audio-only concat command', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-1a' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitAudioConcat(ONE_SCENE)
    expect(ref.providerRef).toBe('job-1a')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/a1.mp3'])
    expect(body.full_command).not.toContain(';')
  })

  it('submitMux() sends both URLs as files and a semicolon-free remux command', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-1m' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitMux('https://example.com/v.mp4', 'https://example.com/a.mp4')
    expect(ref.providerRef).toBe('job-1m')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/v.mp4', 'https://example.com/a.mp4'])
    expect(body.full_command).not.toContain(';')
  })

  it('submitScale() sends Apikey auth and the built scale command for the given clip/dimensions', async () => {
    let capturedHeaders: Record<string, string> = {}
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-scale' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitScale('https://example.com/clip.mp4', 1080, 1920)
    expect(ref.providerRef).toBe('job-scale')
    expect(capturedHeaders.Authorization).toBe('Apikey secret-key')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/clip.mp4'])
    expect(body.full_command).toContain('scale=1080:1920')
    expect(body.full_command).not.toContain(';')
  })

  it('submitVideoConcat() throws ProviderCallError when job_id is missing', async () => {
    const fetchImpl = mockFetch({ jsonBody: {} })
    const merger = new UploadPostAVMerger('key', fetchImpl)
    await expect(merger.submitVideoConcat(ONE_SCENE)).rejects.toThrow(ProviderCallError)
  })

  it('submitCaptionBurn() sends the merged video URL as the sole file and a semicolon-free command', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-2' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitCaptionBurn('https://example.com/merged.mp4', [
      { text: 'hi', start: 0, end: 300 },
    ])
    expect(ref.providerRef).toBe('job-2')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/merged.mp4'])
    expect(body.full_command).not.toContain(';')
  })

  it('poll() returns pending for PENDING/PROCESSING', async () => {
    const merger = new UploadPostAVMerger('key', mockFetch({ jsonBody: { status: 'PROCESSING' } }))
    expect(await merger.poll({ providerRef: 'job-1' })).toEqual({ status: 'pending' })
  })

  it('poll() downloads the finished render with the Apikey header and returns its bytes', async () => {
    const videoBytes = new Uint8Array([1, 2, 3, 4])
    let downloadUrl = ''
    let downloadHeaders: Record<string, string> = {}
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/download')) {
        downloadUrl = url
        downloadHeaders = init?.headers as Record<string, string>
        return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => videoBytes.buffer }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'FINISHED' }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl, 'https://api.upload-post.com')
    const result = await merger.poll({ providerRef: 'job-1' })

    expect(downloadUrl).toBe('https://api.upload-post.com/api/uploadposts/ffmpeg/jobs/job-1/download')
    expect(downloadHeaders.Authorization).toBe('Apikey secret-key')
    expect(result.status).toBe('ready')
    expect(result).toMatchObject({ status: 'ready' })
    if (result.status === 'ready') {
      expect(Buffer.from(result.fileBuffer)).toEqual(Buffer.from(videoBytes))
    }
  })

  it('poll() throws ProviderCallError when the download request itself fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/download')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'server error', arrayBuffer: async () => new ArrayBuffer(0) }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'FINISHED' }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('key', fetchImpl)
    await expect(merger.poll({ providerRef: 'job-1' })).rejects.toThrow(ProviderCallError)
  })

  it('poll() returns failed on ERROR', async () => {
    const merger = new UploadPostAVMerger('key', mockFetch({ jsonBody: { status: 'ERROR' } }))
    const result = await merger.poll({ providerRef: 'job-1' })
    expect(result.status).toBe('failed')
  })

  // The real API (confirmed live 2026-09-12, RQ-backed): lowercase
  // queued/started/finished/failed — not the PENDING/PROCESSING/FINISHED/
  // ERROR this adapter used to check for, which meant a real 'finished' or
  // 'failed' silently fell through to "pending" forever.
  it('poll() returns pending for the real lowercase in-flight statuses', async () => {
    const merger = new UploadPostAVMerger('key', mockFetch({ jsonBody: { status: 'started' } }))
    expect(await merger.poll({ providerRef: 'job-1' })).toEqual({ status: 'pending' })
  })

  it('poll() downloads on the real lowercase "finished" status', async () => {
    const videoBytes = new Uint8Array([1, 2, 3, 4])
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/download')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => videoBytes.buffer }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'finished' }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('key', fetchImpl)
    const result = await merger.poll({ providerRef: 'job-1' })
    expect(result.status).toBe('ready')
  })

  it('poll() surfaces the provider\'s exc_info traceback as the failure detail on the real lowercase "failed" status', async () => {
    const merger = new UploadPostAVMerger(
      'key',
      mockFetch({ jsonBody: { status: 'failed', exc_info: 'ValueError: full_command debe contener {input} y {output}' } }),
    )
    const result = await merger.poll({ providerRef: 'job-1' })
    expect(result).toEqual({
      status: 'failed',
      detail: 'ValueError: full_command debe contener {input} y {output}',
    })
  })

  it('poll() throws ProviderCallError on a non-ok HTTP response from the status check', async () => {
    const merger = new UploadPostAVMerger('key', mockFetch({ ok: false, status: 404, textBody: 'not found' }))
    await expect(merger.poll({ providerRef: 'job-1' })).rejects.toThrow(ProviderCallError)
  })
})
