import { describe, expect, it, vi } from 'vitest'
import { getUploadPostAccountInfo } from './uploadPostAccount'

const ok = (body: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch
const BODY = {
  plan: 'default',
  limit: 2,
  profiles: [
    { username: 'acme', social_accounts: { tiktok: '', instagram: { handle: 'x' }, x: { handle: 'y' } } },
    { username: 'other', social_accounts: { facebook: { handle: 'z' } } },
  ],
}

describe('getUploadPostAccountInfo', () => {
  it('returns plan, limit, counts and only the active profile’s connected platforms', async () => {
    const info = await getUploadPostAccountInfo('k', 'acme', ok(BODY))
    expect(info).toEqual({ plan: 'default', profileLimit: 2, profileCount: 2, connectedPlatforms: ['instagram', 'x'] })
    expect(JSON.stringify(info)).not.toContain('other')
  })

  it('has no platform list when no profile is configured or it is not found', async () => {
    expect((await getUploadPostAccountInfo('k', null, ok(BODY))).connectedPlatforms).toBeNull()
    expect((await getUploadPostAccountInfo('k', 'missing', ok(BODY))).connectedPlatforms).toBeNull()
  })

  it('tolerates missing fields', async () => {
    expect(await getUploadPostAccountInfo('k', 'acme', ok({}))).toEqual({ plan: null, profileLimit: null, profileCount: 0, connectedPlatforms: null })
  })

  it('sends the key in a header only', async () => {
    const f = ok(BODY)
    await getUploadPostAccountInfo('sk-secret', 'acme', f)
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(url)).not.toContain('sk-secret')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Apikey sk-secret' })
  })

  it('throws on a provider error without echoing the key', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch
    await expect(getUploadPostAccountInfo('sk-secret', 'acme', f)).rejects.toThrow()
    await getUploadPostAccountInfo('sk-secret', 'acme', f).catch((e) => expect(String(e.message)).not.toContain('sk-secret'))
  })
})
