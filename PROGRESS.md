# PROGRESS.md — Session Log

---

## 📊 CURRENT STATUS

| Field | Value |
|-------|-------|
| **Project** | Fresh-CAN Content Automation Dashboard |
| **Last Updated** | 2026-09-14 |
| **Phase** | ✅ Blog + Image + Video Pipeline Migration Complete — only social posting (+ image clarifying questions) remain on n8n |
| **Progress** | ██████████ 95% |
| **Blockers** | None. Note: `worker/` must be started manually (`npm run dev` inside `worker/`) — nothing runs it automatically. |

---

## 🏁 MILESTONES

- [x] Phase 1 — Project Setup (Next.js, Supabase, ShadCN, Tailwind)
- [x] Phase 2 — Core pages built (dashboard, new, jobs, social, library)
- [x] Phase 3 — n8n webhook integration wired (social + image_questions only as of Phase 9 — see below)
- [x] Phase 4 — UI upgrade (skeletons, KPI trends, TopBar, empty/error states)
- [ ] Phase 5 — Supabase tables confirmed + anon key connected
- [ ] Phase 6 — End-to-end test with real n8n flows
- [ ] Phase 7 — Deploy to production
- [x] Phase 8 — Blog + image_post migrated off n8n onto `worker/` pipeline architecture (Session 5, 2026-09-09) — see `docs/IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.MD`
- [x] Phase 9 — Video migration off n8n onto `worker/` pipeline architecture (Session 6, 2026-09-14) — script + character-ref + per-scene visuals (shared once per job) plus per-language narration/captions/render, live-verified end-to-end (real EN+FR run, both languages rendered successfully)

---

## 📅 SESSION LOG

---

### Session 1 — 2026-06-15
**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**
- Scaffolded Next.js 16 App Router project
- Installed Supabase JS, ShadCN UI, Tailwind v4, Lucide icons
- Created TypeScript types: `content.ts`, `database.ts`
- Created Supabase client: `src/lib/supabase.ts`
- Created all service functions: `src/services/contentService.ts`
- Built n8n callback API route: `POST /api/webhooks/n8n-callback`
- Built Sidebar + DashboardLayout
- Built reusable components: StatusBadge, KPICard, ContentCard, DraftEditor, SocialApprovalCard, PlatformSelector
- Built all 5 pages: /dashboard, /dashboard/new, /dashboard/jobs/[job_id], /dashboard/jobs/[job_id]/social, /dashboard/library
- Clean production build: `npm run build` passes with 0 errors

**🔄 In Progress**
- Connecting real Supabase project (jbrktjnscnzmhwupojiu) — waiting for anon key

**🐛 Bugs Found**
- None

**💡 Decisions Made**
- Used `createClient<any>` instead of full Database generic — supabase-js v2 generic format incompatible; service layer handles types explicitly
- Supabase project switched from vufyllorsfmqocmdyeax → jbrktjnscnzmhwupojiu

**📁 Files Changed**
- All files created fresh (new project)

**⭐ Pick Up Next Session**
- Add Supabase anon key to .env.local
- Verify Supabase tables exist (run SQL if needed)
- Test form submission → n8n → callback flow end-to-end

---

### Session 2 — 2026-06-15
**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**
- Filled in all project docs (CLAUDE.md, PROGRESS.md, TASKS.md, API_DOCS.md, DECISIONS.md)
- UI upgrade: replaced all spinners with loading skeletons
- UI upgrade: KPICard now shows trend % with green/red/gray indicators
- UI upgrade: Added TopBar component with breadcrumbs, page title, and action slot
- UI upgrade: Improved empty states with illustrations and CTAs
- UI upgrade: Improved error states with retry buttons
- UI upgrade: Sidebar polish — active state, hover effects
- Applied dashboard-ui skill checklist across all pages

**⭐ Pick Up Next Session**
- Add Supabase anon key → test live DB connection
- Verify/create Supabase tables with correct schema

---

