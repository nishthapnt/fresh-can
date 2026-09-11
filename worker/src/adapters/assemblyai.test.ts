import { describe, it, expect, vi } from 'vitest'
import { AssemblyAITranscriptionService } from './assemblyai.js'
import { ProviderCallError } from './types.js'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  })) as unknown as typeof fetch
}

describe('AssemblyAITranscriptionService', () => {
  it('submit() returns a providerRef from data.id', async () => {
    const fetchImpl = mockFetch({ jsonBody: { id: 'transcript-abc' } })
    const svc = new AssemblyAITranscriptionService('test-key', fetchImpl)
    const ref = await svc.submit({ audioUrl: 'https://example.com/audio.mp3' })
    expect(ref.providerRef).toBe('transcript-abc')
  })

  it('submit() sends audio_url in the body and the authorization header (no Bearer prefix)', async () => {
    let capturedBody: string | undefined
    let capturedHeaders: Record<string, string> = {}
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      capturedHeaders = init?.headers as Record<string, string>
      return { ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '' }
    }) as unknown as typeof fetch
    const svc = new AssemblyAITranscriptionService('secret-key', fetchImpl)
    await svc.submit({ audioUrl: 'https://example.com/audio.mp3' })
    expect(JSON.parse(capturedBody!)).toEqual({ audio_url: 'https://example.com/audio.mp3' })
    expect(capturedHeaders.authorization).toBe('secret-key')
  })

  it('submit() throws ProviderCallError when data.id is missing', async () => {
    const fetchImpl = mockFetch({ jsonBody: { error: 'invalid audio_url' } })
    const svc = new AssemblyAITranscriptionService('test-key', fetchImpl)
    await expect(svc.submit({ audioUrl: 'bad' })).rejects.toThrow(ProviderCallError)
  })

  it('poll() returns pending while status is queued or processing', async () => {
    const fetchImpl = mockFetch({ jsonBody: { status: 'queued' } })
    const svc = new AssemblyAITranscriptionService('test-key', fetchImpl)
    expect(await svc.poll({ providerRef: 'abc' })).toEqual({ status: 'pending' })
  })

  it('poll() returns ready with timingData and text on completed', async () => {
    const words = [{ text: 'hello', start: 0, end: 500 }]
    const fetchImpl = mockFetch({ jsonBody: { status: 'completed', text: 'hello', words } })
    const svc = new AssemblyAITranscriptionService('test-key', fetchImpl)
    const result = await svc.poll({ providerRef: 'abc' })
    expect(result).toEqual({ status: 'ready', timingData: words, text: 'hello' })
  })

  it('poll() returns failed with a detail message on error', async () => {
    const fetchImpl = mockFetch({ jsonBody: { status: 'error', error: 'download failed' } })
    const svc = new AssemblyAITranscriptionService('test-key', fetchImpl)
    expect(await svc.poll({ providerRef: 'abc' })).toEqual({ status: 'failed', detail: 'download failed' })
  })

  it('poll() throws ProviderCallError on a non-ok HTTP response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 500, textBody: 'server error' })
    const svc = new AssemblyAITranscriptionService('test-key', fetchImpl)
    await expect(svc.poll({ providerRef: 'abc' })).rejects.toThrow(ProviderCallError)
  })
})
