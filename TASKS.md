# TASKS.md — Feature Backlog

---

## 🎯 CURRENT SPRINT

- [ ] Investigate KIE.ai negative-prompt support to more reliably stop text baking into generated photos
- [ ] Stabilize `worker/src/steps/blogPipeline.e2e.test.ts` (pre-existing real-DB timing flakiness)
- [ ] Backport permanent Supabase Storage upload (`fc-image-posts` pattern) to blog's hero/inline images
- [ ] Surface "stale" track state in the job detail UI after a visual regenerate (currently silent — user must know to re-click Approve)
- [ ] Video migration off n8n (Phase 9 — largest remaining piece, not started)
- [ ] Deploy to Vercel (or chosen host)

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
- [x] n8n webhooks fire on form submit — now video/social only; blog/image_post moved to `worker/` (Session 5, 2026-09-09)
- [x] n8n callback API receives events and updates DB (video/social)
- [x] Supabase Realtime subscribed on job detail page
- [x] Blog pipeline fully migrated off n8n onto `worker/` (Session 5, 2026-09-09)
- [x] Image_post pipeline fully migrated off n8n onto `worker/` (Session 5, 2026-09-09)
- [ ] Verify n8n webhook URLs are live and responding (video/social)
- [ ] Test social platform posting via n8n

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
