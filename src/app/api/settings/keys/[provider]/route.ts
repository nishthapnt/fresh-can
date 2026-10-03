import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/requireSession'
import { isEncryptionConfigured } from '@/server/pipeline/credentialCrypto'
import { isProviderId, PROVIDERS, type ProviderId } from '@/server/pipeline/credentialProviders'
import { listCredentialStatuses, resetCredential, saveCredential } from '@/server/pipeline/credentials'
import { createServiceClient, getPostingSocialPlatformLogGroups } from '@/server/pipeline/db'
import { createAttemptThrottle } from '@/server/pipeline/lib/attemptThrottle'

const writeThrottle = createAttemptThrottle(10, 60_000)

const KEY_PATTERN = /^[\x21-\x7E]{8,512}$/ // printable ASCII, no whitespace
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

function fail(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status })
}

// upload-post polling is tied to the account a post was submitted under, so
// don't swap that account while posts are mid-publish.
async function socialPostsInFlight(): Promise<boolean> {
  const groups = await getPostingSocialPlatformLogGroups(createServiceClient())
  return groups.size > 0
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const denied = await requireSession(req)
  if (denied) return denied

  const { provider } = await params
  if (!isProviderId(provider)) return fail(404, 'Unknown provider')
  const id: ProviderId = provider

  let body: { value?: unknown; profile?: unknown }
  try {
    body = await req.json()
  } catch {
    return fail(400, 'Invalid request body')
  }
  const value = typeof body.value === 'string' ? body.value.trim() : ''
  if (!KEY_PATTERN.test(value)) return fail(400, 'Enter a valid API key')

  let profile: string | null = null
  if (id === 'upload_post') {
    profile = typeof body.profile === 'string' ? body.profile.trim() : ''
    if (!PROFILE_PATTERN.test(profile)) return fail(400, 'Enter the upload-post.com profile name for this key')
  }

  if (!isEncryptionConfigured()) return fail(503, 'Custom API keys are not enabled on this server')
  if (!writeThrottle.tryAcquire()) return fail(429, 'Too many attempts. Wait a minute and try again.')

  try {
    if (id === 'upload_post' && (await socialPostsInFlight())) {
      return fail(409, 'Social posts are being published right now. Try again once they finish.')
    }

    // Validate BEFORE touching storage: a failed check leaves the current
    // credential (custom or default) exactly as it was.
    const result = await PROVIDERS[id].validate(value, { profile })
    if (!result.ok) {
      const label = PROVIDERS[id].label
      switch (result.reason) {
        case 'invalid':
          return fail(422, `${label} rejected this key. Check it and try again.`)
        case 'profile_not_found':
          return fail(422, `That profile was not found under this ${label} key.`)
        case 'rate_limited':
          return fail(429, `${label} is rate limiting requests. Try again shortly.`)
        default:
          return fail(502, `Could not reach ${label} to check the key. Try again.`)
      }
    }

    const key = await saveCredential(id, { value, profile, updatedBy: 'session' })
    return NextResponse.json({ success: true, key })
  } catch (err) {
    console.error(`[settings] save ${id} key failed:`, err instanceof Error ? err.message : 'unknown error')
    return fail(500, 'Could not save the key')
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const denied = await requireSession(req)
  if (denied) return denied

  const { provider } = await params
  if (!isProviderId(provider)) return fail(404, 'Unknown provider')
  const id: ProviderId = provider

  try {
    if (id === 'upload_post' && (await socialPostsInFlight())) {
      return fail(409, 'Social posts are being published right now. Try again once they finish.')
    }
    const removed = await resetCredential(id)
    const key = (await listCredentialStatuses()).find((k) => k.provider === id)
    // Idempotent: resetting when no custom key exists is a no-op (removed:false).
    return NextResponse.json({ success: true, removed, key })
  } catch (err) {
    console.error(`[settings] reset ${id} key failed:`, err instanceof Error ? err.message : 'unknown error')
    return fail(500, 'Could not reset the key')
  }
}
