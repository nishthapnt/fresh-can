import { NextRequest, NextResponse } from 'next/server'
import { verifySessionToken, SESSION_COOKIE } from '@/lib/auth'

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const secret = process.env.AUTH_SECRET ?? ''
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const authenticated = secret ? await verifySessionToken(token, secret) : false

  if (pathname === '/login') {
    if (authenticated) {
      return NextResponse.redirect(new URL('/dashboard', req.url))
    }
    return NextResponse.next()
  }

  if (!authenticated) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!api/auth|api/webhooks|api/inngest|_next/static|_next/image|favicon.ico).*)',
  ],
}
