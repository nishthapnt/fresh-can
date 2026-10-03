import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCredentialCaches, CREDENTIAL_UNAVAILABLE_PREFIX, CredentialError, CredentialUnavailableError, getActiveCredentialRef, getApiKey, getUploadPostProfile,
  listCredentialStatuses, pinJobCredentials, purgeRetiredCredentials, resetCredential, saveCredential,
} from './credentials'
import { createFakeCredentialRepo } from './credentialsFakeRepo'

const ENV_KEYS = ['OPENAI_API_KEY', 'KIE_API_KEY', 'UPLOAD_POST_API_KEY', 'UPLOAD_POST_PROFILE', 'CREDENTIALS_ENCRYPTION_KEY'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  process.env.OPENAI_API_KEY = 'env-openai-0000'
  process.env.KIE_API_KEY = 'env-kie-0000'
  process.env.UPLOAD_POST_API_KEY = 'env-up-0000'
  process.env.UPLOAD_POST_PROFILE = 'env-profile'
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
  clearCredentialCaches()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.restoreAllMocks()
})

const save = (repo: ReturnType<typeof createFakeCredentialRepo>['repo'], provider: 'openai' | 'kie' | 'upload_post', value: string, profile: string | null = null) =>
  saveCredential(provider, { value, profile, updatedBy: 't' }, repo)

describe('getApiKey resolution', () => {
  it('falls back to the env var when no custom credential exists', async () => {
    const { repo } = createFakeCredentialRepo()
    expect(await getApiKey('openai', { repo })).toBe('env-openai-0000')
  })

  it('returns the custom credential when one exists, and stores only ciphertext', async () => {
    const { repo, rows } = createFakeCredentialRepo()
    await save(repo, 'openai', 'sk-custom-9999')
    expect(await getApiKey('openai', { repo })).toBe('sk-custom-9999')
    const row = [...rows.values()][0]
    expect(JSON.stringify(row)).not.toContain('sk-custom-9999')
    expect(row.last4).toBe('9999')
  })

  it('returns to the env var after reset', async () => {
    const { repo } = createFakeCredentialRepo()
    await save(repo, 'openai', 'sk-custom-9999')
    expect(await resetCredential('openai', repo)).toBe(true)
    clearCredentialCaches()
    expect(await getApiKey('openai', { repo })).toBe('env-openai-0000')
  })

  it('reset with nothing to reset is a no-op', async () => {
    const { repo } = createFakeCredentialRepo()
    expect(await resetCredential('kie', repo)).toBe(false)
  })

  it('keeps the existing env behavior when the env var is missing', async () => {
    delete process.env.KIE_API_KEY
    const { repo } = createFakeCredentialRepo()
    await expect(getApiKey('kie', { repo })).rejects.toThrow('Missing required env var: KIE_API_KEY')
  })

  it('does not fall back to the env key when decryption fails', async () => {
    const { repo, rows } = createFakeCredentialRepo()
    await save(repo, 'openai', 'sk-custom-9999')
    process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64') // rotated/wrong key
    clearCredentialCaches()
    await expect(getApiKey('openai', { repo })).rejects.toBeInstanceOf(CredentialError)
    expect(rows.size).toBe(1)
  })
})

