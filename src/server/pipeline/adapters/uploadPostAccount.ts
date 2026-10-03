import { ProviderCallError } from './types'

// Read-only account summary for the Settings page, from upload-post.com's
// GET /api/uploadposts/users (the same call getConnectionStatus makes). Only
// non-secret fields are returned — never the key, email or other profiles'
// names.

export interface UploadPostAccountInfo {
  plan: string | null
  /** Max profiles the plan allows (null if the API didn't say). */
  profileLimit: number | null
  profileCount: number
  /** Platforms connected on the ACTIVE profile (null = no profile configured / not found). */
  connectedPlatforms: string[] | null
}

export async function getUploadPostAccountInfo(
  apiKey: string,
  profile: string | null,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = 'https://api.upload-post.com',
): Promise<UploadPostAccountInfo> {
  const res = await fetchImpl(`${baseUrl}/api/uploadposts/users`, {
    headers: { Authorization: `Apikey ${apiKey}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new ProviderCallError('upload-post', res.status, '')

  const data = (await res.json()) as {
    plan?: unknown
    limit?: unknown
    profiles?: Array<{ username?: string; social_accounts?: Record<string, unknown> }>
  }
  const profiles = Array.isArray(data.profiles) ? data.profiles : []
  const active = profile ? profiles.find((p) => p.username === profile) : undefined

  return {
    plan: typeof data.plan === 'string' && data.plan ? data.plan : null,
    profileLimit: typeof data.limit === 'number' ? data.limit : null,
    profileCount: profiles.length,
    connectedPlatforms: active
      ? Object.entries(active.social_accounts ?? {})
          .filter(([, v]) => typeof v === 'object' && v !== null)
          .map(([k]) => k)
      : null,
  }
}
