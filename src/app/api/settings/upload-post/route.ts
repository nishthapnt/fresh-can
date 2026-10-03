import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/requireSession'
import { getApiKey, getUploadPostProfile } from '@/server/pipeline/credentials'
import { getUploadPostAccountInfo } from '@/server/pipeline/adapters/uploadPostAccount'

// Plan / profile-limit / connected-platform summary for the ACTIVE upload-post
// account (custom key if set in Settings, else the env key). Non-secret fields
// only. A provider outage returns info:null rather than an error so the
// Settings page still renders.
export async function GET(req: NextRequest) {
  const denied = await requireSession(req)
  if (denied) return denied

  try {
    const info = await getUploadPostAccountInfo(await getApiKey('upload_post'), await getUploadPostProfile())
    return NextResponse.json({ success: true, info })
  } catch (err) {
    console.error('[settings] upload-post account info failed:', err instanceof Error ? err.message : 'unknown error')
    return NextResponse.json({ success: true, info: null })
  }
}
