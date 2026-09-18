import { NextResponse } from 'next/server'

// KIE.ai's own dashboard only reports credits, not a purchased/plan "total" —
// its API mirrors that (a single live balance figure, no total field), so
// this route only ever returns "remaining" (see docs.kie.ai; no total-credits
// endpoint exists). KIE_API_KEY must stay server-side — never exposed to the
// client, hence this proxy route instead of calling api.kie.ai from Sidebar.
export async function GET() {
  const apiKey = process.env.KIE_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 500 })
  }

  let res: Response
  try {
    res = await fetch('https://api.kie.ai/api/v1/chat/credit', {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Failed to reach KIE.ai: ${message}` }, { status: 502 })
  }

  const body = (await res.json()) as { code: number; msg: string; data: number | null }

  if (body.code !== 200 || typeof body.data !== 'number') {
    return NextResponse.json({ error: body.msg || 'KIE.ai returned an unexpected response' }, { status: 502 })
  }

  return NextResponse.json({ remaining: body.data })
}