describe('job credential pinning', () => {
  it('a job keeps its account when Settings changes mid-job', async () => {
    const { repo, addJob } = createFakeCredentialRepo()
    addJob('job-1')
    await save(repo, 'openai', 'sk-first-1111')
    await pinJobCredentials('job-1', repo)

    await save(repo, 'openai', 'sk-second-2222') // switch after the job started
    clearCredentialCaches() // simulate a different process / replay

    expect(await getApiKey('openai', { jobId: 'job-1', repo })).toBe('sk-first-1111')
    addJob('job-2')
    expect(await getApiKey('openai', { jobId: 'job-2', repo })).toBe('sk-second-2222')
  })

  it('a job pinned to the default stays on the default after a custom key is added', async () => {
    const { repo, addJob } = createFakeCredentialRepo()
    addJob('job-1')
    await pinJobCredentials('job-1', repo)
    await save(repo, 'kie', 'kie-custom-3333')
    clearCredentialCaches()
    expect(await getApiKey('kie', { jobId: 'job-1', repo })).toBe('env-kie-0000')
  })

  it('pins lazily on first use and never re-pins', async () => {
    const { repo, addJob, jobs } = createFakeCredentialRepo()
    addJob('job-1')
    await getApiKey('openai', { jobId: 'job-1', repo })
    const pins = jobs.get('job-1')
    expect(pins).toBeTruthy()
    await save(repo, 'openai', 'sk-later-4444')
    clearCredentialCaches()
    expect(await getApiKey('openai', { jobId: 'job-1', repo })).toBe('env-openai-0000')
    expect(jobs.get('job-1')).toEqual(pins)
  })

  it('pins hold ids only, never key material', async () => {
    const { repo, addJob, jobs } = createFakeCredentialRepo()
    addJob('job-1')
    await save(repo, 'openai', 'sk-first-1111')
    await pinJobCredentials('job-1', repo)
    expect(JSON.stringify(jobs.get('job-1'))).not.toContain('sk-first-1111')
  })

  it('retry after Settings switched A→B still uses A (Inngest rerun / delayed execution)', async () => {
    const { repo, addJob } = createFakeCredentialRepo()
    addJob('job-1')
    await save(repo, 'openai', 'sk-A-1111')
    await pinJobCredentials('job-1', repo)
    await save(repo, 'openai', 'sk-B-2222')
    for (let i = 0; i < 3; i++) {
      clearCredentialCaches() // each replay/retry may be a fresh process
      expect(await getApiKey('openai', { jobId: 'job-1', repo })).toBe('sk-A-1111')
    }
  })

  it('approval/resume path: a later function run for the same job resolves the original account', async () => {
    const { repo, addJob, unfinished } = createFakeCredentialRepo()
    addJob('job-1')
    await save(repo, 'kie', 'kie-A-1111')
    // run 1 (generate): pins at job start
    await pinJobCredentials('job-1', repo)
    unfinished.add('job-1') // sitting at draft_ready awaiting user approval
    await save(repo, 'kie', 'kie-B-2222')
    await resetCredential('kie', repo) // and then back to the env default
    await purgeRetiredCredentials(repo, 0) // days later, Settings loaded
    // run 2 (approve → render), different process
    clearCredentialCaches()
    expect(await getApiKey('kie', { jobId: 'job-1', repo })).toBe('kie-A-1111')
  })

  it('a retired credential an unfinished job needs is retained and still used on retry', async () => {
    const { repo, addJob, unfinished, rows } = createFakeCredentialRepo()
    addJob('job-1')
    await save(repo, 'openai', 'sk-A-1111')
    await pinJobCredentials('job-1', repo)
    unfinished.add('job-1')
    await resetCredential('openai', repo) // A retired
    expect(await purgeRetiredCredentials(repo, 0)).toBe(0)
    expect(rows.size).toBe(1)
    clearCredentialCaches()
    expect(await getApiKey('openai', { jobId: 'job-1', repo })).toBe('sk-A-1111')
  })

  it('NEVER falls back to the active credential when the pinned one is unavailable', async () => {
    const { repo, addJob, rows, jobs } = createFakeCredentialRepo()
    addJob('job-1')
    await save(repo, 'openai', 'sk-A-1111')
    await pinJobCredentials('job-1', repo)
    await save(repo, 'openai', 'sk-B-2222')
    // Simulate A genuinely gone (e.g. purged/manually deleted).
    const [aId] = [...rows.values()].filter((r) => r.retired_at).map((r) => r.id)
    rows.delete(aId)
    clearCredentialCaches()

    const pinsBefore = JSON.stringify(jobs.get('job-1'))
    const err = await getApiKey('openai', { jobId: 'job-1', repo }).catch((e) => e)
    expect(err).toBeInstanceOf(CredentialUnavailableError)
    expect(err.message).toContain(CREDENTIAL_UNAVAILABLE_PREFIX)
    expect(err.message).not.toContain('sk-B-2222')
    expect(err.name).toBe('CredentialUnavailableError')
    // not retried by Inngest, and the pin was not rewritten
    expect(err.constructor.name).toBe('CredentialUnavailableError')
    expect(JSON.stringify(jobs.get('job-1'))).toBe(pinsBefore)
  })

  it('a job pinned to a purged credential fails for the default→custom case too', async () => {
    const { repo, addJob, jobs } = createFakeCredentialRepo()
    addJob('job-1')
    jobs.set('job-1', { openai: '00000000-0000-0000-0000-000000000000' })
    await expect(getApiKey('openai', { jobId: 'job-1', repo })).rejects.toBeInstanceOf(CredentialUnavailableError)
  })

  it('a NEW job after switching to B uses B', async () => {
    const { repo, addJob } = createFakeCredentialRepo()
    addJob('old')
    await save(repo, 'openai', 'sk-A-1111')
    await pinJobCredentials('old', repo)
    await save(repo, 'openai', 'sk-B-2222')
    addJob('new')
    await pinJobCredentials('new', repo)
    clearCredentialCaches()
    expect(await getApiKey('openai', { jobId: 'new', repo })).toBe('sk-B-2222')
    expect(await getApiKey('openai', { jobId: 'old', repo })).toBe('sk-A-1111')
  })
})

