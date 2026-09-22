import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { BRAND_PROFILE } from '@/server/pipeline/prompts/index'

// Replaces the old n8n 'image_questions' webhook (src/app/api/n8n/trigger's
// now-removed image_questions branch) — the clarifying-Q&A step shown before
// image_post generation when the user hasn't given enough detail in Topic/
// Scene Idea. Reads job inputs straight from content_jobs (same pattern as
// image/generate's fetchJobInputs-style reads) instead of trusting a
// frontend-built payload, and calls OpenAI directly instead of round-
// tripping through n8n. Same synchronous-response shape the frontend
// already expects: { questions: QuestionItem[] }.
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

interface QuestionItem {
  id: number
  question: string
  options: string[]
  placeholder?: string
}

function buildUserPrompt(job: {
  topic: string
  category: string
  target_audience: string
  scene_notes: string | null
}): string {
  const lines = [
    `Topic: ${job.topic}`,
    `Category: ${job.category}`,
    `Target audience: ${job.target_audience}`,
  ]
  if (job.scene_notes) lines.push(`User's own scene idea: ${job.scene_notes}`)
  return lines.join('\n')
}

const SYSTEM_PROMPT =
  `${BRAND_PROFILE.missionStatement}\n\n` +
  'You are helping fill in a few gaps before generating a single social-media image post for Fresh-CAN. ' +
  'Given the job details below, write 2-3 short clarifying questions that would make the resulting image ' +
  'more specific and vivid (e.g. what the scene shows, who is in it, the setting, the mood/time of day) — ' +
  'skip any question the details already answer. Each question needs 3-5 short answer options (a few words ' +
  'each, no full sentences) the user can tap instead of typing.\n\n' +
  'Respond with strictly valid JSON, no markdown fence, in exactly this shape:\n' +
  '{"questions":[{"id":1,"question":"...","options":["...","..."],"placeholder":"Or describe your own..."}]}'

function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return match ? match[1] : text
}

function parseQuestions(raw: string): QuestionItem[] | null {
  let data: unknown
  try {
    data = JSON.parse(stripCodeFence(raw))
  } catch {
    return null
  }
  const questions = (data as { questions?: unknown })?.questions
  if (!Array.isArray(questions)) return null

  const valid: QuestionItem[] = []
  for (const q of questions) {
    if (
      typeof q !== 'object' || q === null ||
      typeof (q as Record<string, unknown>).question !== 'string' ||
      !Array.isArray((q as Record<string, unknown>).options) ||
      !(q as { options: unknown[] }).options.every((o) => typeof o === 'string')
    ) continue
    valid.push({
      id: valid.length + 1,
      question: (q as { question: string }).question,
      options: (q as { options: string[] }).options,
      placeholder: typeof (q as Record<string, unknown>).placeholder === 'string'
        ? (q as { placeholder: string }).placeholder
        : undefined,
    })
  }
  return valid.length > 0 ? valid : null
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const supabase = getSupabase()

  const { data: job, error: jobErr } = await supabase
    .from('content_jobs')
    .select('topic, category, target_audience, scene_notes')
    .eq('id', jobId)
    .single()

  if (jobErr || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY is not configured' }, { status: 500 })
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(job) },
        ],
        response_format: { type: 'json_object' },
      }),
      // Same 15s ceiling the old n8n call used — the frontend blocks on this
      // response to render the Q&A step, so it needs a real timeout rather
      // than waiting indefinitely.
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ error: `OpenAI returned ${res.status}: ${text}` }, { status: 502 })
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    const questions = typeof content === 'string' ? parseQuestions(content) : null

    if (!questions) {
      return NextResponse.json({ error: 'Could not parse clarifying questions from OpenAI' }, { status: 502 })
    }

    return NextResponse.json({ questions })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
