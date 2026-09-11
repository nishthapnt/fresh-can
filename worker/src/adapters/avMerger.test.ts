import { describe, it, expect, vi } from 'vitest'
import { buildFfmpegCommand, UploadPostAVMerger } from './avMerger.js'
import { ProviderCallError } from './types.js'

describe('buildFfmpegCommand', () => {
  it('throws when there are no scenes', () => {
    expect(() => buildFfmpegCommand({ scenes: [] })).toThrow()
  })

  it('interleaves each scene\'s clip and audio as (clip, audio) pairs in files', () => {
    const { files } = buildFfmpegCommand({
      scenes: [
        { clipUrl: 'https://example.com/s1.mp4', audioUrl: 'https://example.com/a1.mp3' },
        { clipUrl: 'https://example.com/s2.mp4', audioUrl: 'https://example.com/a2.mp3' },
      ],
    })
    expect(files).toEqual([
      'https://example.com/s1.mp4',
      'https://example.com/a1.mp3',
      'https://example.com/s2.mp4',
      'https://example.com/a2.mp3',
    ])
  })

  it('builds a (video,audio)-pair concat filter sized to the scene count, with no captions', () => {
    const { fullCommand, outputExtension } = buildFfmpegCommand({
      scenes: [
        { clipUrl: 'https://example.com/s1.mp4', audioUrl: 'https://example.com/a1.mp3' },
        { clipUrl: 'https://example.com/s2.mp4', audioUrl: 'https://example.com/a2.mp3' },
        { clipUrl: 'https://example.com/s3.mp4', audioUrl: 'https://example.com/a3.mp3' },
      ],
    })
    expect(fullCommand).toContain(
      '-i {input0} -i {input1} -i {input2} -i {input3} -i {input4} -i {input5}',
    )
    // scene i's clip is input 2*i, its audio is input 2*i+1
    expect(fullCommand).toContain('[0:v][1:a][2:v][3:a][4:v][5:a]concat=n=3:v=1:a=1[vconcat][aconcat]')
    expect(fullCommand).toContain('-map "[vconcat]"')
    expect(fullCommand).toContain('-map "[aconcat]"')
    expect(fullCommand).not.toContain('drawtext')
    expect(outputExtension).toBe('mp4')
  })

  it('chains drawtext filters for caption cues, chunked into lines, in timeline order', () => {
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
    const { fullCommand } = buildFfmpegCommand({
      scenes: [{ clipUrl: 'https://example.com/s1.mp4', audioUrl: 'https://example.com/a1.mp3' }],
      captionTimingData: words,
    })
    // 8 words / 7 per line -> 2 cues
    expect(fullCommand).toContain("drawtext=text='hello world this is fresh-can foods today'")
    expect(fullCommand).toContain("drawtext=text='and'")
    expect(fullCommand).toContain('[vconcat]drawtext=')
    // second drawtext stage chains off the first stage's output label
    expect(fullCommand).toContain('[vcap0]drawtext=')
    expect(fullCommand).toContain('-map "[vcap1]"')
    expect(fullCommand).toContain('-map "[aconcat]"')
  })

  it('escapes colons and single quotes in caption text', () => {
    const words = [{ text: "it's: fresh", start: 0, end: 500 }]
    const { fullCommand } = buildFfmpegCommand({
      scenes: [{ clipUrl: 'https://example.com/s1.mp4', audioUrl: 'https://example.com/a1.mp3' }],
      captionTimingData: words,
    })
    expect(fullCommand).toContain("it'\\\\''s\\: fresh")
  })

  it('ignores captionTimingData that is not an array of word objects', () => {
    const { fullCommand } = buildFfmpegCommand({
      scenes: [{ clipUrl: 'https://example.com/s1.mp4', audioUrl: 'https://example.com/a1.mp3' }],
      captionTimingData: { not: 'an array' },
    })
    expect(fullCommand).not.toContain('drawtext')
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
  it('submit() sends Apikey auth (not Bearer) and the built command', async () => {
    let capturedHeaders: Record<string, string> = {}
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-1', status: 'PENDING' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submit(ONE_SCENE)
    expect(ref.providerRef).toBe('job-1')
    expect(capturedHeaders.Authorization).toBe('Apikey secret-key')
    expect(JSON.parse(capturedBody!)).toMatchObject({ output_extension: 'mp4' })
  })

  it('submit() throws ProviderCallError when job_id is missing', async () => {
    const fetchImpl = mockFetch({ jsonBody: {} })
    const merger = new UploadPostAVMerger('key', fetchImpl)
    await expect(merger.submit(ONE_SCENE)).rejects.toThrow(ProviderCallError)
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

  it('poll() throws ProviderCallError on a non-ok HTTP response from the status check', async () => {
    const merger = new UploadPostAVMerger('key', mockFetch({ ok: false, status: 404, textBody: 'not found' }))
    await expect(merger.poll({ providerRef: 'job-1' })).rejects.toThrow(ProviderCallError)
  })
})
