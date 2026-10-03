import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth'
import { createFakeCredentialRepo } from '@/server/pipeline/credentialsFakeRepo'

const h = vi.hoisted(() => ({ repo: null as null | import('@/server/pipeline/credentials').CredentialRepo, posting: 0, purgeFails: false }))

// Run the REAL credentials logic against an in-memory repo.
vi.mock('@/server/pipeline/credentials', async (orig) => {
  const actual = await orig<typeof import('@/server/pipeline/credentials')>()
  return {
    ...actual,
    listCredentialStatuses: () => actual.listCredentialStatuses(h.repo!),
    saveCredential: (p: never, i: never) => actual.saveCredential(p, i, h.repo!),
    resetCredential: (p: never) => actual.resetCredential(p, h.repo!),
    purgeRetiredCredentials: async () => {
      if (h.purgeFails) throw new Error('purge boom')
      return actual.purgeRetiredCredentials(h.repo!)
    },
  }
})
vi.mock('@/server/pipeline/db', () => ({
  createServiceClient: () => ({}),
  getPostingSocialPlatformLogGroups: async () => new Map(h.posting ? [['ref', []]] : []),
}))

import { GET } from './route'
import { DELETE, PUT } from './[provider]/route'
import { proxy } from '@/proxy'

const SECRET = 'test-auth-secret'
const SUBMITTED = 'sk-submitted-SECRET9876'
let fake: ReturnType<typeof createFakeCredentialRepo>
let cookie: string
// The route's attempt throttle is module-level; step the clock a window ahead
// per test so tests don't consume each other's budget.
let clock = Date.now()

function req(method: string, url: string, body?: unknown, authed = true) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: authed ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  })
}
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) })
const providerOk = (status = 200, body: unknown = {}) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: status < 300, status, json: async () => body } as Response)

beforeEach(async () => {
  clock += 61_000
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
  process.env.AUTH_SECRET = SECRET
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
  cookie = await createSessionToken(SECRET, 3600)
  fake = createFakeCredentialRepo()
  h.repo = fake.repo
  h.posting = 0
  h.purgeFails = false
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('authentication', () => {
  it('rejects every method without a session cookie', async () => {
    expect((await GET(req('GET', '/api/settings/keys', undefined, false))).status).toBe(401)
    expect((await PUT(req('PUT', '/api/settings/keys/openai', { value: SUBMITTED }, false), ctx('openai'))).status).toBe(401)
    expect((await DELETE(req('DELETE', '/api/settings/keys/openai', undefined, false), ctx('openai'))).status).toBe(401)
  })

  it('rejects a forged session cookie', async () => {
    const forged = new NextRequest('http://localhost/api/settings/keys', { headers: { cookie: `${SESSION_COOKIE}=999999999999999.deadbeef` } })
    expect((await GET(forged)).status).toBe(401)
  })

  it('the proxy also gates the settings page and routes', async () => {
    const page = await proxy(new NextRequest('http://localhost/dashboard/settings'))
    const api = await proxy(new NextRequest('http://localhost/api/settings/keys'))
    expect(page.headers.get('location')).toContain('/login')
    expect(api.headers.get('location')).toContain('/login')
  })
})

describe('PUT /api/settings/keys/[provider]', () => {
  it('rejects unknown providers', async () => {
    for (const p of ['nope', 'OPENAI_API_KEY', '__proto__']) {
      expect((await PUT(req('PUT', `/api/settings/keys/${p}`, { value: SUBMITTED }), ctx(p))).status).toBe(404)
    }
  })

  it('rejects a malformed body', async () => {
    expect((await PUT(req('PUT', '/api/settings/keys/openai', { value: 'short' }), ctx('openai'))).status).toBe(400)
    expect((await PUT(req('PUT', '/api/settings/keys/openai', { value: 'has space inside key' }), ctx('openai'))).status).toBe(400)
    expect((await PUT(req('PUT', '/api/settings/keys/openai', { nothing: true }), ctx('openai'))).status).toBe(400)
  })

  it('does not save a key the provider rejects, and the error does not echo the key', async () => {
    providerOk(401)
    const res = await PUT(req('PUT', '/api/settings/keys/openai', { value: SUBMITTED }), ctx('openai'))
    expect(res.status).toBe(422)
    expect(await res.text()).not.toContain(SUBMITTED)
    expect(fake.rows.size).toBe(0)
  })

  it('saves a valid key encrypted and returns safe metadata only', async () => {
    providerOk(200)
    const res = await PUT(req('PUT', '/api/settings/keys/openai', { value: SUBMITTED }), ctx('openai'))
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain(SUBMITTED)
    expect(JSON.parse(text).key).toMatchObject({ provider: 'openai', source: 'custom', last4: '9876' })
    const row = [...fake.rows.values()][0]
    expect(row.encrypted_value).not.toContain(SUBMITTED)
    expect(JSON.stringify([...fake.rows.values()])).not.toContain(SUBMITTED)
  })

  it('a failed replacement leaves the existing custom key active', async () => {
    providerOk(200)
    await PUT(req('PUT', '/api/settings/keys/openai', { value: SUBMITTED }), ctx('openai'))
    const before = [...fake.rows.values()].filter((r) => !r.retired_at)
    providerOk(401)
    const res = await PUT(req('PUT', '/api/settings/keys/openai', { value: 'sk-bad-replacement-0000' }), ctx('openai'))
    expect(res.status).toBe(422)
    const after = [...fake.rows.values()].filter((r) => !r.retired_at)
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))
    expect(fake.rows.size).toBe(1)
  })

  it('upload_post requires a profile that exists under the key', async () => {
    providerOk(200, { profiles: [{ username: 'acme' }] })
    expect((await PUT(req('PUT', '/api/settings/keys/upload_post', { value: SUBMITTED }), ctx('upload_post'))).status).toBe(400)
    expect((await PUT(req('PUT', '/api/settings/keys/upload_post', { value: SUBMITTED, profile: 'nope' }), ctx('upload_post'))).status).toBe(422)
    const ok = await PUT(req('PUT', '/api/settings/keys/upload_post', { value: SUBMITTED, profile: 'acme' }), ctx('upload_post'))
    expect(ok.status).toBe(200)
    expect([...fake.rows.values()][0].profile).toBe('acme')
  })

  it('refuses to swap the upload-post account while posts are publishing', async () => {
    providerOk(200, { profiles: [{ username: 'acme' }] })
    h.posting = 1
    const res = await PUT(req('PUT', '/api/settings/keys/upload_post', { value: SUBMITTED, profile: 'acme' }), ctx('upload_post'))
    expect(res.status).toBe(409)
    expect(fake.rows.size).toBe(0)
  })

  it('503s (without saving) when the encryption secret is not configured', async () => {
    delete process.env.CREDENTIALS_ENCRYPTION_KEY
    providerOk(200)
    const res = await PUT(req('PUT', '/api/settings/keys/openai', { value: SUBMITTED }), ctx('openai'))
    expect(res.status).toBe(503)
    expect(fake.rows.size).toBe(0)
  })

  it('throttles repeated write attempts with 429', async () => {
    providerOk(401)
    const codes: number[] = []
    for (let i = 0; i < 11; i++) {
      codes.push((await PUT(req('PUT', '/api/settings/keys/openai', { value: SUBMITTED }), ctx('openai'))).status)
    }
    expect(codes.slice(0, 10).every((c) => c === 422)).toBe(true)
    expect(codes[10]).toBe(429)
  })

  it('never logs the submitted key', async () => {
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    providerOk(200)
    await PUT(req('PUT', '/api/settings/keys/openai', { value: SUBMITTED }), ctx('openai'))
    providerOk(401)
    await PUT(req('PUT', '/api/settings/keys/openai', { value: SUBMITTED }), ctx('openai'))
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls])
    expect(logged).not.toContain(SUBMITTED)
    expect(logged).not.toContain([...fake.rows.values()][0].encrypted_value)
  })
})

