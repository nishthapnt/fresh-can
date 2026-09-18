import { describe, it, expect, vi } from 'vitest'
import { ElevenLabsVoiceSynthesizer } from './elevenlabs'
import { ProviderCallError } from './types'

function mockFetch(opts: { ok?: boolean; status?: number; audio?: Uint8Array; requestId?: string; textBody?: string }) {
  const audio = opts.audio ?? new Uint8Array([1, 2, 3])
  return vi.fn(async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (name: string) => (name === 'request-id' ? opts.requestId ?? null : null) },
    arrayBuffer: async () => audio.buffer,
    text: async () => opts.textBody ?? '',
  })) as unknown as typeof fetch
}

describe('ElevenLabsVoiceSynthesizer', () => {
  it('synthesize() returns the raw audio bytes as a Buffer', async () => {
    const audio = new Uint8Array([10, 20, 30])
    const fetchImpl = mockFetch({ audio, requestId: 'req-abc' })
    const synth = new ElevenLabsVoiceSynthesizer('test-key', fetchImpl)
    const result = await synth.synthesize({ text: 'hello', voiceId: 'voice-1' })
    expect(Buffer.from(result.audioBuffer)).toEqual(Buffer.from(audio))
    expect(result.providerRef).toBe('req-abc')
  })

  it('synthesize() calls the correct URL with the voiceId path-encoded and xi-api-key header', async () => {
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedHeaders = init?.headers as Record<string, string>
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
        text: async () => '',
      }
    }) as unknown as typeof fetch
    const synth = new ElevenLabsVoiceSynthesizer('secret-key', fetchImpl)
    await synth.synthesize({ text: 'bonjour', voiceId: 'voice with spaces' })
    expect(capturedUrl).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice%20with%20spaces')
    expect(capturedHeaders['xi-api-key']).toBe('secret-key')
  })

  it('synthesize() throws ProviderCallError on a non-ok HTTP response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid api key' })
    const synth = new ElevenLabsVoiceSynthesizer('bad-key', fetchImpl)
    await expect(synth.synthesize({ text: 'x', voiceId: 'v' })).rejects.toThrow(ProviderCallError)
  })

  it('synthesize() throws ProviderCallError when the response body is empty', async () => {
    const fetchImpl = mockFetch({ audio: new Uint8Array([]) })
    const synth = new ElevenLabsVoiceSynthesizer('test-key', fetchImpl)
    await expect(synth.synthesize({ text: 'x', voiceId: 'v' })).rejects.toThrow(ProviderCallError)
  })

  it('falls back to a synthetic providerRef when no request-id header is present', async () => {
    const fetchImpl = mockFetch({})
    const synth = new ElevenLabsVoiceSynthesizer('test-key', fetchImpl)
    const result = await synth.synthesize({ text: 'x', voiceId: 'v' })
    expect(result.providerRef).toMatch(/^elevenlabs-\d+$/)
  })
})
