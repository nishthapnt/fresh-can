import { describe, it, expect, vi } from 'vitest'
import { KieImageGenerator } from './kie.js'
import { ProviderCallError } from './types.js'

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
