// Explicit load only matters for worker/src/index.ts's standalone tsx
// process (launched with cwd=worker/, and isn't a Next.js process, so
// nothing auto-loads .env.local for it). When this module is imported from
// the Next.js app itself (Inngest functions, API routes; cwd is the repo
// root), Next has already populated process.env and these calls are
// harmless no-ops — dotenv never overwrites an already-set var, and a
// missing path is silently ignored. Using process.cwd() rather than
// import.meta.url/new URL because Turbopack can't statically resolve the
// latter; trying both candidate cwds covers "run from repo root" and "run
// from worker/" without needing to know which one it is.
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '..', '.env.local') })

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export const env = {
  get SUPABASE_URL() {
    return required('NEXT_PUBLIC_SUPABASE_URL')
  },
  get SUPABASE_SERVICE_ROLE_KEY() {
    return required('SUPABASE_SERVICE_ROLE_KEY')
  },
  get OPENAI_API_KEY() {
    return required('OPENAI_API_KEY')
  },
  get KIE_API_KEY() {
    return required('KIE_API_KEY')
  },
  // Video-only providers (M0 of the video migration)
  get ELEVENLABS_API_KEY() {
    return required('ELEVENLABS_API_KEY')
  },
  get ASSEMBLYAI_API_KEY() {
    return required('ASSEMBLYAI_API_KEY')
  },
  get UPLOAD_POST_API_KEY() {
    return required('UPLOAD_POST_API_KEY')
  },
  // The upload-post.com profile (their term: "user") that owns the
  // connected Instagram/Facebook/X accounts jobs post to — not an
  // end-user of this dashboard. See worker/src/adapters/socialPublisher.ts.
  //
  // Deliberately OPTIONAL, unlike every other credential above — social
  // posting is one feature among three (blog/image_post/video are the
  // real point of this worker), not infrastructure the whole process
  // should refuse to start without. Confirmed live (2026-09-17): making
  // this `required()` meant ANY missing/placeholder value crashed main()
  // before it could do anything at all, including generate a single
  // video/blog/image — unrelated content types were blocked by a
  // social-only credential. main()'s wiring (index.ts) checks for null
  // here and skips social posting entirely (not a crash, not a failed
  // submission attempt) when it's absent.
  get UPLOAD_POST_PROFILE(): string | null {
    return process.env.UPLOAD_POST_PROFILE || null
  },
  // TEST-ONLY (default off, never required) — routes video's character_ref/
  // scene_image/scene_video_clip generation, and blog/image_post's
  // hero/inline/photo generation, through the zero-cost stand-ins in
  // adapters/kieFake.ts instead of real KIE.ai calls. See that file's header
  // for exactly what is and isn't faked. Never set this in production.
  get KIE_FAKE_MODE() {
    return process.env.KIE_FAKE_MODE === 'true'
  },
}