### Session 3 — 2026-06-18/19
**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**
- **Library page** — 3 tabbed sections (Videos, Images, Blog Posts) with full filtering, realtime, Post modal
- **Library Post modal** — platform toggles (Instagram/Facebook/X), caption + hashtags pre-fill, fires `/api/social/post`
- **Video card** — thumbnail click opens full-screen Dialog player (sm:max-w-4xl) instead of inline play
- **Dashboard** — replaced "Recent Content Jobs" grid with 3 mini sections (Videos, Images, Blog Posts) each with quick-view modals
- **Image/Blog types** — added `ImageLibraryItem` and `BlogLibraryItem` types, `getImageLibrary()` / `getBlogLibrary()` service functions
- **`POST /api/social/post`** — saves to `social_posts` + fires `N8N_SOCIAL_WEBHOOK` fire-and-forget
- **Job detail page — full redesign** (`/dashboard/jobs/[job_id]/page.tsx`):
  - Loads ALL drafts (video, image_post, blog) from `content_drafts` at once
  - Tabs for each selected content type with live status indicators (spinner / amber dot / green check)
  - **VideoTabContent** — editable script parts (unchanged)
  - **ImageTabContent** — shows caption, image_prompt, hashtags from draft_data (flexible rendering)
  - **BlogTabContent** — shows title, sections, intro, conclusion, tags from draft_data (flexible rendering)
  - **RegenerateDialog** — extra instructions textarea → calls `POST /api/jobs/[jobId]/regenerate` → retriggers n8n with extra_instructions
  - **Sticky action bar** — per active tab: [Regenerate] + [Approve & Generate Video / Approve Image / Approve Blog Post]
  - Realtime watches both INSERT and UPDATE on content_drafts (not just video)
  - Per-type approval state tracked in `approvedTypes: Set<ContentType>`
  - Approved bar shown after approval (green banner) for image/blog
  - Video approve → existing flow (save script + fire video_approve webhook + job → generating)
  - Image/Blog approve → fire image_approve/blog_approve webhook + mark draft is_approved=true in DB
- **`POST /api/jobs/[jobId]/regenerate`** — new route: resets draft status to pending + retriggers n8n with extra_instructions
- **`POST /api/n8n/trigger`** — extended with `image_approve` and `blog_approve` types (env: `N8N_IMAGE_APPROVE_WEBHOOK`, `N8N_BLOG_APPROVE_WEBHOOK`)

**📁 Files Changed**
- `src/app/dashboard/jobs/[job_id]/page.tsx` (full rewrite)
- `src/app/api/jobs/[jobId]/regenerate/route.ts` (new)
- `src/app/api/n8n/trigger/route.ts` (extended)
- `src/app/api/social/post/route.ts` (new)
- `src/app/dashboard/library/page.tsx` (full rewrite — 3 sections)
- `src/app/dashboard/page.tsx` (rewrite — 3 mini content sections)
- `src/services/contentService.ts` (added getImageLibrary, getBlogLibrary)
- `src/types/content.ts` (added ImageLibraryItem, BlogLibraryItem)

**⭐ Pick Up Next Session**
- Add `N8N_IMAGE_APPROVE_WEBHOOK` and `N8N_BLOG_APPROVE_WEBHOOK` to `.env.local`
- Configure n8n webhooks for image_approve and blog_approve flows
- End-to-end test: create job → wait for drafts → regenerate with instructions → approve each type

---

