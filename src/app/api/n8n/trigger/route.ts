import { NextRequest, NextResponse } from 'next/server'

// blog, image_post, AND video generation/approval no longer go through n8n —
// all three run on the worker/pipeline architecture now
// (src/app/api/jobs/[jobId]/{blog,image,video}/, worker/). image_questions
// was the last other n8n consumer of this route; it now runs on
// .../image/questions/route.ts (OpenAI direct). social is the only content
// type still on n8n.
type WebhookType = 'social'
const WEBHOOK_URLS: Record<WebhookType, string | undefined> = {
  social: process.env.N8N_SOCIAL_WEBHOOK,
}

export async function POST(req: NextRequest) {
  let body: { type: WebhookType; payload: Record<string, unknown> }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { type, payload } = body

  if (!type || !payload) {
    return NextResponse.json({ error: 'Missing type or payload' }, { status: 400 })
  }

  const url = WEBHOOK_URLS[type]
  if (!url) {
    return NextResponse.json(
      { error: `No webhook URL configured for type: ${type}` },
      { status: 500 },
    )
  }

  const reqHeaders = {
    'Content-Type': 'application/json',
    'x-n8n-secret': process.env.N8N_WEBHOOK_SECRET ?? '',
  }
  const bodyStr = JSON.stringify(payload)

  try {
    // Fire-and-forget — no timeout, result comes back later via
    // /api/webhooks/n8n-callback, so n8n's immediate HTTP status here is
    // ignored: a non-2xx doesn't mean the workflow itself failed.
    const n8nRes = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: bodyStr,
    })

    if (!n8nRes.ok) {
      const text = await n8nRes.text().catch(() => '')
      console.error(`[n8n-trigger] ${type} returned ${n8nRes.status} (workflow may still complete): ${text}`)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[n8n-trigger] ${type}:`, message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
