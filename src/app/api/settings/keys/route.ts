import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/requireSession'
import { listCredentialStatuses, purgeRetiredCredentials } from '@/server/pipeline/credentials'

// Safe metadata only: provider / source / last4 / updatedAt (+ label, the
// non-secret upload-post profile, and whether an env default exists). Neither
// custom nor default key values are ever returned.
export async function GET(req: NextRequest) {
  const denied = await requireSession(req)
  if (denied) return denied

  try {
    const keys = await listCredentialStatuses()
    // Opportunistic cleanup of retired versions no unfinished job pins anymore.
    // Best-effort: a purge failure must not fail an otherwise good read.
    try {
      await purgeRetiredCredentials()
    } catch (err) {
      console.error('[settings] retired credential purge failed:', err instanceof Error ? err.message : 'unknown error')
    }
    return NextResponse.json({ success: true, keys })
  } catch (err) {
    console.error('[settings] list keys failed:', err instanceof Error ? err.message : 'unknown error')
    return NextResponse.json({ success: false, error: 'Could not load API key settings' }, { status: 500 })
  }
}
