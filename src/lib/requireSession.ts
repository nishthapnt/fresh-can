import { NextRequest, NextResponse } from 'next/server'
import { verifySessionToken, SESSION_COOKIE } from '@/lib/auth'

// Defense in depth for routes that handle secrets. src/proxy.ts already gates
// every /api route except auth/webhooks/inngest, but credential routes also
// verify the session themselves so they stay protected even if the proxy
// matcher is ever loosened.
export async function requireSession(req: NextRequest): Promise<NextResponse | null> {
  const secret = process.env.AUTH_SECRET ?? ''
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const ok = secret ? await verifySessionToken(token, secret) : false
  return ok ? null : NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
}
