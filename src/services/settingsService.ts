// Client-side wrappers for /api/settings/keys. The server only ever returns
// safe metadata (last4, source, …) — a full key is never sent to the browser.

export type ApiKeyProvider = 'openai' | 'kie' | 'elevenlabs' | 'assemblyai' | 'upload_post'

export interface ApiKeyStatus {
  provider: ApiKeyProvider
  label: string
  source: 'custom' | 'default'
  last4: string | null
  updatedAt: string | null
  profile: string | null
  defaultConfigured: boolean
}

async function parse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as ({ success?: boolean; error?: string } & T) | null
  if (!res.ok || !body || body.success === false) {
    throw new Error(body?.error ?? 'Something went wrong. Try again.')
  }
  return body
}

export async function fetchApiKeys(): Promise<ApiKeyStatus[]> {
  const res = await fetch('/api/settings/keys', { cache: 'no-store' })
  return (await parse<{ keys: ApiKeyStatus[] }>(res)).keys
}

export async function saveApiKey(
  provider: ApiKeyProvider,
  value: string,
  profile?: string,
): Promise<ApiKeyStatus> {
  const res = await fetch(`/api/settings/keys/${provider}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, profile }),
  })
  return (await parse<{ key: ApiKeyStatus }>(res)).key
}

export async function resetApiKey(provider: ApiKeyProvider): Promise<ApiKeyStatus> {
  const res = await fetch(`/api/settings/keys/${provider}`, { method: 'DELETE' })
  return (await parse<{ key: ApiKeyStatus }>(res)).key
}

export async function fetchKieCredits(): Promise<number | null> {
  try {
    const res = await fetch('/api/kie/credits', { cache: 'no-store' })
    const body = await res.json()
    return res.ok && typeof body.remaining === 'number' ? body.remaining : null
  } catch {
    return null
  }
}

export interface UploadPostInfo {
  plan: string | null
  profileLimit: number | null
  profileCount: number
  connectedPlatforms: string[] | null
}

/** null = unavailable (provider outage or no key); the card just hides the line. */
export async function fetchUploadPostInfo(): Promise<UploadPostInfo | null> {
  try {
    const res = await fetch('/api/settings/upload-post', { cache: 'no-store' })
    const body = await res.json()
    return res.ok && body.info ? (body.info as UploadPostInfo) : null
  } catch {
    return null
  }
}
