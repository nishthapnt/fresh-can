import { NextRequest, NextResponse } from 'next/server'

// blog and image_post generation/approval no longer go through n8n at all —
// both run on the worker/pipeline architecture now (src/app/api/jobs/[jobId]/
// blog/, .../image/, worker/). image_questions stays here: it's a quick
// synchronous clarifying-Q&A call with no worker equivalent, unrelated to
// the generation pipeline that was migrated. video/social are unmigrated
// and unchanged.
type WebhookType =
  | 'image_questions'
  | 'video'
  | 'social'
  | 'video_approve'
  | 'video_approve_both'
const WEBHOOK_URLS: Record<WebhookType, string | undefined> = {
  image_questions: process.env.N8N_IMAGE_QUESTIONS_WEBHOOK,
  video:           process.env.N8N_VIDEO_WEBHOOK,
  social:          process.env.N8N_SOCIAL_WEBHOOK,
  video_approve:   process.env.N8N_VIDEO_APPROVE_WEBHOOK,
  video_approve_both: process.env.N8N_VIDEO_APPROVE_BOTH_WEBHOOK,
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

  const GENERATION_TYPES: WebhookType[] = ['video', 'social', 'video_approve', 'video_approve_both']

  try {
    // No timeout for generation types — wait until n8n responds however long it takes.
    // image_questions also gets no artificial timeout override beyond the default,
    // since it's a quick text-only call, but it is NOT in GENERATION_TYPES because
    // (unlike video) the frontend needs to read its response body right away
    // instead of treating it as fire-and-forget.
    const n8nRes = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: bodyStr,
      ...(GENERATION_TYPES.includes(type) ? {} : { signal: AbortSignal.timeout(15000) }),
    })

    // image_questions: unlike the other types, this one is NOT fire-and-forget
    // — n8n responds immediately with the actual question list, which the
    // frontend needs right away to render the Q&A step.
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

    // For other generation webhooks (video), result comes via
    // /api/webhooks/n8n-callback — ignore n8n's HTTP status here.
    if (GENERATION_TYPES.includes(type)) {
      if (!n8nRes.ok) {
        const text = await n8nRes.text().catch(() => '')
        console.log(`[n8n-trigger] ${type} returned ${n8nRes.status} (workflow may still complete): ${text}`)
      }
      return NextResponse.json({ success: true })
    }

    if (!n8nRes.ok) {
      const text = await n8nRes.text().catch(() => '')
      console.error(`[n8n-trigger] ${type} returned ${n8nRes.status}: ${text}`)
      return NextResponse.json({ error: `n8n returned ${n8nRes.status}` }, { status: 502 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[n8n-trigger] ${type}:`, message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