### Session 4 — 2026-07-17
**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**
- **Dashboard login** — fixed ID/password gate for the whole app (was previously "no auth, internal tool")
- `src/lib/auth.ts` — HMAC-SHA256 signed session tokens (Web Crypto, edge/node compatible), no external deps
- `POST /api/auth/login` — checks `DASHBOARD_LOGIN_ID` / `DASHBOARD_LOGIN_PASSWORD`, sets httpOnly `fc_session` cookie (7-day expiry)
- `POST /api/auth/logout` — clears the session cookie
- `src/proxy.ts` (Next.js 16's replacement for `middleware.ts`) — gates every route except `/api/auth/*` and the inbound `/api/webhooks/*` (n8n needs unauthenticated access), redirects unauthenticated visitors to `/login?next=...`, redirects already-authenticated visitors away from `/login`
- `/login` page — simple ID/password form using existing ShadCN Button/Input
- Logout button added to `Sidebar` footer
- Added env vars: `DASHBOARD_LOGIN_ID`, `DASHBOARD_LOGIN_PASSWORD`, `AUTH_SECRET` (to `.env.local` + `.env.example`)
- Verified end-to-end with curl: unauth redirect, wrong creds → 401, correct creds → cookie set, cookie grants dashboard access, authenticated visit to `/login` bounces to `/dashboard`, logout clears session, n8n callback route still reachable without auth
- `npm run build` passes clean (no middleware deprecation warning after switching to `proxy.ts`)

**📁 Files Changed**
- `src/lib/auth.ts` (new)
- `src/app/api/auth/login/route.ts` (new)
- `src/app/api/auth/logout/route.ts` (new)
- `src/proxy.ts` (new)
- `src/app/login/page.tsx` (new)
- `src/components/layout/Sidebar.tsx` (added logout button)
- `.env.local`, `.env.example` (added auth env vars)

**💡 Decisions Made**
- Fixed credentials come from env vars, not a database table — matches "internal tool, single fixed ID/password" ask rather than building out a users table
- Session cookie is a self-signed HMAC token (expiry + signature), not a random opaque ID — no session store needed, verification works in both Edge and Node runtimes

**⭐ Pick Up Next Session**
- Update `CLAUDE.md` / `API_DOCS.md` "Auth Method" if a real user-based auth system replaces this later
- Consider rate-limiting `/api/auth/login` if this is ever exposed beyond trusted internal users

---

### Session 5 — 2026-09-09
**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Blog pipeline (off n8n, onto `worker/`)*
- Verified/fixed the KIE.ai adapter (`worker/src/adapters/kie.ts`) against the real Flux Kontext API — the prior implementation guessed at endpoints and 404'd
- Built the 4 previously-missing routes: `blog/tracks/[lang]/{draft,approve,retry}`, `blog/regenerate`
- Wired `new/page.tsx` (trigger) and job detail page (approve) to the new backend
- Found + fixed 2 real bugs live: Markdown-fenced JSON silently breaking draft parsing (`generateCopy` output), and the model writing section body text under `summary` instead of the `paragraphs` field the editor expects
- Added real **copy-only regeneration** (`scope: 'copy'`) — redoes one language track's text independent of the shared images, with user instructions actually reaching the rewrite prompt. Required bumping `content_language_tracks.master_generation_used` as a second, independent generation counter from the pipeline's

*Image_post pipeline (built from scratch on the same architecture)*
- New worker steps: `generatePhoto`, `generateCaption`, `finalizeImageContent`
- New `adapters/storage.ts` — downloads KIE.ai's ephemeral photo and re-uploads to permanent Supabase Storage (`fc-image-posts` bucket, `{job_id}-final.jpg`, matching n8n's existing convention) — blog's hero/inline images still don't do this (follow-up)
- Same 5 routes as blog: `image/generate`, `image/status`, `image/tracks/[lang]/{approve,retry}`, `image/regenerate`
- Persisted previously-ephemeral image context (`content_jobs.scene_notes/image_answers`) that the old n8n payload carried but never stored — worker uses it in photo prompts. Province/city targeting was later removed; scene notes and clarifying answers remain supported.
- Regenerate instructions verified live (requested film-noir black & white — got it)

*Shared fixes*
- Race condition: a stray late retry could downgrade an already-`ready` visual asset back to `failed`, wiping its URL — fixed in both `generatePhoto.ts` and (backported) `generateVisualImage.ts`
- Garbled text baked into generated photos (colon-labeled prompt phrasing read as a caption to render) — rewrote all 3 photo prompts as plain descriptive prose + explicit no-text instruction. Improves it substantially but is **not fully deterministic** — recurred once in later testing, correlated with a headline-like job topic

*Full n8n cutover*
- Removed `blog`/`image_post`/`blog_approve`/`image_approve` entirely from `/api/n8n/trigger` (the latter two were already dead code) — confirmed live that calling either type now fails outright
- Pruned `/api/jobs/[jobId]/regenerate` to video-only
- Rewrote stale UI copy still referencing n8n for blog/image (waiting cards, debug panel labels, button text)
- video/social/`image_questions` untouched — not migrated, not planned to be as part of this pass

