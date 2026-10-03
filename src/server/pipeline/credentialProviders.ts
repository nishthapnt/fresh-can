import { env } from './env'

// Explicit provider allowlist + per-provider config. Nothing here ever does
// process.env[userInput] — each provider names its own env var literally, so
// a request-supplied provider string can only select one of these entries.

export const PROVIDER_IDS = ['openai', 'kie', 'elevenlabs', 'assemblyai', 'upload_post'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'rate_limited' | 'unavailable' | 'profile_not_found' }

export interface ValidateOptions {
  /** upload_post only — the profile that must exist under this key's account. */
  profile?: string | null
  fetchImpl?: typeof fetch
}

interface ProviderConfig {
  label: string
  /** Throws (same message as before this feature) when the env var is unset. */
  readDefault: () => string
  /** Non-throwing: is the env fallback configured? */
  hasDefault: () => boolean
  validate: (key: string, opts?: ValidateOptions) => Promise<ValidationResult>
}

const VALIDATE_TIMEOUT_MS = 10_000

function classifyStatus(status: number): ValidationResult {
  if (status === 401 || status === 403) return { ok: false, reason: 'invalid' }
  if (status === 429) return { ok: false, reason: 'rate_limited' }
  return { ok: false, reason: 'unavailable' }
}

async function get(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  try {
    return await fetchImpl(url, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    })
  } catch {
    return null
  }
}

// Every validator is a cheap authenticated READ — never a generation call, so
// validating a key never spends credits.
export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  openai: {
    label: 'OpenAI',
    readDefault: () => env.OPENAI_API_KEY,
    hasDefault: () => !!process.env.OPENAI_API_KEY,
    async validate(key, opts) {
      const res = await get('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` }, opts?.fetchImpl ?? fetch)
      if (!res) return { ok: false, reason: 'unavailable' }
      return res.ok ? { ok: true } : classifyStatus(res.status)
    },
  },
  kie: {
    label: 'KIE.ai',
    readDefault: () => env.KIE_API_KEY,
    hasDefault: () => !!process.env.KIE_API_KEY,
    async validate(key, opts) {
      // Same endpoint as /api/kie/credits. KIE reports auth failures in the
      // JSON body's `code` (often with HTTP 200), so check both.
      const res = await get('https://api.kie.ai/api/v1/chat/credit', { Authorization: `Bearer ${key}` }, opts?.fetchImpl ?? fetch)
      if (!res) return { ok: false, reason: 'unavailable' }
      if (!res.ok) return classifyStatus(res.status)
      const body = (await res.json().catch(() => null)) as { code?: number; data?: unknown } | null
      if (body?.code === 200 && typeof body.data === 'number') return { ok: true }
      if (body?.code === 401 || body?.code === 403) return { ok: false, reason: 'invalid' }
      if (body?.code === 429) return { ok: false, reason: 'rate_limited' }
      return { ok: false, reason: 'unavailable' }
    },
  },
  elevenlabs: {
    label: 'ElevenLabs',
    readDefault: () => env.ELEVENLABS_API_KEY,
    hasDefault: () => !!process.env.ELEVENLABS_API_KEY,
    async validate(key, opts) {
      const res = await get('https://api.elevenlabs.io/v1/user', { 'xi-api-key': key }, opts?.fetchImpl ?? fetch)
      if (!res) return { ok: false, reason: 'unavailable' }
      if (res.ok) return { ok: true }
      if (res.status === 401) {
        // A scoped key (e.g. text-to-speech only) is authenticated but lacks
        // user_read — that is a VALID key, not a bad one.
        const body = (await res.json().catch(() => null)) as { detail?: { status?: string } } | null
        if (body?.detail?.status === 'missing_permissions') return { ok: true }
      }
      return classifyStatus(res.status)
    },
  },
  assemblyai: {
    label: 'AssemblyAI',
    readDefault: () => env.ASSEMBLYAI_API_KEY,
    hasDefault: () => !!process.env.ASSEMBLYAI_API_KEY,
    async validate(key, opts) {
      const res = await get('https://api.assemblyai.com/v2/transcript?limit=1', { authorization: key }, opts?.fetchImpl ?? fetch)
      if (!res) return { ok: false, reason: 'unavailable' }
      return res.ok ? { ok: true } : classifyStatus(res.status)
    },
  },
  upload_post: {
    label: 'upload-post.com',
    readDefault: () => env.UPLOAD_POST_API_KEY,
    hasDefault: () => !!process.env.UPLOAD_POST_API_KEY,
    async validate(key, opts) {
      const res = await get('https://api.upload-post.com/api/uploadposts/users', { Authorization: `Apikey ${key}` }, opts?.fetchImpl ?? fetch)
      if (!res) return { ok: false, reason: 'unavailable' }
      if (!res.ok) return classifyStatus(res.status)
      if (opts?.profile) {
        const body = (await res.json().catch(() => null)) as { profiles?: Array<{ username?: string }> } | null
        if (!body?.profiles?.some((p) => p.username === opts.profile)) {
          return { ok: false, reason: 'profile_not_found' }
        }
      }
      return { ok: true }
    },
  },
}

export function readDefaultProfile(provider: ProviderId): string | null {
  return provider === 'upload_post' ? env.UPLOAD_POST_PROFILE : null
}
