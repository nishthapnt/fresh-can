import { NextRequest, NextResponse } from 'next/server'

// blog, image_post, AND video generation/approval no longer go through n8n —
// all three run on the worker/pipeline architecture now
// (src/app/api/jobs/[jobId]/{blog,image,video}/, worker/). image_questions
// stays here: it's a quick synchronous clarifying-Q&A call with no worker
// equivalent, unrelated to the generation pipeline that was migrated.
// social is the only content type still unmigrated.
type WebhookType =
  | 'image_questions'
  | 'social'
const WEBHOOK_URLS: Record<WebhookType, string | undefined> = {
  image_questions: process.env.N8N_IMAGE_QUESTIONS_WEBHOOK,
  social:          process.env.N8N_SOCIAL_WEBHOOK,
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
    // 'social' is fire-and-forget — no timeout, result comes back later via
    // /api/webhooks/n8n-callback. 'image_questions' is NOT fire-and-forget —
    // n8n responds immediately with the actual question list, which the
    // frontend needs right away to render the Q&A step, so it gets a real
    // timeout instead of waiting indefinitely.
    const n8nRes = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: bodyStr,
      ...(type === 'image_questions' ? { signal: AbortSignal.timeout(15000) } : {}),
    })

    if (type === 'image_questions') {
      if (!n8nRes.ok) {
        const text = await n8nRes.text().catch(() => '')
        return NextResponse.json({ error: `n8n returned ${n8nRes.status}: ${text}` }, { status: 502 })
      }
      const data = await n8nRes.json().catch(() => null)
      if (!data) {
        return NextResponse.json({ error: 'Invalid response from n8n' }, { status: 502 })
      }
      return NextResponse.json(data)
    }

    // 'social' — ignore n8n's HTTP status here; the real result comes via callback.
    if (!n8nRes.ok) {
      const text = await n8nRes.text().catch(() => '')
      console.log(`[n8n-trigger] ${type} returned ${n8nRes.status} (workflow may still complete): ${text}`)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[n8n-trigger] ${type}:`, message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
