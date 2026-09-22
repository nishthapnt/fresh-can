# TASKS.md — Feature Backlog

---

## 🎯 CURRENT SPRINT

- [ ] Prompt architecture refactor (`PROMPT_REFACTOR_BRIEF.md`, `docs/PROMPT_ARCHITECTURE.md`) — layered brand truth → intent → plan → render → guard, in 9 phases. Phase 1 (brand truth as structured data, keywords removal) done Session 12; Phase 2 (intent interpretation step) done Session 13; Phase 3 (planning contracts) done Session 14; Phase 4 (Layer 3 — plan data now drives rendered prompts, `scene.ts` keyword-regex gates deleted) done Session 15; Phase 5 (Layer 4 Guard — PROMPT_LIMITS config with owner-confirmed real limits [3000 image/2500 video, not the originally-stated 3500], composeCharacterRefPrompt gained budget enforcement + a real §12 contradiction bug fix, new contradictions.ts validator) done Session 16, 2026-09-22. Next: Phase 6 (blog image-from-finished-copy ordering), Phase 7 (video continuity research), or Phase 8 (structural test rewrite). Still pending owner review of §16.3/§16.6/§16.7 and the category/content_angle dropdowns' fate.
- [ ] Investigate KIE.ai negative-prompt support to more reliably stop text baking into generated photos
- [ ] Stabilize `src/server/pipeline/steps/blog/blogPipeline.e2e.test.ts` (pre-existing real-DB timing flakiness; path corrected — file moved off `worker/` during the Inngest migration)
- [ ] Backport permanent Supabase Storage upload (`fc-image-posts` pattern) to blog's hero/inline images
- [ ] Surface "stale" track state in the job detail UI after a visual regenerate (currently silent — user must know to re-click Approve)
- [x] Fix social posting getting permanently stuck at status='posting' with no error/timeout/retry surfaced — confirmed live via 2 real stuck rows since 2026-07-01 (Session 6, 2026-09-14). The stuck-forever/no-timeout part was already fixed earlier (`publishPost.ts`'s `STALE_POSTING_MS`/`isStale`); the "no retry" part closed Session 7 (2026-09-19) — `upsertSocialPost` now clears a failed post's old `social_platform_logs` rows on re-approval, since `getApprovedSocialPostsAwaitingSubmission` was silently excluding any post with existing log rows forever, retry or not.
- [ ] `WaitingCard`'s progress bar (`src/app/dashboard/jobs/[job_id]/page.tsx`) is a fake wall-clock timer (`elapsed/90*85`, capped 85%) that never checks real backend status — unlike `GlobalProgressBar`, which was fixed to poll real pipeline/track state (Session 6, 2026-09-14)
- [ ] Enable RLS on `content_jobs`/`generated_content` (defined but not actually enforced — anon key has effectively unrestricted read/write on both today)
- [ ] Deploy to Vercel (or chosen host)
- [ ] Build real blog social posting support — blog never writes a `generated_content` row (no image/video), so posting it always failed deep in the pipeline; `SocialApprovalCard` now guards against this with a clear "not supported yet" message (Session 7, 2026-09-19) instead of a silent failure, but the actual feature (e.g. attach the blog's hero image, or a link-only post where the platform allows one) is still unbuilt

---

## 📋 BACKLOG

### 🏗️ Setup
- [x] Initialize Next.js 16 App Router project
- [x] Configure TypeScript, ESLint, Tailwind v4
- [x] Install ShadCN UI + required components
- [x] Set up Supabase client with realtime config
- [x] Create `.env.local` with all required keys
- [x] Add Supabase anon key
- [x] Create Supabase tables (run SQL migration) — extended further in `supabase/migrations/` for the blog/image pipeline (Session 5, 2026-09-09)

### 🎨 Frontend — Pages
- [x] /dashboard — KPI cards + recent jobs grid
- [x] /dashboard/new — Input form with all fields
- [x] /dashboard/jobs/[job_id] — Draft editor with tabs + realtime
- [x] /dashboard/jobs/[job_id]/social — Social caption + platform approval
- [x] /dashboard/library — Videos / Images / Blogs grid
- [ ] /dashboard/jobs/[job_id] — Show generated content preview when ready
- [ ] Toast notifications for save/approve/post actions

### 🎨 Frontend — Components
- [x] StatusBadge (all statuses + colors)
- [x] KPICard (with trend %)
- [x] ContentCard (job summary)
- [x] DraftEditor (per content type: blog, image, video)
- [x] SocialApprovalCard (caption + hashtags + platforms)
- [x] PlatformSelector
- [x] TopBar (breadcrumbs + page title)
- [x] Loading skeletons for all pages
- [ ] Toast notification component
- [ ] Confirm dialog before approve/post actions

### ⚙️ Backend / API
- [x] POST /api/webhooks/n8n-callback (draft_ready, generation_complete, post_complete)
- [ ] GET /api/jobs — list jobs with pagination (optional, currently uses Supabase direct)
- [ ] POST /api/jobs/[id]/retry — retry failed jobs

### 🗄️ Database
- [x] TypeScript types match Supabase schema
- [x] All CRUD service functions written
- [x] Confirm tables created in Supabase project jbrktjnscnzmhwupojiu
- [ ] Add DB indexes for performance (job_id, status, created_at)
- [ ] Seed dev data for testing

### 🔗 Integrations
- [x] n8n webhooks fire on form submit — now social + image_questions only; blog/image_post/video all moved to `worker/` (Session 5 2026-09-09 for blog/image_post; Session 6 2026-09-14 for video)
- [x] n8n callback API receives events and updates DB (social)
- [x] Supabase Realtime subscribed on job detail page
- [x] Blog pipeline fully migrated off n8n onto `worker/` (Session 5, 2026-09-09)
- [x] Image_post pipeline fully migrated off n8n onto `worker/` (Session 5, 2026-09-09)
- [x] Video pipeline fully migrated off n8n onto `worker/` (Session 6, 2026-09-14) — script, character-ref, per-scene visuals, per-language narration/captions/render all live-verified end-to-end (EN+FR)
- [ ] Verify n8n webhook URLs are live and responding (social, image_questions)
- [ ] Test social platform posting via n8n — confirmed BROKEN, not just untested: 2 `social_posts` rows stuck at status='posting' since 2026-07-01 with zero `social_platform_logs` rows and no error surfaced in the UI; only 1 post total has ever reached 'posted' out of 558 jobs

### 🧪 Testing
- [ ] Manual QA pass on full flow
- [ ] Test all error states (n8n unreachable, DB error)
- [ ] Test realtime updates in job detail page
- [ ] Cross-browser check (Chrome, Safari, Firefox)
- [ ] Mobile responsive check

### 🚀 Deployment
- [ ] Set up Vercel project
- [ ] Add all env vars to Vercel
- [ ] Deploy to staging
- [ ] QA on staging
- [ ] Deploy to production

---

## ✅ COMPLETED
- [x] Project scaffolded (Session 1, 2026-06-15)
- [x] All 5 pages built (Session 1, 2026-06-15)
- [x] n8n callback API route (Session 1, 2026-06-15)
- [x] All reusable components (Session 1, 2026-06-15)
- [x] Project docs filled in (Session 2, 2026-06-15)
- [x] UI upgrade with skeletons, TopBar, improved empty/error states (Session 2, 2026-06-15)
- [x] Dashboard login (ID/password + HMAC session cookie) (Session 4, 2026-07-17)
- [x] Blog pipeline rebuilt on `worker/` architecture, off n8n — routes, worker steps, copy-only regeneration, live-verified EN/FR/BOTH (Session 5, 2026-09-09)
- [x] Image_post pipeline built on the same architecture from scratch — routes, worker steps, permanent storage, context (location/scene notes/Q&A) wiring, live-verified (Session 5, 2026-09-09)
- [x] Full n8n cutover for blog + image_post — old webhook paths structurally removed, not just unused (Session 5, 2026-09-09)
- [x] Video pipeline built on `worker/` architecture, off n8n — script/character-ref/per-scene-visuals shared once per job, per-language narration/captions/render; found + fixed live during end-to-end testing: scene clips exceeding Supabase's upload size limit (per-clip downscale + bitrate cap instead of uncapped CRF), KIE.ai video-poll timeout too short (180s→360s), and the dashboard's video-duration selection never reaching the script prompt (Session 6, 2026-09-14)
- [x] Dashboard: EN/FR video jobs shown as one card with a language toggle instead of two duplicate cards, on both the dashboard home page and the library grid; fixed an underlying bug where the library's own video query read the job's requested language instead of each row's real language, which silently dropped one language from grouping (Session 6, 2026-09-14)
- [x] Removed duplicate Twitter/X platform checkbox in social approval (Session 6, 2026-09-14)

---

## 🔴 BLOCKED

_None currently._

---

## 💡 IDEAS / FUTURE FEATURES

- Analytics page: posts per week chart, engagement rates
- AI caption regeneration button (single-click re-run)
- Bulk approve all drafts for a job
- Email notification when generation is complete
- Dark mode
- Role-based access (editor vs. approver vs. admin)
