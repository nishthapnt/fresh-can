import { NextResponse } from 'next/server'
import { getApiKey, getUploadPostProfile } from '@/server/pipeline/credentials'
import { getConnectionStatus } from '@/server/pipeline/adapters/socialPublisher'

// Surfaces upload-post.com's own per-platform connection/reauth state so a
// stale token is visible in PlatformSelector BEFORE a post is attempted,
// instead of only showing up as a buried provider error string after a
// failed submission. Read-only, account-level — never touches social_posts.
export async function GET() {
  const profile = await getUploadPostProfile()
  if (!profile) {
    // Mirrors src/inngest/functions/social.ts's own guard — social posting
    // is optional infrastructure, so "not configured" is a normal state,
    // not an error. Checked before UPLOAD_POST_API_KEY, which throws if unset.
    return NextResponse.json({ configured: false, platforms: null })
  }

  try {
    const platforms = await getConnectionStatus(await getApiKey('upload_post'), profile)
    return NextResponse.json({ configured: true, platforms })
  } catch (err) {
    // A transient upload-post.com outage shouldn't break the page or claim
    // every platform is disconnected — the UI treats `platforms: null` the
    // same as "no data available" either way.
    console.error('[social] connection-status check failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ configured: true, platforms: null })
  }
}
