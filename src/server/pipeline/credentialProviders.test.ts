import { describe, expect, it, vi } from 'vitest'
import { isProviderId, PROVIDERS, PROVIDER_IDS } from './credentialProviders'

const res = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response
const mockFetch = (r: Response | Error) =>
  vi.fn(async () => { if (r instanceof Error) throw r; return r }) as unknown as typeof fetch

describe('provider allowlist', () => {
  it('only accepts known provider ids', () => {
    for (const id of PROVIDER_IDS) expect(isProviderId(id)).toBe(true)
    for (const bad of ['', 'OPENAI_API_KEY', '__proto__', 'constructor', 'SUPABASE_SERVICE_ROLE_KEY', 42, null]) {
      expect(isProviderId(bad)).toBe(false)
    }
  })
})

describe('validators (mocked provider APIs)', () => {
  it('openai: ok / invalid / rate limited / unavailable / network error', async () => {
    const v = PROVIDERS.openai.validate
    expect(await v('k', { fetchImpl: mockFetch(res(200, {})) })).toEqual({ ok: true })
    expect(await v('k', { fetchImpl: mockFetch(res(401)) })).toEqual({ ok: false, reason: 'invalid' })
    expect(await v('k', { fetchImpl: mockFetch(res(429)) })).toEqual({ ok: false, reason: 'rate_limited' })
    expect(await v('k', { fetchImpl: mockFetch(res(503)) })).toEqual({ ok: false, reason: 'unavailable' })
    expect(await v('k', { fetchImpl: mockFetch(new Error('boom')) })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('sends the key to the provider only in a header, never in the URL', async () => {
    const fetchImpl = mockFetch(res(200, {}))
    await PROVIDERS.openai.validate('sk-secret-abcd', { fetchImpl })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(url)).not.toContain('sk-secret-abcd')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-secret-abcd' })
  })

  it('kie: checks the JSON code, not just HTTP status', async () => {
    const v = PROVIDERS.kie.validate
    expect(await v('k', { fetchImpl: mockFetch(res(200, { code: 200, data: 120 })) })).toEqual({ ok: true })
    expect(await v('k', { fetchImpl: mockFetch(res(200, { code: 401, msg: 'bad' })) })).toEqual({ ok: false, reason: 'invalid' })
    expect(await v('k', { fetchImpl: mockFetch(res(200, { code: 500 })) })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('elevenlabs: a scoped key missing user_read is still valid; a bad key is not', async () => {
    const v = PROVIDERS.elevenlabs.validate
    expect(await v('k', { fetchImpl: mockFetch(res(401, { detail: { status: 'missing_permissions' } })) })).toEqual({ ok: true })
    expect(await v('k', { fetchImpl: mockFetch(res(401, { detail: { status: 'invalid_api_key' } })) })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('assemblyai: ok / invalid', async () => {
    const v = PROVIDERS.assemblyai.validate
    expect(await v('k', { fetchImpl: mockFetch(res(200, {})) })).toEqual({ ok: true })
    expect(await v('k', { fetchImpl: mockFetch(res(401)) })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('upload_post: profile must exist under the key', async () => {
    const v = PROVIDERS.upload_post.validate
    const profiles = res(200, { profiles: [{ username: 'acme' }] })
    expect(await v('k', { profile: 'acme', fetchImpl: mockFetch(profiles) })).toEqual({ ok: true })
    expect(await v('k', { profile: 'nope', fetchImpl: mockFetch(profiles) })).toEqual({ ok: false, reason: 'profile_not_found' })
    expect(await v('k', { profile: 'acme', fetchImpl: mockFetch(res(401)) })).toEqual({ ok: false, reason: 'invalid' })
  })
})
