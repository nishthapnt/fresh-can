// Pure validation behind POST /api/jobs/[jobId]/blog/draft — same reasoning
// as video/updateScript.ts's own header: kept here, not inline in the route,
// so it can be unit-tested without a real Supabase round trip. The
// is_approved lock itself can't live here (it needs the real fetched row),
// so it stays in the route.

export type BlogLanguage = 'EN' | 'FR'

export function isBlogLanguage(v: unknown): v is BlogLanguage {
  return v === 'EN' || v === 'FR'
}

export interface BlogDraftSaveRequest {
  language: BlogLanguage
  draftData: Record<string, unknown>
}

export function validateBlogDraftSaveRequest(body: unknown): { request: BlogDraftSaveRequest } | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Invalid request body' }
  }
  const b = body as Record<string, unknown>
  if (!isBlogLanguage(b.language)) {
    return { error: 'language must be EN or FR' }
  }
  if (!b.draft_data || typeof b.draft_data !== 'object' || Array.isArray(b.draft_data)) {
    return { error: 'Missing draft_data' }
  }
  return { request: { language: b.language, draftData: b.draft_data as Record<string, unknown> } }
}