describe('retention of retired credentials', () => {
  it('keeps a retired version while an unfinished job pins it, then purges it', async () => {
    const { repo, addJob, unfinished, rows } = createFakeCredentialRepo()
    addJob('job-1')
    await save(repo, 'openai', 'sk-first-1111')
    await pinJobCredentials('job-1', repo)
    unfinished.add('job-1')
    await save(repo, 'openai', 'sk-second-2222')

    expect(await purgeRetiredCredentials(repo, 0)).toBe(0)
    expect(rows.size).toBe(2)
    clearCredentialCaches()
    expect(await getApiKey('openai', { jobId: 'job-1', repo })).toBe('sk-first-1111')

    unfinished.delete('job-1')
    expect(await purgeRetiredCredentials(repo, 0)).toBe(1)
    expect(rows.size).toBe(1)
  })

  it('respects the grace period', async () => {
    const { repo, rows } = createFakeCredentialRepo()
    await save(repo, 'openai', 'sk-first-1111')
    await save(repo, 'openai', 'sk-second-2222')
    expect(await purgeRetiredCredentials(repo)).toBe(0) // default 24h grace
    expect(rows.size).toBe(2)
  })
})

describe('status + upload-post profile', () => {
  it('lists safe metadata only', async () => {
    const { repo } = createFakeCredentialRepo()
    await save(repo, 'openai', 'sk-custom-9999')
    const statuses = await listCredentialStatuses(repo)
    expect(statuses).toHaveLength(5)
    expect(statuses.find((s) => s.provider === 'openai')).toMatchObject({ source: 'custom', last4: '9999' })
    expect(statuses.find((s) => s.provider === 'kie')).toMatchObject({ source: 'default', last4: null, defaultConfigured: true })
    const text = JSON.stringify(statuses)
    expect(text).not.toContain('sk-custom-9999')
    expect(text).not.toContain('env-kie-0000')
    expect(text).not.toContain('encrypted')
  })

  it('upload_post: custom key carries its own profile, default uses the env profile', async () => {
    const { repo } = createFakeCredentialRepo()
    expect(await getUploadPostProfile({ repo })).toBe('env-profile')
    await save(repo, 'upload_post', 'up-custom-5555', 'other-profile')
    expect(await getUploadPostProfile({ repo })).toBe('other-profile')
    const ref = await getActiveCredentialRef('upload_post', repo)
    expect(await getApiKey('upload_post', { ref, repo })).toBe('up-custom-5555')
  })
})