describe('DELETE + GET', () => {
  it('reset removes the custom key (kept for pinned jobs) and GET shows default again', async () => {
    providerOk(200)
    await PUT(req('PUT', '/api/settings/keys/openai', { value: SUBMITTED }), ctx('openai'))
    const res = await DELETE(req('DELETE', '/api/settings/keys/openai'), ctx('openai'))
    const body = await res.json()
    expect(body).toMatchObject({ success: true, removed: true, key: { provider: 'openai', source: 'default', last4: null } })
    expect([...fake.rows.values()].filter((r) => !r.retired_at)).toHaveLength(0)
  })

  it('reset with no custom key is a clean no-op; unknown provider is 404', async () => {
    const res = await DELETE(req('DELETE', '/api/settings/keys/kie'), ctx('kie'))
    expect(await res.json()).toMatchObject({ success: true, removed: false })
    expect((await DELETE(req('DELETE', '/api/settings/keys/zzz'), ctx('zzz'))).status).toBe(404)
  })

  it('GET still succeeds when the best-effort purge fails', async () => {
    h.purgeFails = true
    const res = await GET(req('GET', '/api/settings/keys'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('purge failed'), 'purge boom')
  })

  it('GET never returns plaintext, ciphertext, or default env keys', async () => {
    process.env.KIE_API_KEY = 'env-kie-DEFAULTSECRET'
    providerOk(200)
    await PUT(req('PUT', '/api/settings/keys/openai', { value: SUBMITTED }), ctx('openai'))
    const text = await (await GET(req('GET', '/api/settings/keys'))).text()
    expect(text).not.toContain(SUBMITTED)
    expect(text).not.toContain('DEFAULTSECRET')
    expect(text).not.toContain([...fake.rows.values()][0].encrypted_value)
    expect(JSON.parse(text).keys.find((k: { provider: string }) => k.provider === 'openai')).toMatchObject({ source: 'custom', last4: '9876' })
  })
})
