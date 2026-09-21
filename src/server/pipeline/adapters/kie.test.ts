import { describe, it, expect, vi } from 'vitest'
import { KieImageGenerator, KieVideoGenerator } from './kie'
import { ProviderCallError } from './types'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  })) as unknown as typeof fetch
}

describe('KieImageGenerator (Flux Kontext — docs.kie.ai)', () => {
  it('submit() returns a providerRef from data.taskId', async () => {
    const fetchImpl = mockFetch({ jsonBody: { code: 200, msg: 'success', data: { taskId: 'abc123' } } })
    const gen = new KieImageGenerator('test-key', fetchImpl)
    const ref = await gen.submit({ prompt: 'a hero image' })
    expect(ref.providerRef).toBe('abc123')
  })

  it('submit() includes inputImage in the request body when referenceImageUrl is given', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, msg: 'success', data: { taskId: 'abc123' } }),
        text: async () => '',
      }
    }) as unknown as typeof fetch
    const gen = new KieImageGenerator('test-key', fetchImpl)
    await gen.submit({ prompt: 'a hero image', referenceImageUrl: 'https://example.com/truck.jpg' })
    expect(JSON.parse(capturedBody!)).toMatchObject({
      prompt: 'a hero image',
      inputImage: 'https://example.com/truck.jpg',
    })
  })

  it('submit() defaults aspectRatio to 1:1 when not given (blog/image_post behavior, unchanged)', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, msg: 'success', data: { taskId: 'abc123' } }),
        text: async () => '',
      }
    }) as unknown as typeof fetch
    const gen = new KieImageGenerator('test-key', fetchImpl)
    await gen.submit({ prompt: 'a hero image' })
    expect(JSON.parse(capturedBody!)).toMatchObject({ aspectRatio: '1:1' })
  })

  it('submit() passes a given aspectRatio straight through (video-only callers)', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, msg: 'success', data: { taskId: 'abc123' } }),
        text: async () => '',
      }
    }) as unknown as typeof fetch
    const gen = new KieImageGenerator('test-key', fetchImpl)
    await gen.submit({ prompt: 'a scene image', aspectRatio: '9:16' })
    expect(JSON.parse(capturedBody!)).toMatchObject({ aspectRatio: '9:16' })
  })

  it('submit() omits inputImage entirely when no referenceImageUrl is given', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, msg: 'success', data: { taskId: 'abc123' } }),
        text: async () => '',
      }
    }) as unknown as typeof fetch
    const gen = new KieImageGenerator('test-key', fetchImpl)
    await gen.submit({ prompt: 'a hero image' })
    expect(JSON.parse(capturedBody!)).not.toHaveProperty('inputImage')
  })

  it('submit() throws ProviderCallError when data.taskId is missing', async () => {
    const fetchImpl = mockFetch({ jsonBody: { code: 200, msg: 'success', data: {} } })
    const gen = new KieImageGenerator('test-key', fetchImpl)
    await expect(gen.submit({ prompt: 'x' })).rejects.toThrow(ProviderCallError)
  })

  it('submit() throws ProviderCallError when code is not 200', async () => {
    const fetchImpl = mockFetch({ jsonBody: { code: 401, msg: 'You do not have access permissions' } })
    const gen = new KieImageGenerator('test-key', fetchImpl)
    await expect(gen.submit({ prompt: 'x' })).rejects.toThrow(ProviderCallError)
  })

  it('poll() returns pending while successFlag is 0 (GENERATING)', async () => {
    const fetchImpl = mockFetch({ jsonBody: { data: { successFlag: 0 } } })
    const gen = new KieImageGenerator('test-key', fetchImpl)
    const result = await gen.poll({ providerRef: 'abc123' })
    expect(result).toEqual({ status: 'pending' })
  })

  it('poll() returns ready with fileUrl on successFlag 1 (SUCCESS)', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { data: { successFlag: 1, response: { resultImageUrl: 'https://example.com/img.png' } } },
    })
    const gen = new KieImageGenerator('test-key', fetchImpl)
    const result = await gen.poll({ providerRef: 'abc123' })
    expect(result).toEqual({ status: 'ready', fileUrl: 'https://example.com/img.png' })
  })

  it('poll() returns failed with a detail message on successFlag 2/3', async () => {
    const fetchImpl = mockFetch({ jsonBody: { data: { successFlag: 3, errorMessage: 'content policy' } } })
    const gen = new KieImageGenerator('test-key', fetchImpl)
    const result = await gen.poll({ providerRef: 'abc123' })
    expect(result).toEqual({ status: 'failed', detail: 'content policy' })
  })

  it('poll() throws ProviderCallError on a non-ok HTTP response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 500, textBody: 'server error' })
    const gen = new KieImageGenerator('test-key', fetchImpl)
    await expect(gen.poll({ providerRef: 'abc123' })).rejects.toThrow(ProviderCallError)
  })
})