**📁 Files Changed** (non-exhaustive — this was a large, multi-day session)
- `worker/src/steps/{generatePhoto,generateCaption,finalizeImageContent}.ts` (new)
- `worker/src/adapters/{kie,storage}.ts` (kie.ts fixed, storage.ts new)
- `worker/src/{index,db}.ts` (generalized beyond blog-only; added `regen_instructions` fields)
- `src/app/api/jobs/[jobId]/blog/**`, `.../image/**` (new routes)
- `src/app/api/n8n/trigger/route.ts`, `.../regenerate/route.ts` (pruned)
- `src/app/dashboard/new/page.tsx`, `.../jobs/[job_id]/page.tsx` (trigger/approve/regenerate wiring, RegenerateDialog scope selector)
- `supabase/migrations/20260909120000_image_post_context_fields.sql`, `20260909130000_regen_instructions.sql` (new — applied manually via Supabase SQL editor, no CLI/DB connection available to this session)
- `CLAUDE.md`, `.env.example` (updated to match)

**💡 Decisions Made**
- Blog and image copy/caption generation are deliberately independent of the shared visual asset (gated on nothing but the job's basic fields) — mirrors the "words vs. picture never conflated" principle in `ARCHITECTURE.MD`, confirmed working via the copy-only regen test
- Regenerate dialog gets a scope selector ("Text" / "Images") for blog only — image_post has just one shared layer, no ambiguity to resolve
- Left the text-in-image imperfection and worker e2e test flakiness as known, non-blocking issues rather than chasing them to 100% in this session

**⭐ Pick Up Next Session**
- Investigate whether KIE.ai's API has a dedicated negative-prompt parameter to more reliably eliminate baked-in text
- Stabilize `worker/src/steps/blogPipeline.e2e.test.ts` (real-DB timing flakiness, pre-existing, unrelated to this session's changes)
- Backport permanent Supabase Storage upload to blog's hero/inline images (currently on KIE.ai's ~14-day ephemeral host)
- Surface "stale" track state in the editor UI — after a visual regenerate, nothing currently tells the user a new image is waiting on re-approval
- Video migration (Phase 9) — largest remaining piece, not started

---

### Session 6 — 2026-09-14
**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Video pipeline — end-to-end live test, 2 real bugs found and fixed*
- Ran a real, full end-to-end video generation (both EN and FR) against live provider APIs (OpenAI, KIE.ai, ElevenLabs, AssemblyAI, upload-post.com) — this is the first time video's worker pipeline (already built pre-session) was actually exercised start to finish.
- **Bug 1 — scene clips exceeded Supabase Storage's upload size limit.** Root cause was two-fold: (a) a per-scene downscale pass had existed once, been removed on a wrong diagnosis (looked like a slow provider timeout; was actually an instant crash from submitting `{input0}` where the single-file API needs the bare `{input}`, masked by a separate case-sensitive status-matching bug in the poll code) — re-added with both underlying bugs fixed; (b) even after downscaling individual clips, the final concatenated render still used uncapped `-crf 23` (a quality target, not a size ceiling) and a real full-length script still exceeded the limit — replaced with an explicit bitrate cap (`-b:v/-maxrate/-bufsize 3500k`) on both re-encoding passes, sized against the empirically-confirmed real limit (~50-52MB, found by binary-searching real uploads).
- **Bug 2 — the dashboard's video-duration selection never reached the script prompt.** `content_jobs` had no column for it, the job-creation insert never persisted it, and the script-generation prompt had no real target at all — the model was free to invent any runtime (a real run picked 90s against a 24-52s UI). Fixed end-to-end: new `video_duration_seconds` column (migration `20260914000000_video_duration_field.sql`), persisted on job creation, read by the worker, passed into the script prompt as an explicit target — worded so the model can run slightly short/long rather than truncate a scene's narration to force an exact match.
- Also raised `VIDEO_POLL_TIMEOUT_MS` 180s→360s after live scene generations routinely exceeded the old window and burned through retry attempts (one scene exhausted all 5 retries and hard-failed the pipeline before this fix).
- Re-ran the full EN+FR test after all four fixes — completed cleanly, both languages rendered successfully, well under the storage size limit.

*Dashboard UI*
- Grouped EN/FR video library items by `job_id` on both the dashboard home page and the library grid, so a BOTH-language job shows one card with an English/Français toggle (placed below the title, inside the card/modal) instead of two duplicate cards taking twice the grid space.
- Found + fixed a real bug this depended on: `getVideoLibrary()` read `content_jobs.language` (the job's requested intent — literally `'BOTH'` on every row) instead of `generated_content.language` (each row's own real EN/FR value), which silently collapsed both languages into one bucket during grouping and would have dropped the FR video entirely.
- Made video preview thumbnails a fixed square crop instead of following the clip's stored aspect ratio (a 9:16 video previously rendered as a tall, elongated card next to square image cards). Removed the now-unused `src/lib/aspectRatioClass.ts`.
- Removed a duplicate Twitter/X platform checkbox in Social Approval (`PlatformSelector.tsx` listed them as two independently-selectable platforms since the rebrand) — collapsed to one option, matching the library page's own picker, which already had this right.

*Audit — confirmed several real, live issues not yet fixed*
- Social posting can get permanently stuck at `status='posting'` with no error, timeout, or retry surfaced anywhere in the UI — confirmed via 2 real rows stuck since 2026-07-01 with zero matching `social_platform_logs` rows. Only 1 post total has ever reached `'posted'` out of 558 jobs.
- `WaitingCard`'s progress bar (shown before a video pipeline row exists) is a fake wall-clock timer (`elapsed/90*85`, capped at 85%) that never checks real backend status — unlike `GlobalProgressBar` (fixed in an earlier session), which genuinely polls `content_pipelines`/`content_language_tracks`.
- RLS is defined but not actually enabled on `content_jobs`/`generated_content` — the anon key shipped to every browser has effectively unrestricted read/write on both tables today (previously noted in `docs/IMPLEMENTATION_PLAN.md` Phase 1, confirmed still true).
- Corrected stale comments/docs that had drifted out of sync with reality: a "M1 scope, character_ref not enqueued yet" comment in `video/approve/route.ts` (character-ref has been wired up and live since M2), a dangling reference to the now-deleted `aspectRatioClass.ts`, and this file's/`TASKS.md`'s/`docs/IMPLEMENTATION_PLAN.md`'s Phase 9 video-migration status (all said "not started"/"Deferred").

**📁 Files Changed**
- `worker/src/adapters/{avMerger,types}.ts` (+`.test.ts`) — `SceneClipScaler`/`buildScaleCommand`, bitrate cap on concat/caption passes
- `worker/src/steps/video/generateSceneVisual.ts` — scaler wiring, raised poll timeout
- `worker/src/steps/video/generateScript.ts`, `worker/src/prompts/core/composeText.ts` — duration propagation into the script prompt
- `worker/src/index.ts` — `fetchJobInputs` reads `video_duration_seconds`
- `worker/src/steps/video/videoPipeline.e2e.test.ts` — updated call sites for new params
- `supabase/migrations/20260914000000_video_duration_field.sql` (new)
- `src/app/dashboard/new/page.tsx` — persists `video_duration_seconds` on job creation
- `src/app/dashboard/page.tsx`, `src/app/dashboard/library/LibraryContent.tsx` — EN/FR card grouping + toggle, square thumbnails
- `src/services/contentService.ts` — `getVideoLibrary()` language field fix
- `src/lib/aspectRatioClass.ts` (deleted — no longer used)
- `src/components/PlatformSelector.tsx`, `src/types/content.ts` — Twitter/X dedup
- `src/app/api/jobs/[jobId]/video/approve/route.ts` — stale comment fix

**💡 Decisions Made**
- Bitrate-cap the two full-video re-encoding passes rather than tighten CRF further — CRF has no size ceiling by design (it tracks perceptual quality, not bytes), so any sufficiently long/complex script could always find a way back over the storage limit; a bitrate cap ties size to duration, which is bounded by the app's own scene-count/length rules.
- Duration is passed to the script prompt as a target, not a hard cap, and the model is explicitly told it's fine to run short/long rather than truncate narration — avoids trading one bug (ignored duration) for another (awkwardly cut-off videos).
- Committed as 3 separate commits (video pipeline fixes; dashboard card grouping + language fix + square crop; Twitter/X dedup) rather than one, since they're independent, separately-revertable concerns.

**⭐ Pick Up Next Session**
- Fix social posting getting permanently stuck at `status='posting'` — needs either a timeout/retry mechanism or at minimum a visible failure state instead of silent "No platform activity yet"
- Fix `WaitingCard`'s fake progress timer to poll real status the same way `GlobalProgressBar` does
- Enable RLS on `content_jobs`/`generated_content` (carefully — confirm no existing anon-key read path breaks first)
- Everything still open from Session 5 (KIE.ai negative-prompt investigation, blog e2e test flakiness, blog image permanent storage backport, stale-track UI indicator) remains open
