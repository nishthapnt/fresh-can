import { describe, it, expect, vi } from 'vitest'
import { NanoBananaImageGenerator } from './nanoBanana.js'
import { ProviderCallError } from './types.js'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  })) as unknown as typeof fetch
}

describe('NanoBananaImageGenerator (KIE nano-banana-2)', () => {
  it('submit() returns a providerRef from data.taskId', async () => {
    const fetchImpl = mockFetch({ jsonBody: { code: 200, msg: 'success', data: { taskId: 'abc123' } } })
    const gen = new NanoBananaImageGenerator('test-key', fetchImpl)
    const ref = await gen.submit({ prompt: 'a hero image' })
    expect(ref.providerRef).toBe('abc123')
  })

  it('submit() sends model=nano-banana-2 and wraps referenceImageUrl in an image_input array', async () => {
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
    const gen = new NanoBananaImageGenerator('test-key', fetchImpl)
    await gen.submit({ prompt: 'a hero image', referenceImageUrl: 'https://example.com/ref.jpg' })
    const parsed = JSON.parse(capturedBody!)
    expect(parsed.model).toBe('nano-banana-2')
    expect(parsed.input.image_input).toEqual(['https://example.com/ref.jpg'])
  })

  it('submit() omits image_input when no referenceImageUrl is given', async () => {
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
    const gen = new NanoBananaImageGenerator('test-key', fetchImpl)
    await gen.submit({ prompt: 'a hero image' })
    expect(JSON.parse(capturedBody!).input).not.toHaveProperty('image_input')
  })

  it('submit() throws ProviderCallError when data.taskId is missing', async () => {
    const fetchImpl = mockFetch({ jsonBody: { code: 200, msg: 'success', data: {} } })
    const gen = new NanoBananaImageGenerator('test-key', fetchImpl)
    await expect(gen.submit({ prompt: 'x' })).rejects.toThrow(ProviderCallError)
  })

  it('poll() returns pending while state is "waiting"', async () => {
    const fetchImpl = mockFetch({ jsonBody: { data: { state: 'waiting' } } })
    const gen = new NanoBananaImageGenerator('test-key', fetchImpl)
    const result = await gen.poll({ providerRef: 'abc123' })
    expect(result).toEqual({ status: 'pending' })
  })

  it('poll() returns ready with fileUrl parsed from resultJson.resultUrls[0]', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://example.com/img.png'] }) } },
    })
    const gen = new NanoBananaImageGenerator('test-key', fetchImpl)
    const result = await gen.poll({ providerRef: 'abc123' })
    expect(result).toEqual({ status: 'ready', fileUrl: 'https://example.com/img.png' })
  })

  it('poll() returns failed when state is "success" but resultJson has no resultUrls', async () => {
    const fetchImpl = mockFetch({ jsonBody: { data: { state: 'success', resultJson: JSON.stringify({}) } } })
    const gen = new NanoBananaImageGenerator('test-key', fetchImpl)
    const result = await gen.poll({ providerRef: 'abc123' })
    expect(result.status).toBe('failed')
  })

  it('poll() returns failed with a detail message on state "fail"', async () => {
    const fetchImpl = mockFetch({ jsonBody: { data: { state: 'fail', errorMessage: 'content policy' } } })
    const gen = new NanoBananaImageGenerator('test-key', fetchImpl)
    const result = await gen.poll({ providerRef: 'abc123' })
    expect(result).toEqual({ status: 'failed', detail: 'content policy' })
  })

  it('poll() throws ProviderCallError on a non-ok HTTP response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 500, textBody: 'server error' })
    const gen = new NanoBananaImageGenerator('test-key', fetchImpl)
    await expect(gen.poll({ providerRef: 'abc123' })).rejects.toThrow(ProviderCallError)
  })
})