describe('KieVideoGenerator (Seedance 1.5 Pro image-to-video — docs.kie.ai/market)', () => {
  it('submit() sends model=bytedance/seedance-1.5-pro with the scene image in input_urls, resolution=720p, and generate_audio=false', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, msg: 'success', data: { taskId: 'task_seedance_1' } }),
        text: async () => '',
      }
    }) as unknown as typeof fetch
    const gen = new KieVideoGenerator('test-key', fetchImpl)
    const ref = await gen.submit({
      prompt: 'the truck pulls up to the curb',
      referenceImageUrl: 'https://example.com/scene-1.png',
      durationSeconds: '5',
      aspectRatio: '9:16',
    })
    expect(ref.providerRef).toBe('task_seedance_1')
    expect(JSON.parse(capturedBody!)).toEqual({
      model: 'bytedance/seedance-1.5-pro',
      input: {
        prompt: 'the truck pulls up to the curb',
        input_urls: ['https://example.com/scene-1.png'],
        aspect_ratio: '9:16',
        resolution: '720p',
        generate_audio: false,
        duration: 5,
      },
    })
  })

  it('submit() throws ProviderCallError when data.taskId is missing', async () => {
    const fetchImpl = mockFetch({ jsonBody: { code: 200, msg: 'success', data: {} } })
    const gen = new KieVideoGenerator('test-key', fetchImpl)
    await expect(
      gen.submit({
        prompt: 'x',
        referenceImageUrl: 'https://example.com/a.png',
        durationSeconds: '5',
        aspectRatio: '9:16',
      }),
    ).rejects.toThrow(ProviderCallError)
  })

  it('poll() returns pending while state is waiting/queuing/generating', async () => {
    const gen = new KieVideoGenerator('test-key', mockFetch({ jsonBody: { data: { state: 'generating' } } }))
    expect(await gen.poll({ providerRef: 'task_1' })).toEqual({ status: 'pending' })
  })

  it('poll() returns ready with fileUrl parsed from resultJson.resultUrls[0] on state=success', async () => {
    const fetchImpl = mockFetch({
      jsonBody: {
        data: {
          state: 'success',
          resultJson: JSON.stringify({ resultUrls: ['https://example.com/clip.mp4'] }),
        },
      },
    })
    const gen = new KieVideoGenerator('test-key', fetchImpl)
    const result = await gen.poll({ providerRef: 'task_1' })
    expect(result).toEqual({ status: 'ready', fileUrl: 'https://example.com/clip.mp4' })
  })

  it('poll() returns failed when state=success but resultJson has no resultUrls', async () => {
    const fetchImpl = mockFetch({ jsonBody: { data: { state: 'success', resultJson: JSON.stringify({}) } } })
    const gen = new KieVideoGenerator('test-key', fetchImpl)
    const result = await gen.poll({ providerRef: 'task_1' })
    expect(result.status).toBe('failed')
  })

  it('poll() returns failed with failMsg on state=fail', async () => {
    const fetchImpl = mockFetch({ jsonBody: { data: { state: 'fail', failMsg: 'content policy violation' } } })
    const gen = new KieVideoGenerator('test-key', fetchImpl)
    const result = await gen.poll({ providerRef: 'task_1' })
    expect(result).toEqual({ status: 'failed', detail: 'content policy violation' })
  })

  it('poll() throws ProviderCallError on a non-ok HTTP response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 404, textBody: 'Task not found' })
    const gen = new KieVideoGenerator('test-key', fetchImpl)
    await expect(gen.poll({ providerRef: 'task_1' })).rejects.toThrow(ProviderCallError)
  })
})
