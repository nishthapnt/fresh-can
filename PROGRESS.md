# PROGRESS.md — Session Log

---

## 📊 CURRENT STATUS

| Field | Value |
|-------|-------|
| **Project** | Fresh-CAN Content Automation Dashboard |
| **Last Updated** | 2026-09-19 |
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

---

### Session 7 — 2026-09-19
**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Real logo watermark on every image_post photo (photo + infographic styles)*
- Added `sharp` and `compositeLogoWatermark()` (`src/server/pipeline/lib/watermark.ts`), wired into `SupabasePhotoStorageUploader.upload()` (`adapters/storage.ts`) — the one place every image_post photo (first attempt, retry, or regeneration) already passes through, so no orchestration changes were needed.
- Removed the AI-drawn corner-logo instruction (`brand.logoDescriptor`) from the `infographic` prompt (`prompts/core/compose.ts`) and deleted the now-unused field from `BrandProfile`/`fresh-can.ts` — the real composited logo now covers both `photo` and `infographic` styles instead of risking a doubled/conflicting logo on infographics.
- `next.config.ts`: `outputFileTracingIncludes` for `/api/inngest` so the logo PNG (read via `fs`, not imported) ships in the deployed serverless bundle, not just local dev.
- Bundled in the `generatePhoto.ts` top-level try/catch hardening from the start this time (split into a thin wrapper + `runGeneratePhotoInner`) — any unexpected exception now marks the pipeline failed instead of leaving it stuck at `'generating'`.
- **A real bug caught by testing, not assumed away, then iterated on with the user's own visual feedback:** the brand's real logo asset is the white "negative" variant, meant for placement over a busy/colored background.
  1. A first pass (crisp logo composited directly, then a soft blurred dark halo behind it) turned out to be invisible/too weak whenever the top-right corner landed on a bright area (confirmed live against a real photo with a sunny sky corner) — thin sans-serif letterforms don't have enough "ink" for a blur to build real contrast.
  2. Second pass: a solid, semi-transparent dark backing chip (45% opacity black, padded around the logo). Legible, but the user reviewed a live generated image and called it out as "a weird black box" against real ad-style reference images that instead use a soft corner treatment.
  3. Final: a radial gradient vignette anchored at the true top-right corner (SVG rasterized via sharp — dark near the corner, fully transparent well before the image's midpoint, no hard edge anywhere) with the crisp logo on top. Matches the reference images' look, confirmed against three different real backgrounds (bright sky, busy street photo, the truck's mixed sky/building/tree background).

**🧪 Testing (this is what caught the bug above, twice)**
- Unit tests against both a synthetic solid-color image and a real sample photo from `assets/fresh-can/`.
- Full local end-to-end smoke test via `KIE_FAKE_MODE=true` (real download → composite → Supabase upload path, zero KIE cost) for one `photo`-style and one `infographic`-style job, run through the actual local Inngest dev server — this is what surfaced the invisible-logo bug, since the fake source image happens to have a bright sky in the top-right corner.
- After the chip-backing fix: re-ran the same two fake-mode jobs clean, then one real KIE-backed job (`photo` style, real 2048×2048 render) — confirmed via downloaded/viewed output. The user then flagged the chip itself as visually wrong against their own reference images.
- After the gradient fix (superseding the chip): re-verified against the same bright-sky sample plus the truck reference photo, then re-ran both fake-mode jobs clean through the live pipeline again and visually confirmed the final output.
- Full suite (`tsc --noEmit`, `eslint`, `vitest run`) clean throughout every iteration; only the pre-existing, unrelated `kie.test.ts` `KieVideoGenerator` model-config failure remains (not touched this session).
- `KIE_FAKE_MODE` turned back off in `.env.local` afterward; all test job rows cleaned up from Supabase.

**📁 Files Changed**
- `src/server/pipeline/lib/watermark.ts` (new) + `.test.ts` (new)
- `src/server/pipeline/adapters/storage.ts` — composites the watermark before upload
- `src/server/pipeline/steps/image/generatePhoto.ts` — top-level try/catch hardening
- `src/server/pipeline/prompts/core/compose.ts`, `prompts/types.ts`, `prompts/brand/fresh-can.ts` — removed AI-drawn `logoDescriptor`
- `src/server/pipeline/prompts/core/compose.test.ts`, `composeText.test.ts` — updated fixtures/assertions for the removed field
- `src/server/pipeline/adapters/nanoBanana.ts` — comment fix
- `next.config.ts` — `outputFileTracingIncludes` for the bundled logo asset
- `package.json`/`package-lock.json` — added `sharp`
- `assets/fresh-can/freshcan_logo.png` (new, tracked — now read at runtime, not just a reference photo)

**💡 Decisions Made**
- Radial gradient vignette over both a blurred drop-shadow (too weak) and a flat backing chip (legible, but looked like an obviously pasted-on box) — a soft corner fade has no hard edge anywhere and matches how real ad-style reference images treat a corner logo.
- Test with `KIE_FAKE_MODE` first (free, instant, exercises the real code path) before spending a real KIE call — this is what caught the invisible-logo bug cheaply instead of on a live user-facing job.
- An earlier attempt at this same feature (without the fake-mode smoke test step) shipped, broke on a live job, and was fully reverted — see git history around commits `image logo added` / `Fix image_post pipeline` (both reverted) before this session's redo.

**⭐ Pick Up Next Session**
- Verify the `outputFileTracingIncludes` asset actually lands in a real Vercel build output before the next production deploy (only confirmed locally so far).
- The gradient's radius/peak-opacity constants were tuned against a bright sky, a busy street photo, and the truck reference photo — not exhaustively against every possible background; revisit if a future real generation still shows weak contrast.
- Everything still open from Session 5 (KIE.ai negative-prompt investigation, blog e2e test flakiness, blog image permanent storage backport, stale-track UI indicator) remains open

---

### Session 7 (cont'd) — 2026-09-19 — Video prompt parity with Blog/Image Post
**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Video's script/scene-plan/scene-image/scene-motion/localize prompts now treat the user's "Your Scene Idea" as the creative brief, and steer away from an "ad" look, the same way Blog and Image Post already did*
- The dashboard's `scene_notes` field previously said outright "not used for Video" (`src/app/dashboard/new/page.tsx`) — `fetchVideoJobFields` (`src/inngest/functions/video.ts`) never even selected it. Now selected, threaded through `VideoScriptJobInput` (`generateScript.ts`), and passed into `composeVideoScriptSystemPrompt` (`composeText.ts`) exactly like `composeOutlineSystemPrompt` already does for Blog: when present, the story and every scene are built around it; brand mission/voice/category/real vehicle details become fixed constraints on tone/accuracy/appearance, never the angle.
- Added an unconditional anti-ad instruction to `composeVideoScriptSystemPrompt` (present whether or not a scene idea is given) — the video and every scene must read as a genuine story/moment, never scripted ad copy or a polished commercial.
- `composeSceneImagePrompt` (`compose.ts`): dropped the `"Scene N of a marketing video"` framing (was priming a staged/ad look before the model even read the scene) and appended the same `SCENE_IS_CREATIVE_BRIEF` clause Blog/Image Post's photo prompts already use — the character-ref vehicle is a fixed constraint on how it must look, never the reason the scene exists.
- `composeSceneVideoPrompt` (motion/Kling prompt): added a matching camera-direction clause ruling out staged product-reveal moves (slow orbits, dramatic hero push-ins) — the motion-side equivalent of the same fix.
- `composeLocalizeScriptSystemPrompt`: added one sentence asking for natural spoken narration, never a voiceover that sounds like a commercial.
- Updated the dashboard's scene-idea helper text to say Video's story/scenes are built around it too, instead of "not used for Video".

**🧪 Testing**
- Added/extended unit tests in `composeText.test.ts` (new `composeVideoScriptSystemPrompt`/`composeLocalizeScriptSystemPrompt` describe blocks) and `compose.test.ts` (new `composeSceneVideoPrompt` describe block plus assertions on `composeSceneImagePrompt`'s dropped "marketing video" framing and added anti-ad clause).
- `tsc --noEmit`, `eslint` on touched files, and `vitest run` all clean.

**📁 Files Changed**
- `src/inngest/functions/video.ts` — `fetchVideoJobFields` now selects `scene_notes`
- `src/server/pipeline/steps/video/generateScript.ts` — `VideoScriptJobInput.sceneNotes`
- `src/server/pipeline/prompts/core/composeText.ts` — `composeVideoScriptSystemPrompt` sceneNotes + anti-ad; `composeLocalizeScriptSystemPrompt` anti-ad
- `src/server/pipeline/prompts/core/compose.ts` — `composeSceneImagePrompt`/`composeSceneVideoPrompt` anti-ad framing
- `src/app/dashboard/new/page.tsx` — scene-idea helper text
- `src/server/pipeline/prompts/core/compose.test.ts`, `composeText.test.ts` — new coverage

**💡 Decisions Made**
- Reused the exact `SCENE_IS_CREATIVE_BRIEF` constant in video's scene-image prompt rather than inventing new wording, so the "brand is a constraint, not the angle" framing can't drift between Blog/Image Post/Video.
- Kept the anti-ad instruction in the script prompt unconditional (not gated on `sceneNotes` being present) — it's a general quality bar for every video, not something that only applies when the user supplies a scene idea.

**⭐ Pick Up Next Session**
- No live KIE-backed video run yet with a real scene idea — worth one real end-to-end video generation to visually confirm the anti-ad framing actually changes output, the way the watermark work above was confirmed live before trusting it.

---

### Session 7 (cont'd) — 2026-09-19 — Image prompts stopped dictating style; real brand-identity fixes for side doors/text

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Root cause: a real generation ("split-scene educational visual... clean editorial photography... professional social-impact campaign aesthetic") came back as a generic single candid photo with a hallucinated door on the truck's side. Traced to hardcoded prompt text in `core/compose.ts`/`brand/fresh-can.ts` dictating STYLE (mood, "candid, never posed/polished", forced camera narrative from the reference photo) that fought the user's own explicit request, plus a real brand-identity gap (nothing ever said what's actually on the container's visible side, so the model filled the ambiguity itself).*

- **Mood/lighting**: `moodDetailFor` was unconditionally asserting a specific mood ("Soft overcast daylight... calm documentary mood") even when the user's own scene text said "warm natural lighting" and answered "Afternoon" — a hardcoded default silently overriding an explicit choice. New `moodClause` wraps it as an explicit fallback: "If the scene above doesn't already establish its own lighting/time of day/mood, default to: ...".
- **`SCENE_IS_CREATIVE_BRIEF`**: dropped "must read as a genuine, candid moment... never a posed, polished advertisement" — a style mandate directly opposed to a user asking for editorial/campaign style. Kept only the priority-ordering part (brand details are constraints *if* they appear, never the reason the scene exists), and added explicitly that style/mood/composition come entirely from the scene description.
- **Reference-photo framing text**: was being pushed as a bare sentence (e.g. "three-quarter front view as the truck arrives and parks at the curb") with nothing telling the model it described the *input* photo rather than dictating the *output's* camera work — confirmed this is what made the split-composition request get ignored in favor of an ordinary truck shot matching the reference. New `describeReferencePhoto()` wraps it: "The attached reference photo shows: ... it does not dictate this image's own camera angle, composition, or story."
- Dropped "documentary style"/"natural lighting" from `noTextInstruction`/`noNewTextInstruction` (redundant style dictation layered onto what those fields actually exist for) and a redundant "must depict a real, specific moment" line in `composePhotoPrompt`.
- Applied the same mood/reference-framing fixes to Blog's `containerSceneContext` for consistency (same anti-pattern, same fix).
- **Real brand-identity gap (the side door)**: `containerDescriptor` never said what the container's SIDE panels actually look like — only the cab and rear face were described. Now explicit: both sides are plain maroon-red with ONLY the wordmark logo, nothing else, and no door/hatch/window/vent/opening of any kind. The two reference photos that visually show extra stuff on the side (a decorative red graphic, "fresh-can.com" text, and — `standing.png` — two vents) now have their `framing` strings explicitly call those specific real details out and tell the model to disregard them in favor of the logo-only rule, instead of leaving the mismatch between text and photo for the model to resolve on its own.
- **"No added text" gap**: `noNewTextInstruction` only forbade invented text "on the vehicle," leaving everything else in frame unscoped — confirmed live this is what let a 'photo'-style (strictly-no-text) generation add invented panel labels and storefront signage for a split-scene request. Reworded to a blanket "no text anywhere in the image, on the vehicle or off it" (still preserving the vehicle's own real signage). `infographic` style is unaffected — it routes through a completely separate function (`infographicTextLayer`) that `textLayerFor` picks instead.

**🧪 Testing**
- Full prompt test suite (`compose.test.ts`/`composeText.test.ts`, 80 tests) + `tsc --noEmit` + `eslint` clean after every edit.
- Three real KIE-backed generations, same split-scene job each time, to confirm each fix actually changed the output (fake mode is useless here — it always returns the same canned image regardless of prompt content):
  1. Baseline mood/style/reference-framing fixes → genuine 3-panel split composition, correct rear-only door, but with more on-image text than "minimal text" asked for.
  2. After the "no added text" fix → split composition held, on-image text reduced (though not perfectly zero — some signage still leaked through).
  3. After the side-panel logo-only fix, deliberately re-seeded to force the exact reference photo (`truck_exterior_arrival.png`) that had produced the hallucinated door → correct geometry this time: door only on the narrow rear face, the long visible side panel showing only the wordmark, nothing else.
- All three test jobs' DB rows cleaned up afterward.

**📁 Files Changed**
- `src/server/pipeline/prompts/core/compose.ts` — `moodClause`, reworded `SCENE_IS_CREATIVE_BRIEF`, new `describeReferencePhoto()`, reworked `containerSceneContext`, `composePhotoPrompt` cleanup
- `src/server/pipeline/prompts/brand/fresh-can.ts` — `containerDescriptor` now covers the sides explicitly; `arrival`/`standing` reference `framing` strings call out and override real extra details; `noTextInstruction`/`noNewTextInstruction` tightened (dropped style dictation, closed the "on the vehicle only" scoping gap)
- `src/server/pipeline/prompts/core/compose.test.ts` — updated assertion for the reworded `SCENE_IS_CREATIVE_BRIEF` text

**💡 Decisions Made**
- General principle going forward for this file: hardcoded brand rules enforce brand IDENTITY only (shape, color, logo placement, door location) — never style, mood, composition, or camera narrative. Those come entirely from the user's own scene description, whatever it asks for.
- Resolved the reference-photo-vs-text-rule contradiction by having the `framing` string explicitly name and override the specific real details that don't match the simplified brand rule, rather than either (a) lying about what the reference photo shows, or (b) leaving the model to notice and resolve the mismatch itself — the latter is exactly what produced the original hallucinated door.

**⭐ Pick Up Next Session**
- The residual on-image text (storefront signage, a sandwich-board sign) in test run #2 suggests `noNewTextInstruction`'s new wording helps but doesn't fully eliminate added text for a scene that strongly implies a labeled/diagrammatic layout — worth another real test focused specifically on that if it recurs.
- `back.png`'s framing string was left untouched (already accurate, rear-only view) — no side visible, nothing to reconcile.
- Same style-dictation pattern still exists in Blog's non-container branch (`nonContainerSceneHint`/`categoryVisualHints`/`backgroundBrandingInstruction` — "candid documentary photo" wording) — untouched this session since it's a different code path not exercised by the reported bug; revisit if the same complaint comes up for Blog.

---

### Session 7 (cont'd) — 2026-09-19 — Fixed burned-in video captions overflowing the frame edges

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Root cause: a real generated video's burned-in caption ran off both the left and right edges of a 9:16 frame ("s a struggle. FreshCan partners wi", clipped both sides). `avMerger.ts`'s caption chunker (`normalizeCaptionCues`) grouped words into lines by a FIXED count (`wordsPerLine = 7`) with zero awareness of actual word length or frame width, then `buildCaptionCommand`'s drawtext filter centered each line with `x=(w-text_w)/2` — never checking that the rendered `text_w` actually fit within `w`. Once a 7-word line's real width exceeded the frame, `x` went negative and the line ran off both sides.*

- `normalizeCaptionCues` now chunks WIDTH-aware: given the real frame width and the fontsize about to be used, it greedily packs words into a line until the next word would push the estimated rendered width past a safe budget (86% of frame width, using a deliberately safety-biased average-character-width heuristic), then starts a new line — instead of a flat word count. Falls back to the old fixed-count behavior only when no frame width is known (kept for callers that don't care about exact wrapping).
- The real frame width was already fully knowable but never plumbed through: every scene clip is pre-scaled to one of exactly three fixed resolutions (`ASPECT_RATIO_RESOLUTIONS` — pulled out of `generateSceneVisual.ts`'s local `SCALE_TARGETS` into `lib/videoResolution.ts` so both files share one source of truth). `content_jobs.aspect_ratio` is now threaded through: `video.ts`'s `videoTrackRender` (which already had `job.aspect_ratio` in scope) → `runRenderLanguageTrack` → `AVMerger.submitCaptionBurn` → `buildCaptionCommand`, defaulting to `'9:16'` throughout to match the rest of the pipeline.
- Added a defensive per-cue fontsize shrink as a backstop for the one case width-aware chunking can't split further — a single "word" (long URL/name) that alone still exceeds the safe width budget: that cue's fontsize is reduced (in plain JS, `fontsize=h*<computed ratio>`) by exactly the amount needed to bring it back in bounds, rather than as an ffmpeg-side `min()` expression (which would need an escaped comma in the filter string — not worth that extra escaping risk for a rare edge case, especially since `escapeDrawtextValue` is already flagged as unverified against a real render). Every ordinary cue still renders at the original fixed `fontsize=h*0.033`.

**🧪 Testing**
- `avMerger.test.ts`: updated the one test whose exact chunking assumption changed (an 8-word list now wraps into 3 lines on the default 9:16 frame instead of a flat 7/1 split), and added: a 9:16-vs-16:9 comparison proving the narrower frame produces more/shorter lines for identical words; a long-unbreakable-word case proving the defensive fontsize shrink kicks in only for that cue, never for ordinary short cues; direct `normalizeCaptionCues` unit tests for the fallback path, the width-driven wrap decision, and malformed input.
- `tsc --noEmit`, `eslint`, and the full `vitest run` all clean (pending final full-suite confirmation this run).

**📁 Files Changed**
- `src/server/pipeline/lib/videoResolution.ts` (new) — `ASPECT_RATIO_RESOLUTIONS`, shared between `generateSceneVisual.ts` and `avMerger.ts`
- `src/server/pipeline/steps/video/generateSceneVisual.ts` — now imports `ASPECT_RATIO_RESOLUTIONS` instead of a local `SCALE_TARGETS`
- `src/server/pipeline/adapters/avMerger.ts` — width-aware `normalizeCaptionCues`, aspect-ratio-aware `buildCaptionCommand`, defensive per-cue fontsize shrink
- `src/server/pipeline/adapters/types.ts` — `AVMerger.submitCaptionBurn` gains an `aspectRatio` param
- `src/server/pipeline/steps/video/renderLanguageTrack.ts` — `runRenderLanguageTrack` gains an `aspectRatio` param, passed to `submitCaptionBurn`
- `src/inngest/functions/video.ts` — passes `job.aspect_ratio` through to `runRenderLanguageTrack`
- `src/server/pipeline/adapters/avMerger.test.ts` — updated + new coverage

**💡 Decisions Made**
- Computed the defensive fontsize shrink in plain JS rather than as an ffmpeg `min()` expression — avoids introducing a new, unverified escaping case (a raw comma inside a filter option value) purely for a rare edge case a JS-side computation handles just as well with no new risk.
- Pulled `SCALE_TARGETS` out into a shared `lib/videoResolution.ts` rather than duplicating the aspect-ratio→resolution map a second time in `avMerger.ts` — the two need to stay byte-identical (they're describing the same real delivery resolution), so a shared constant is what stops them drifting apart, matching this codebase's existing precedent (e.g. `CONTAINER_DESCRIPTOR`) for exactly this kind of shared-fact extraction.

**⭐ Pick Up Next Session**
- No real KIE/upload-post.com-backed video run yet with a caption long enough to actually exercise the new wrapping on a live render — worth one real end-to-end video generation with a longer script to visually confirm captions now stay within frame, the same way the watermark and video-prompt work earlier this session were each confirmed live before being trusted.
- The average-character-width heuristic (0.62 of fontsize) and safe-width fraction (86%) are tuned conservatively by estimate, not measured against a real ffmpeg/drawtext render — revisit if a live render still shows text unusually close to (or, more concerning, still touching) either edge.

---

### Session 7 (cont'd) — 2026-09-19 — Logo scoped to the truck only

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**
- `containerDescriptor` (`brand/fresh-can.ts`) now ends with an explicit rule: the wordmark (rear + both sides, as already described) is the ONLY place the Fresh-CAN logo may appear anywhere in the image — never stamped onto another vehicle, sign, storefront, package, clothing, screen, or object, unless the scene description explicitly calls for a logo somewhere else (the existing "AI & Mobile Technology" categoryVisualHint, where the app/wordmark is explicitly allowed on a phone screen, is exactly that carve-out). This generalizes the existing but narrower `BACKGROUND_TRUCK_CLAUSE` rule (which only ever covered "other vehicles"), and since `BACKGROUND_TRUCK_CLAUSE`/`composeCharacterRefPrompt` both splice in `containerDescriptor` verbatim, they inherit this automatically.

**🧪 Testing**
- `tsc --noEmit`, `eslint`, `vitest run` (prompts, 80 tests) clean.
- One real KIE-backed generation with a scene deliberately containing other brandable elements (a diner storefront, a delivery van, other parked cars, a community bulletin board) — confirmed live: only the truck carries the Fresh-CAN wordmark; the diner keeps its own "DINER" signage, the bulletin board shows generic flyers, and every other vehicle stays unbranded. Test job cleaned up afterward.

**📁 Files Changed**
- `src/server/pipeline/prompts/brand/fresh-can.ts` — `CONTAINER_DESCRIPTOR` gains the logo-scope sentence

**💡 Decisions Made**
- Added the rule to `CONTAINER_DESCRIPTOR` itself (rather than a separate constant) so every composer that already splices it in (image_post's photo, Blog's container branch, `BACKGROUND_TRUCK_CLAUSE`, `composeCharacterRefPrompt`) picks it up for free, with no new call sites to wire up.

---

### Session 7 (cont'd) — 2026-09-19 — Tightened composeSceneImagePrompt back under KIE's Market endpoint length cap

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Root cause: a real "video test" job failed at scene 1 with `kie call failed (status 200): The text length cannot exceed the maximum limit` — KIE.ai's Market endpoint (`KieSceneImageGenerator`, the cheaper test-mode route `generateSceneVisual.ts` uses for per-scene images) enforces an undocumented prompt-length cap already known from `kie.ts`'s own history: `composeCharacterRefPrompt`'s ~1300-char output hard-failed there in 2026-09-17 testing, while `composeSceneImagePrompt`'s ~500-600-char output worked fine at the time. Every constraint added to `composeSceneImagePrompt` since then (`FOOD_MUST_LOOK_CLEAN`, `REFERENCE_IS_GUIDE_NOT_COPY`, a lengthened `noNewTextInstruction`, `moodClause`, and this session's own `SCENE_IS_CREATIVE_BRIEF` addition) pushed a realistic scene prompt to 1761 chars — well past the confirmed-failing mark.*

- Tightened the wording (never the substance) of every shared constant `composeSceneImagePrompt` splices in: `moodClause`'s wrapper sentence, `SCENE_IS_CREATIVE_BRIEF`, `REFERENCE_IS_GUIDE_NOT_COPY`, `FOOD_MUST_LOOK_CLEAN` (all in `core/compose.ts`), and the brand file's `noTextInstruction`/`noNewTextInstruction` (`brand/fresh-can.ts`) — collapsing redundant restatements and near-synonym enumerations (e.g. "no text, no words, no letters, no captions, no titles" → "text") down to one sentence each, while keeping every distinct rule and every enumerated list item (the food-defect list, the style list, the "on the vehicle or off it" scoping fix) intact.
- Measured before/after with a real `BRAND_PROFILE` + realistic scene: **1761 → 1220 chars** (31% shorter) for the same scene, comfortably clear of the confirmed-failing ~1300-char mark, with every constraint preserved — verified by re-checking each anchor phrase `compose.test.ts` already asserted on.
- Also tightened `noTextInstruction`/`noNewTextInstruction` even though only `noNewTextInstruction` is on the capped path here — both get spliced into every `'photo'`-style image prompt (blog, image_post, video), so shrinking them helps everywhere, not just video scenes.

**🧪 Testing**
- Updated the one test whose asserted substring no longer appeared verbatim after tightening (`composePhotoPrompt`'s style/mood/composition assertion, reworded to match, same constraint still checked) — every other existing anchor-phrase assertion (`'never as the reason this scene exists'`, `'clean, fresh, tidy, and appetizing'`, `'Never render food looking dirty, rotten, messy, or unappetizing'`, `'only as a guide'`, `'never as a literal photo to copy'`) still passes unchanged, confirming no constraint was dropped, only reworded.
- `tsc --noEmit`, `eslint`, full prompt test suite (80 tests) clean; full `vitest run` pending final confirmation this run.

**📁 Files Changed**
- `src/server/pipeline/prompts/core/compose.ts` — tightened `moodClause`, `SCENE_IS_CREATIVE_BRIEF`, `REFERENCE_IS_GUIDE_NOT_COPY`, `FOOD_MUST_LOOK_CLEAN`
- `src/server/pipeline/prompts/brand/fresh-can.ts` — tightened `noTextInstruction`, `noNewTextInstruction`
- `src/server/pipeline/prompts/core/compose.test.ts` — updated the one reworded assertion

**💡 Decisions Made**
- Chose wording compression over switching `generateSceneVisual.ts` off the cheap Market endpoint (the other option discussed) — keeps the ~5-credits-vs-~55-credits testing cost savings `kie.ts`'s own `KieSceneImageGenerator` comment documents, at no cost to the actual constraints enforced.
- Deliberately kept every constant's literal defect/style enumeration list intact (food defects, style options, the "on the vehicle or off it" scoping) even where a shorter summary word would have saved more characters — specificity in these enumerations is what several of this session's earlier real-generation bug fixes actually depended on, so length was cut from connecting prose, never from the lists themselves.

**⭐ Pick Up Next Session**
- The real "video test" job that surfaced this (scene 1, 8 scenes, 38s duration) should be re-run to confirm the shorter prompt actually clears KIE's Market endpoint now — not yet verified against a real KIE call this session.
- `visualDescription`/`shotNotes` are model-generated per scene with no length cap enforced at `composeVideoScriptSystemPrompt` — an unusually elaborate scene could still push the total prompt back toward the danger zone even after this fix. A defensive local length check (fail fast with a clear internal error, or truncate, before ever calling KIE) was discussed but not implemented this session — worth adding if this recurs.
- `composeCharacterRefPrompt` was NOT tightened (it doesn't run through the length-capped endpoint), so it's still ~2000+ chars — fine as-is, but worth knowing if that endpoint's routing ever changes.

---

### Session 7 (cont'd) — 2026-09-19 — Wording tightening wasn't enough; switched scene-image generation off the capped endpoint

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*The wording-tightening fix above (1761→1220 chars) did NOT fix the real issue. Re-ran a fresh job right after: all 7 scenes failed with the identical "text length cannot exceed the maximum limit" error, on the FIRST attempt each — including scenes whose `visual_description` was only ~97-99 chars, far shorter than the ones that failed before tightening. Pulled the real rows from Supabase directly (`content_jobs`/`content_pipelines`/`video_scenes`/`pipeline_steps`) to confirm this wasn't a stale/duplicate report of the earlier failure. Uniform failure regardless of scene-content length rules out "still marginally too long" — it means the Market endpoint's real cap is lower than even the tightened fixed overhead alone (~988 chars before any scene content), so no further wording squeeze could fix this without cutting real constraints (which was ruled out — the whole point of the prior fix was to keep every constraint).*

- Also confirmed via the DB that this error is genuinely specific to the scene-IMAGE step: queried every `pipeline_steps` row across all jobs containing "text length" in `error_message` — all 68 are on `generate_scene_visual:image:*`, zero on `generate_scene_visual:video:*` (the Hailuo clip model) or anywhere else. `composeSceneVideoPrompt` is short by design (no brand text at all — just visual description + shot notes + one motion sentence), so it's never come close to hitting this.
- **Fix**: switched `video.ts`'s `sceneImageGenerator()` from `KieSceneImageGenerator` (KIE's cheaper, length-capped Market endpoint) to `KieImageGenerator` — the same dedicated, uncapped Flux Kontext endpoint `characterRefGenerator()` (and blog/image_post) already use. This was already flagged as the production fix in `kie.ts`'s own `KieSceneImageGenerator` header ("NOT necessarily the right choice for production... Point generateSceneVisual.ts back at a KieImageGenerator instance for production output").
- Left scene VIDEO clip generation (`sceneVideoGenerator()`, Hailuo 02 Standard) untouched, per explicit instruction — no equivalent bug there to fix, and it stays on the cheaper model for now.
- Removed the now-unused `KieSceneImageGenerator` import from `video.ts`; the class itself stays defined/exported in `kie.ts` (still referenced from comments, not deleted).

**🧪 Testing**
- `tsc --noEmit`, `eslint` clean. Full `vitest run` in progress at time of writing (no test depends on which generator class `sceneImageGenerator()` returns — it's exercised only through the real Inngest function, not mocked in any test file).

**📁 Files Changed**
- `src/inngest/functions/video.ts` — `sceneImageGenerator()` now returns `KieImageGenerator`; dropped the unused `KieSceneImageGenerator` import

**💡 Decisions Made**
- Superseded this same session's earlier "wording compression over switching endpoints" decision (see the entry above) — real evidence (uniform failure across widely-varying-but-still-short scene lengths) showed compression alone can't reliably solve this without an unknown, possibly much lower real cap, and continuing to guess at wording would just be indefinite whack-a-mole against future prompt growth. The endpoint switch removes the ceiling entirely instead.
- Accepted the ~55-vs-~5-credit cost increase per scene image (same tradeoff `characterRefGenerator()` already made) rather than keep fighting the cap with prose.
- Kept the tightened wording from the prior fix anyway (didn't revert it) — shorter prompts are still a reasonable default even off the capped endpoint, and the constraint-preservation work isn't wasted.

**⭐ Pick Up Next Session**
- Re-run a real video job end-to-end to confirm scene images now succeed on the uncapped endpoint (not yet verified against a real KIE call).
- If cost becomes a real concern, worth confirming with the user whether to keep scene IMAGES on the expensive endpoint long-term or revisit a hybrid (cheap endpoint by default, falling back to the expensive one only when the composed prompt is measured to exceed a safe budget) — not implemented, just flagged as a future option.

---

### Session 7 (cont'd) — 2026-09-19 — Fixed captions drifting out of sync with audio (real duration vs. word-count estimate)

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Asked to check captions were in sync with audio. Traced `transcribeAudio.ts`'s cumulative-offset logic (it transcribes each scene's audio SEPARATELY via AssemblyAI, then stitches the word timings into one flat timeline by adding each scene's own audio duration as the offset for the next scene, since no audio-concatenation service existed at that layer yet). The offset was using `video_scene_audio.duration_ms` — `synthesizeVoice.ts`'s own comment names it explicitly: a WORD-COUNT ESTIMATE (150 wpm / 2.5 words/sec) because "ElevenLabs' plain text-to-speech response doesn't reliably expose real measured audio duration." That estimate has no reason to match ElevenLabs' actual speaking pace (pauses, punctuation, natural rhythm), and the error compounds scene over scene — by scene 6-8 of a longer video, captions could drift meaningfully behind or ahead of the real concatenated audio track `renderLanguageTrack.ts` builds from these same files.*

- AssemblyAI's own transcription response already reports the REAL measured duration of the exact audio file it transcribed (`audio_duration`, in seconds) — this was being fetched but discarded. Added `audioDurationMs` to `TranscriptionPollResult` (`adapters/types.ts`), populated it in `assemblyai.ts`'s `poll()` (converted from AssemblyAI's seconds to ms), and changed `transcribeAudio.ts`'s cumulative-offset accumulator to prefer it over the estimate: `outcome.audioDurationMs ?? audio.duration_ms ?? 0`. No new API call needed — the real duration was already sitting in a response this step already makes every time.
- Fully backward compatible: the new field is optional, so any mock/provider that doesn't report it falls back to exactly the old estimate-based behavior — confirmed via the existing e2e test (`videoPipeline.e2e.test.ts`'s M3 caption test), which doesn't set it and still passes unchanged.
- **Related but separate finding, NOT fixed this session** (out of scope for "check the captions" specifically): `ARCHITECTURE.MD` §4.2 documents an intended "render-time reconciliation" step — holding the last frame or trimming trailing silence per scene so each scene's VIDEO clip (a fixed 5s/10s Kling/Hailuo duration) stays in sync with that scene's real (variable-length) narration audio. Checked `renderLanguageTrack.ts`/`avMerger.ts`: this per-scene reconciliation was never actually implemented — video and audio are concatenated independently with no per-scene padding/trimming, then only reconciled once at the very end via mux's `-shortest`. This affects video-vs-audio sync per scene, not captions-vs-audio (which this session's fix addresses) — flagged for a future session if it turns out to matter in practice.

**🧪 Testing**
- `assemblyai.test.ts`: two new tests — `audio_duration` (seconds) correctly converts to `audioDurationMs`; the field stays `undefined` when the provider response omits it.
- `videoPipeline.e2e.test.ts`: new M3 test against a real DB — two scenes with IDENTICAL word counts (so `synthesizeVoice`'s estimate is the same 2000ms for both, by construction), fed a deliberately different real `audioDurationMs` of 5000ms via the mock transcription service; asserts the second scene's caption words start at exactly 5000ms, not 2000ms — this would fail if the fix silently fell back to the estimate.
- `tsc --noEmit`, `eslint` clean. `assemblyai.test.ts` (9 tests) passes. The new/full e2e run was in progress against the real DB at time of writing.

**📁 Files Changed**
- `src/server/pipeline/adapters/types.ts` — `TranscriptionPollResult.audioDurationMs`
- `src/server/pipeline/adapters/assemblyai.ts` — reads and converts `audio_duration`
- `src/server/pipeline/steps/video/transcribeAudio.ts` — offset accumulator prefers the real duration
- `src/server/pipeline/adapters/assemblyai.test.ts`, `steps/video/videoPipeline.e2e.test.ts` — new coverage

**💡 Decisions Made**
- Made the new field optional with a fallback to the old estimate, rather than a required/breaking change — no fake/mock `TranscriptionService` implementation exists to update (the real `AssemblyAITranscriptionService` is used even in `KIE_FAKE_MODE`), but this keeps any future test or provider swap safe by default instead of silently producing `NaN`/`0` offsets if a duration is ever missing.
- Used AssemblyAI's own `audio_duration` rather than deriving an offset from the last transcribed word's `end` timestamp (also available) — `audio_duration` reflects the true full file length including any trailing silence, which the last word's end time would undercount.

---

### Session 7 (cont'd) — 2026-09-19 — Reverted scene video-clip model back to production (Kling 2.6)

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

- `KieVideoGenerator` (`adapters/kie.ts`) reverted from the 2026-09-17 TEST-CHEAP MODE swap (Hailuo 02 Standard, 512P, ~2 credits/second) back to **Kling 2.6 image-to-video** — the original production model, restored from the exact `submit()` body in git history (`worker/src/adapters/kie.ts` before the inngest-migration commit removed that file): `model: 'kling-2.6/image-to-video'`, `image_urls: [referenceImageUrl]` (plural array, not Hailuo's singular `image_url`), `sound: false`, `duration: input.durationSeconds` passed straight through — no remap needed (that `'5' -> 6` remap only existed to work around Hailuo rejecting `duration: 5`, now moot).
- Left the earlier scene-IMAGE fix (switched to `KieImageGenerator`, the uncapped endpoint) and the caption-sync fix untouched — this session's request was specifically to revert the video-clip model only.
- Reworded the class's header comment to document Kling 2.6 as production again, with the Hailuo swap's exact request shape kept in the comment (not deleted) as a ready-made recipe if cheap-mode testing is ever needed again.

**🧪 Testing**
- `kie.test.ts`'s `KieVideoGenerator` describe block — the ONE test that had been failing all session (`model=kling-2.6/image-to-video` expected, `hailuo/...` received, since that test was never updated for the 2026-09-17 swap) — now passes with no test changes needed, since the implementation matches what it always expected. All 18 tests in that file pass.
- `tsc --noEmit`, `eslint` clean. Full `vitest run` in progress at time of writing — expected to be fully clean for the first time this session (no known pre-existing failures left).

**📁 Files Changed**
- `src/server/pipeline/adapters/kie.ts` — `KieVideoGenerator.submit()` reverted to Kling 2.6; header comment reworded

**💡 Decisions Made**
- Kept the Hailuo request shape documented in the class's own comment rather than deleting it outright — it's a real, working, cheaper alternative for future testing (per the user's explicit request to revert only the video model, not lose the option).
- Did not touch `sceneVideoGenerator()` in `video.ts` — it already just instantiates `KieVideoGenerator`, so no call-site change was needed, only the class's own `submit()` body.

---

### Session 7 (cont'd) — 2026-09-19 — Closed the real gap that let a video scene render a side door

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Asked to make the prompts properly stop the truck's side from ever showing a door. `containerDescriptor` already has an explicit, emphatic rule for this ("NEVER render a door, hatch, window, vent, or any other opening... on either side... the rear double door is the vehicle's ONLY entrance and ONLY opening") — but re-reading every composer that can show the vehicle turned up the actual remaining gap: `composeSceneImagePrompt` (video's per-scene images) never spliced in `containerDescriptor` at all, unlike `composeCharacterRefPrompt`/`composeBlogImage`/`composePhotoPrompt`, which all do. It relied entirely on the character-ref image itself (the Flux Kontext edit source) to anchor the vehicle's real structure — but `REFERENCE_IS_GUIDE_NOT_COPY` in the very same prompt explicitly tells the model to build a "genuinely new scene" around the vehicle rather than copy the reference photo's own background. That's exactly the situation (reinterpreting the vehicle from a new angle/scene) where nothing in the TEXT was ever ruling a side door out.*

- Added `brand.containerDescriptor` to `composeSceneImagePrompt`'s parts, from the same single source every other vehicle-showing composer already uses — deliberately not a separate, narrower "no side doors" paraphrase, per `BACKGROUND_TRUCK_CLAUSE`'s own documented lesson that a shorthand summary is exactly what let a background truck drift off-model before.
- This was previously kept out specifically to stay under KIE's Market endpoint prompt-length cap — now moot, since `sceneImageGenerator()` was switched to the uncapped `KieImageGenerator` earlier this session. Measured the new realistic scene prompt at ~2718 chars (up from ~1220) — well within what that endpoint already handles fine for `composeCharacterRefPrompt` (~2000+ chars).

**🧪 Testing**
- New test in `compose.test.ts`: asserts `composeSceneImagePrompt`'s output contains the brand's `containerDescriptor`, matching every other vehicle-showing composer.
- `tsc --noEmit`, `eslint` clean; `compose.test.ts` (46 tests) passes. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/server/pipeline/prompts/core/compose.ts` — `composeSceneImagePrompt` now includes `brand.containerDescriptor`
- `src/server/pipeline/prompts/core/compose.test.ts` — new coverage

**💡 Decisions Made**
- Reused `containerDescriptor` verbatim rather than writing a scene-specific door-only clause — single source of truth for the vehicle's structural rules, consistent with how every other composer already handles this, and safe now that the length constraint that originally justified leaving it out no longer applies.

**⭐ Pick Up Next Session**
- No real KIE-backed video scene generation yet to visually confirm this closes the gap for real (only unit-tested at the prompt-composition level).

---

### Session 7 (cont'd) — 2026-09-19 — Fixed illogical scene settings and a front-face door gap

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Reported: generated video scenes were sometimes illogical (people sitting/eating dinner in the middle of a road) and the truck was showing a door on its FRONT face (not a side — the side-door gap was already closed earlier this session).*

- **Front-face door**: `CONTAINER_DESCRIPTOR` explicitly named "either side" and the rear by name when ruling out doors/openings, and relied on "the rear door is the vehicle's ONLY entrance and ONLY opening" to implicitly cover the front too. The side-door bug already proved an implied "nowhere else" isn't reliable — the model needs every real face named explicitly. Added an explicit sentence describing the container's front face (where it mounts onto the cab) as a plain, solid maroon-red wall with nothing on it, and reworded the NEVER-render sentence to name the front face by name alongside "either side."
- **Illogical scene settings**: root cause was at the SCRIPT-planning level, not image generation — `composeVideoScriptSystemPrompt` had constraints on tone, brand accuracy, and not reading like an ad, but nothing requiring a scene's setting to be physically/socially plausible. Added an explicit constraint: every scene's setting must be an ordinary, safe, real-world place the action could actually happen (sidewalk, porch, kitchen table, park, community space, etc.) — never an implausible/unsafe arrangement like people gathered or eating in the middle of an active road — unless the user's own scene idea explicitly calls for that exact setup.
- Added the same plausibility constraint as a second line of defense in `composeSceneImagePrompt` (new `PHYSICALLY_PLAUSIBLE_SCENE` constant) — same layered-constraint pattern `FOOD_MUST_LOOK_CLEAN` already uses, in case a scene's `visual_description` is ever ambiguous enough to admit an implausible reading even after the script-level fix.

**🧪 Testing**
- `compose.test.ts`: new tests for the front-face door rule (`BRAND_PROFILE.containerDescriptor` describe block) and the plausibility constraint in `composeSceneImagePrompt`.
- `composeText.test.ts`: new test for the plausibility constraint in `composeVideoScriptSystemPrompt`.
- `tsc --noEmit`, `eslint` clean; targeted prompt test suites (84 tests) pass. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/server/pipeline/prompts/brand/fresh-can.ts` — `CONTAINER_DESCRIPTOR` now names the front face explicitly
- `src/server/pipeline/prompts/core/composeText.ts` — `composeVideoScriptSystemPrompt` gains the plausibility constraint
- `src/server/pipeline/prompts/core/compose.ts` — new `PHYSICALLY_PLAUSIBLE_SCENE` constant, added to `composeSceneImagePrompt`
- `src/server/pipeline/prompts/core/compose.test.ts`, `composeText.test.ts` — new coverage

**💡 Decisions Made**
- Fixed the illogical-scene problem primarily at the SCRIPT level (where scenes are first invented), not just at the image level — the image composer only ever renders what `visual_description` already says, so catching this earlier stops it before an illogical scene idea is even locked in, rather than just hoping the image render softens it.
- Scoped the plausibility constraint to video only (script + scene image) for now, not blog/photo — the report was specifically about video, and blog/photo don't have an intermediate script-planning step that could independently invent a setting the way video's scene plan does.

**⭐ Pick Up Next Session**
- No real KIE-backed video run yet to confirm either fix live — both are unit-tested at the prompt-composition level only.

---

### Session 7 (cont'd) — 2026-09-19 — Restored the fuller prompt wording now that scene images aren't length-capped

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Earlier this session, `moodClause`, `SCENE_IS_CREATIVE_BRIEF`, `REFERENCE_IS_GUIDE_NOT_COPY`, `FOOD_MUST_LOOK_CLEAN` (`compose.ts`) and `noTextInstruction`/`noNewTextInstruction` (`fresh-can.ts`) were all compressed down to fit `composeSceneImagePrompt` under KIE's Market endpoint's prompt-length cap. That cap stopped applying once `sceneImageGenerator()` was switched to the uncapped `KieImageGenerator` — asked to remove the compression now that the model can handle (and benefits from) the extra descriptive detail for production-quality output.*

- Restored all five constants to their original, fuller wording — same rules, same anchor phrases, just the more explicit/descriptive phrasing that was trimmed purely for length (e.g. `noTextInstruction`'s explicit "no words, no letters, no captions, no titles..." enumeration instead of the collapsed "text, logos, watermarks, or typography"; `SCENE_IS_CREATIVE_BRIEF`/`REFERENCE_IS_GUIDE_NOT_COPY`/`FOOD_MUST_LOOK_CLEAN` back to their original, more descriptive sentences).
- Nothing substantive changed — no rule added or dropped, only wording. All the REAL fixes made later in the session on top of the tightened versions (the front-face door rule, the physical-plausibility constraint, `composeSceneImagePrompt` gaining `containerDescriptor`) are untouched and still in place.
- Updated each constant's own comment to reflect that the cap no longer applies, rather than leaving a stale "tightened to fit the cap" note now that the wording is back to full.
- Measured the resulting realistic scene prompt at ~3702 chars (up from the ~1220-2718 char range while compression was in effect) — no issue, since `composeCharacterRefPrompt` already runs comparably long (~2000+ chars) on the same now-shared uncapped endpoint.

**🧪 Testing**
- Updated the one test assertion that depended on the compressed wording (`composePhotoPrompt`'s style/mood/composition check, now matching the restored full phrase) — every other existing anchor-phrase assertion still passes unchanged.
- `tsc --noEmit`, `eslint` clean; `compose.test.ts`/`composeText.test.ts` (84 tests) pass. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/server/pipeline/prompts/core/compose.ts` — restored `moodClause`, `SCENE_IS_CREATIVE_BRIEF`, `REFERENCE_IS_GUIDE_NOT_COPY`, `FOOD_MUST_LOOK_CLEAN` to their fuller wording
- `src/server/pipeline/prompts/brand/fresh-can.ts` — restored `noTextInstruction`, `noNewTextInstruction` to their fuller wording
- `src/server/pipeline/prompts/core/compose.test.ts` — updated the one affected assertion

**💡 Decisions Made**
- Restored wording only, left every substantive rule/fix from later in the session untouched — this was purely undoing the earlier length-driven compression, not a broader revert.
- If illogical settings or off-face doors recur, worth checking whether they're happening on OLD jobs/generations created before this fix (which reused an earlier script/scene plan) rather than a fresh regeneration.

---

### Session 7 (cont'd) — 2026-09-19 — KieImageGenerator has a real cap too (3000 chars) — re-tightened after a real failure

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*The immediately preceding fix restored `composeSceneImagePrompt`'s constituent prose to fuller wording on the assumption that `KieImageGenerator` (the dedicated Flux Kontext endpoint scene images were switched to earlier) had no prompt-length cap at all. Wrong — a real "improved prompt test" job failed on EVERY scene with a new, different error: `"kie call failed (status 200): The prompt word cannot exceed 3000 characters"`. Pulled the real job/scenes from Supabase directly: even the SHORTEST real scene (82 chars of `visual_description`) failed, because `composeSceneImagePrompt`'s FIXED overhead alone — before any scene content — measured at ~3490 chars. `containerDescriptor` (grown to 1708 chars after the front-face-door fix) was the single biggest piece and had never been touched by any previous length fix.*

- Re-tightened `moodClause`'s FOOD_MUST_LOOK_CLEAN/SCENE_IS_CREATIVE_BRIEF/REFERENCE_IS_GUIDE_NOT_COPY/`noNewTextInstruction` back down (same versions as the earlier Market-endpoint fix) — same rules, fewer words.
- **Trimmed `containerDescriptor` itself for the first time** (previous length fixes always worked around it, never into it) — two passes, 1708 → 1491 → 1180 chars, tightening connecting prose while keeping every enumerated specific (the side's no-graphics/decals/stripes/URLs/vents list, the front's no-door/window/vent/wordmark list) and both sentences `compose.test.ts` asserts on (the NEVER-render sentence, the ONLY-entrance sentence) 100% verbatim. Cut two genuinely lower-value sentences instead: a "wordmark is the vehicle's only text" restatement redundant with the side/front rules already saying so, and shortened the closing "logo can't appear elsewhere in the scene" sentence's object list.
- Left `noTextInstruction` (fresh-can.ts) at its fuller wording — confirmed it's never actually read by `composeSceneImagePrompt` (scene images always have a reference image, so `noNewTextInstruction` is used instead), so it was never part of this problem.
- Measured before/after against the REAL job's scene data: fixed overhead 3490 → 2485; the real scenes that failed (82-172 chars of content) now compose to ~2695-2696 chars, comfortably under the confirmed 3000-char limit.

**🧪 Testing**
- Re-verified every existing anchor-phrase assertion in `compose.test.ts` still passes with the re-tightened wording (no test changes needed this time — the tightened phrasing happened to already match what tests expected from the prior Market-endpoint fix).
- `tsc --noEmit`, `eslint` clean; `compose.test.ts`/`composeText.test.ts` (84 tests) pass. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/server/pipeline/prompts/core/compose.ts` — re-tightened `SCENE_IS_CREATIVE_BRIEF`, `REFERENCE_IS_GUIDE_NOT_COPY`, `FOOD_MUST_LOOK_CLEAN`, `PHYSICALLY_PLAUSIBLE_SCENE`
- `src/server/pipeline/prompts/brand/fresh-can.ts` — `CONTAINER_DESCRIPTOR` trimmed (two passes), `noNewTextInstruction` re-tightened, `noTextInstruction`'s stale comment corrected

**💡 Decisions Made**
- Confirmed the real cap this time (3000 chars, from the literal error text) instead of estimating — this is why the fix could be sized precisely (target fixed overhead comfortably under 3000 minus realistic scene content) instead of guessing again.
- Trimmed connecting prose and genuinely redundant sentences in `containerDescriptor`, never an enumerated specific — the enumerated lists are what make the door/logo rules actually reliable (per this file's own established lesson), so those were the last thing to touch, not the first.

**⭐ Pick Up Next Session**
- A stress-test with a deliberately long `visualDescription` + `shotNotes` + `regenInstructions` (simulating an elaborate scene or a long user regen request) still composes to ~3075 chars — over the limit. All REAL observed scene data fits safely (~2695-2696), so this is a residual risk for an unusually long scene or regen instruction, not something currently happening — but it's the same class of risk flagged after the very first length fix earlier this session. A defensive guardrail (fail fast locally, or truncate the least-essential part — likely `regenInstructions` first) would close this for good; still not implemented, now flagged for the third time this session.

---

### Session 7 (cont'd) — 2026-09-19 — Fixed a real burned-in-caption corruption bug (drawtext escaping)

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Reported: a real generated video showed literal ffmpeg filter syntax burned into the frame as visible text — `:fontcolor=white:fontsize=h*0.033:x=(w-text_w)/2:y=h-h*0.083:box=1:boxcolor=black@0.5:boxborderw=10:enable=between(t,25.26,27.50)` — instead of a styled caption. Traced to `avMerger.ts`'s `escapeDrawtextValue`, which this session's own earlier caption-sync fix had already flagged with a "NOT independently verified against a real render yet" comment — now confirmed broken for real.*

- The single-quote escape had an extra backslash: `'\\''` (two backslashes) instead of ffmpeg's actual documented close-escape-reopen sequence `'\''` (one backslash — the same trick POSIX shells use to embed an apostrophe inside a single-quoted string). With the extra backslash, any narration containing a real apostrophe (e.g. "Fresh-CAN's", "farmer's") never properly closed and reopened the `text='...'` quote — ffmpeg kept parsing everything after as literal quoted text, including that drawtext filter's OWN remaining options (fontcolor, fontsize, x, y, box, enable), which is exactly what showed up burned into the frame instead of being applied.
- Fixed the replacement to the correct single-backslash sequence.

**🧪 Testing**
- Updated the one existing test that had been asserting the buggy double-backslash output (it was checking "whatever the code currently does," not real ffmpeg-correct escaping — exactly the gap the "not independently verified" comment flagged).
- `tsc --noEmit`, `eslint` clean; `avMerger.test.ts` (41 tests) passes. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/server/pipeline/adapters/avMerger.ts` — `escapeDrawtextValue`'s single-quote escape fixed
- `src/server/pipeline/adapters/avMerger.test.ts` — updated the one affected assertion

**💡 Decisions Made**
- Fixed only the confirmed bug (the quote-escape sequence) rather than also touching the backslash/colon escaping in the same function — no evidence either of those is wrong, and the visible corruption is fully explained by the quote bug alone; changing more than what's confirmed broken risks introducing a new, unverified regression in an area that's already proven fragile.

**⭐ Pick Up Next Session**
- No fresh real render yet with narration containing an apostrophe to visually confirm the fix — only unit-tested at the escaping-function level.
- The backslash/colon escaping in the same function is still flagged as unverified against a real render (per the function's original comment) — revisit if a caption with a colon or literal backslash in the narration text ever shows a similar corruption.
- Re-run the real "improved prompt test" job (or a fresh one) to confirm scene images now succeed for real.

---

### Session 7 (cont'd) — 2026-09-19 — Social posting: closed the "no retry" gap, guarded the blog dead end

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Ran a broader audit (fork) of missing/incomplete features across all pipelines and social posting, then asked to tackle social posting specifically. Two real, confirmed gaps there (the "only 3 platforms" and the three unverified `socialPublisher.ts` assumptions were left alone — expanding platforms is a bigger feature ask, and verifying provider assumptions needs a real live post to real connected accounts, which wasn't done without asking first):*

- **No retry path for a failed social post.** Traced precisely: the UI already re-shows the editable approval form and "Approve & Post" button for a `'failed'` post (`isPosted` is only true for `'posted'`), and clicking it already flips `social_posts.status` back to `'approved'` via the existing upsert — but `db.ts`'s `getApprovedSocialPostsAwaitingSubmission` infers "not yet submitted" purely from the ABSENCE of any `social_platform_logs` row, and the failed attempt's old rows never went away. So re-approving a failed post was a silent, permanent no-op — nothing this app has ever done resubmits it. Fixed by having `contentService.ts`'s `upsertSocialPost` read the row's status BEFORE the upsert, and delete its old `social_platform_logs` rows when (and only when) that previous status was `'failed'` — safe because `rollupSocialPostStatus` only ever sets `'failed'` when EVERY platform failed, so there's never a successfully-posted platform's log row to lose. Also changed the button label to "Retry Post" (from "Approve & Post") and added a short explanatory banner when retrying, so the UI actually communicates what's happening instead of looking identical to a first-time approval.
- **Blog posts could be selected and "approved" for social posting, but always failed deep in the pipeline** — blog never writes a `generated_content` row (no image or video), and `socialPublisher.ts`'s `publish()` has no concept of a text/link-only post; `submitOnePost` always threw "nothing to post" for `content_type='blog'`. Rather than build actual blog social support (a real feature decision — attach the blog's hero image? support a link-only post where the platform allows one?), guarded `SocialApprovalCard` to show a clear "not supported yet, share the link manually" message for blog instead of the live-but-broken approval form.

**🧪 Testing**
- No test infrastructure exists for `contentService.ts` (client-side, browser Supabase client) or React components in this repo — instead of inventing a new mocked-unit-test pattern for one function, verified the exact fetch→upsert→conditional-delete sequence against the REAL database directly: seeded a real `content_jobs`/`social_posts`(`status='failed'`)/`social_platform_logs` row set, ran the identical sequence `upsertSocialPost` now performs, confirmed the post flips to `'approved'` and its platform-log rows are gone (0 remaining) with the same row id preserved, then cleaned up every seeded row.
- `tsc --noEmit` clean. `eslint` flagged two PRE-EXISTING issues in the touched files (an effect-body `setState` lint rule on code I never touched, and an unused `resolveHashtags` export) — confirmed via diff that neither is on a line this session changed; left alone as out of scope. Full `vitest run` in progress at time of writing (this fix has no server-side test surface to affect).

**📁 Files Changed**
- `src/services/contentService.ts` — `upsertSocialPost` clears stale failed-post logs on retry
- `src/components/SocialApprovalCard.tsx` — retry button label/banner; blog-unsupported guard
- `TASKS.md` — marked the stuck-posting/retry item done; added a new backlog item for real blog social support
- `PROGRESS.md` — this entry

**💡 Decisions Made**
- Reused the EXISTING re-approve UI flow for retry instead of adding a new button/endpoint — the button was already there and already almost worked; the actual bug was one missing cleanup step in the data layer, not a missing UI affordance.
- Guarded blog rather than building real social support for it — attaching an image or doing a link-only post is a genuine product decision (which image? do all target platforms even support link-only posts?), not something to guess at silently.
- Left the "only 3 platforms" and the three unverified `socialPublisher.ts` provider assumptions alone — the former is a real feature addition, the latter can only be verified by actually posting to real connected social accounts, which needs the user's own sign-off, not something to do unprompted.

**⭐ Pick Up Next Session**
- No real end-to-end UI click-through yet of the retry flow (verified at the data layer only) — worth clicking "Retry Post" on a real failed post once one exists.
- If blog social posting is ever wanted for real, the open design question is what media (if any) to attach — the blog's hero image is the most obvious candidate since it already exists as a real file.

---

### Session 7 (cont'd) — 2026-09-19 — Implemented the missing render-time video/audio reconciliation; made video prompts more cinematic

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Reported: audio and captions out of sync in generated videos. Investigated a real, already-rendered job ("improved prompt test," 7 scenes) directly in Supabase rather than guessing: total VIDEO length (35s — every scene a fixed, quantized 5s Kling clip) drifted 7.4s short of total AUDIO length (42.4s, the real per-scene ElevenLabs narration). The final mux pass's `-shortest` was silently truncating the last ~7.4s of narration and captions instead of anything ever reconciling scene-by-scene. This is the "render-time reconciliation" `ARCHITECTURE.MD` §4.2 always described (hold the last frame if audio runs long, trim if it runs short) but that was never actually implemented — confirmed by reading `renderLanguageTrack.ts` end to end. The earlier caption-offset fix (using AssemblyAI's real duration instead of the word-count estimate) was necessary but not sufficient — it fixed captions-vs-audio, not video-vs-audio, which is what was actually driving the reported symptom.*

- **Implemented the reconciliation for real.** New `avMerger.ts` function `buildSceneDurationMatchCommand(clipUrl, currentDurationSeconds, targetDurationSeconds)`: holds the last frame (`tpad=stop_mode=clone:stop_duration=<shortfall>`) if the clip is shorter than the target, then always hard-trims to the exact target with `-t` — one command handles both "too short" and "too long" with no branching. `currentDurationSeconds` is never probed (no way to query a file's real duration via upload-post.com's API) — Kling/Hailuo reliably render at exactly the duration requested, so it's recomputed deterministically via the same `pickClipDurationSeconds` function `generateSceneVisual.ts` used to request the clip (pulled out to a new shared `lib/sceneClipDuration.ts`, same "two call sites must never drift" reasoning `ASPECT_RATIO_RESOLUTIONS` was extracted for).
- **`renderLanguageTrack.ts`** now runs this as a new Pass 0, per scene, in parallel, BEFORE video-concat — producing per-TRACK temp clip URLs (never mutating the shared `content_visual_assets` row, since the match amount is language-specific: EN/FR narration lengths differ for the same scene).
- **`transcribeAudio.ts`** now persists AssemblyAI's real measured duration back into `video_scene_audio.duration_ms` (overwriting `synthesizeVoice.ts`'s word-count estimate) as it transcribes each scene — this is what gives the new render-time pass a real number to reconcile against, instead of quietly re-reading the same stale estimate the caption-offset fix already stopped trusting.
- **Made the prompts more cinematic** (separate ask, same session): `composeVideoScriptSystemPrompt`'s `shot_notes` field now asks for real camera direction (angle, movement, depth of field) rather than defaulting to `""`, plus a new instruction to vary shot types scene-to-scene (wide/medium/close-up/over-the-shoulder/tracking) — framed as a production-quality bar, explicitly never a style directive (style stays the scene idea's call, per `SCENE_IS_CREATIVE_BRIEF`'s existing rule). `composeSceneVideoPrompt` reworded from "Subtle, natural, observational motion" (which was in tension with the new shot-variety ask) to explicitly welcome real cinematographic technique (pans, tilts, tracking, dolly, rack focus), keeping only the one rule that actually matters — no jump cuts, no staged product-hero orbit/push-in. New `composeSceneImagePrompt` constant `CINEMATIC_QUALITY` — a production-value quality floor (framing, depth of field, lighting craft), explicitly not a style dictate, same pattern `FOOD_MUST_LOOK_CLEAN` already uses.
- Re-tightened `moodClause` and worded `CINEMATIC_QUALITY` tightly from the start — adding a new ~200-char constant on top of an already-near-3000-char `composeSceneImagePrompt` needed the room made back elsewhere; measured the realistic worst case at ~2854 chars (146 chars of margin under the confirmed cap), down from a ~2907 first draft.

**🧪 Testing**
- `avMerger.test.ts`: new tests for `buildSceneDurationMatchCommand` (shortfall-only padding, `-t` trim in both directions, no semicolon) and `UploadPostAVMerger.submitSceneDurationMatch`.
- `videoPipeline.e2e.test.ts`: added the new method to the mocked `AVMerger`; re-ran the M4 render tests against the real DB with the new Pass 0 wired in — both pass.
- `compose.test.ts`/`composeText.test.ts`: new coverage for `CINEMATIC_QUALITY`, the reworded motion prompt, and the script's shot-variety instruction.
- `tsc --noEmit`, `eslint` clean. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/server/pipeline/lib/sceneClipDuration.ts` (new) — `pickClipDurationSeconds`, shared between `generateSceneVisual.ts` and `renderLanguageTrack.ts`
- `src/server/pipeline/adapters/avMerger.ts` — `buildSceneDurationMatchCommand` + `submitSceneDurationMatch`
- `src/server/pipeline/adapters/types.ts` — `AVMerger.submitSceneDurationMatch`
- `src/server/pipeline/steps/video/generateSceneVisual.ts` — imports the shared `pickClipDurationSeconds` instead of a local copy
- `src/server/pipeline/steps/video/transcribeAudio.ts` — persists the real measured audio duration
- `src/server/pipeline/steps/video/renderLanguageTrack.ts` — new Pass 0 (per-scene duration match) before video-concat
- `src/server/pipeline/prompts/core/compose.ts` — `CINEMATIC_QUALITY`, reworded `composeSceneVideoPrompt`, re-tightened `moodClause`
- `src/server/pipeline/prompts/core/composeText.ts` — cinematic shot-variety instruction in `composeVideoScriptSystemPrompt`
- Test files: `avMerger.test.ts`, `videoPipeline.e2e.test.ts`, `compose.test.ts`, `composeText.test.ts`

**💡 Decisions Made**
- Padded/trimmed a PER-TRACK temp copy of the shared clip rather than ever touching `content_visual_assets` itself — the shared visual asset must stay language-neutral (the entire point of the M1-M4 redesign this app already went through), so the language-specific reconciliation has to happen downstream of it, at render time, not by mutating the shared row.
- Computed the clip's "current" duration deterministically instead of probing the file — there's no confirmed way to query a file's real duration through upload-post.com's API, and Kling/Hailuo's own duration guarantee makes probing unnecessary anyway.
- Kept `composeSceneVideoPrompt`'s one real safety rule (no product-hero orbit/push-in) while dropping "subtle" — cinematic ≠ ad-like; a documentary-style film can still have deliberate, dynamic camera movement without ever looking like a commercial.

**⭐ Pick Up Next Session**
- No real KIE/upload-post.com-backed render yet to visually confirm the reconciliation pass actually closes the drift end to end, or to see the more cinematic shot variety in a real output — both are unit/integration-tested at the code level only.
- The new Pass 0 adds N (scene count) more FFmpeg submit+poll+upload round trips per track render — cheap and fast individually (single-file operations, run in parallel), but worth watching real render timing against the existing ~9min-per-pass processing ceiling this pipeline already tracks closely.
- Margin under KieImageGenerator's 3000-char cap is real but not huge (~146 chars in the worst case measured) — if a future addition needs more room, `containerDescriptor` (still the single biggest piece at ~1180 chars) is the next lever, not further squeezing the newer quality-floor constants.

---

### Session 7 (cont'd) — 2026-09-19 — Fixed the French voice picker offering English voices

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Reported: the FR voice options in the dashboard's video-creation form are English voices. Confirmed in `src/lib/videoVoices.ts`: `VIDEO_VOICES.FR` reused the exact same 7 voice IDs as `VIDEO_VOICES.EN` (Liam, Chris, Daniel, Sarah, Jessica, Alice, Bella — all `language: 'en'` in ElevenLabs' own account library) for every slot except the one real default. The file's own comment already explained why: the connected ElevenLabs account's `/v1/voices` library has only ONE genuine French voice total.*

- Queried ElevenLabs' shared voice library directly (`GET /v1/shared-voices?language=fr`, filtered further by `gender` and `accent=quebec`) to find real candidates, rather than guessing or fabricating IDs. Confirmed live that a shared-library `voice_id` works directly against `/v1/text-to-speech` with no "add to my voices" step first (ran one real male and one real female synthesis call, both succeeded) — so fixing this needed no ElevenLabs account changes at all, just a data update.
- Replaced 7 of the 8 `VIDEO_VOICES.FR` entries with genuine `language: 'fr'` voices (kept the one real existing default, `n2pCwUKS6q9Iur03Rten`, unchanged so an unedited job's narration voice doesn't shift). Final list: 4 male (Christian Page [existing default], Marc André, Pascal, Jean-François) + 4 female (Caroline, Claudia, Amélie, Jeanne Mance) — all real, distinct, French-labeled ElevenLabs voices, zero overlap with the EN list (previously 7 of 8 IDs were shared).
- Prioritized `accent: 'quebec'` candidates over standard/Parisian French where a good one existed, to match Fresh-CAN's own Canadian setting and the existing default voice (itself Quebec French).

**🧪 Testing**
- Verified directly against the real ElevenLabs API rather than trusting the shared-voices listing alone: two live TTS calls (one male, one female candidate) both returned real audio successfully with no prior "add" step.
- Confirmed programmatically: 8 total FR entries, 8 unique IDs, exactly 4 male / 4 female, zero ID overlap with the EN list.
- `tsc --noEmit`, `eslint` clean (plain data file, no existing test suite covers it). Grepped the whole `src/` tree for the 7 old fake FR IDs — no other references anywhere. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/lib/videoVoices.ts` — `VIDEO_VOICES.FR` replaced with 8 genuine French voices; header comment updated to explain the real fix

**💡 Decisions Made**
- Verified live against the real ElevenLabs API before finalizing any voice ID — fabricating or guessing IDs here would be worse than the original bug (a silently broken voice picker instead of a mislabeled one).
- Left `VIDEO_VOICES.EN` and `DEFAULT_VOICE_ID`/`BRAND_PROFILE.videoVoiceIds` untouched — this was specifically about the FR list's own voices being wrong, not the defaults or the EN side, which were never in question.

**⭐ Pick Up Next Session**
- No real end-to-end video job yet using one of the 3 newly-added FR voices (only the existing default has ever been used in production) — worth generating one real FR video with a non-default voice selected to confirm end to end.

---

### Session 7 (cont'd) — 2026-09-19 — Fixed a real upload-post.com 429 rate-limit failure on render

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Reported: a real "video test both" job (8 scenes, BOTH languages) failed both EN and FR tracks at the render step with `upload-post call failed (status 429)`. Pulled the exact error from Supabase rather than guessing — the provider's own error body gave everything needed: `{"mode":"enforce","retry_after_seconds":60,"violations":[{"window":"per_min","window_seconds":60,"count":63,"limit":62,...}]}`, and the first failure's detail named exactly which pass tripped it: "(duration-match pass, 11.5s elapsed, poll #2)".*

- **Root cause #1 — no rate limiter on upload-post.com calls at all.** Unlike KIE.ai (already throttled via `kieSubmitLimiter`, a documented 15-req/10s limiter), every `avMerger.ts` pass (scale, video-concat, audio-concat, mux, caption, and the render-reconciliation "duration-match" pass added earlier this session) submitted immediately with zero throttling. The duration-match pass's own `Promise.all` — up to 8 scenes × 2 language tracks = 16 simultaneous calls for this exact job — combined with the render step's other already-unthrottled calls on the same job, is what pushed the account from 62 to 63 requests in one 60s window.
- **Root cause #2 — retry backoff didn't respect the provider's own 60s cooldown hint.** `MAX_ATTEMPTS.upload_post = 3` with `backoffBaseDelayMs = 5000` exhausted all 3 attempts in ~21s total (confirmed from the real timestamps: attempts 1/2/3 at 10:50:55 / 10:51:03 / 10:51:16) — every retry hit the *same still-active* rate-limit window and failed immediately again, permanently failing the track long before the real 60s cooldown ever elapsed.
- **Fix #1**: extracted the existing `SlidingWindowRateLimiter` class (previously private to `kieRateLimiter.ts`) into a shared `lib/rateLimiter.ts`, and added a new `uploadPostSubmitLimiter` (45 requests/60s — comfortably under the confirmed 62/60s limit) gated once inside `UploadPostAVMerger.submitCommand()`, the single choke point every pass already goes through. No change needed to the duration-match pass's own `Promise.all` — once every call funnels through the shared limiter, the burst self-serializes automatically.
- **Fix #2**: bumped `MAX_ATTEMPTS.upload_post` 3 → 4 and `renderLanguageTrack.ts`'s call site `backoffBaseDelayMs` 5000 → 20000ms, producing a 20s/40s/60s required-wait schedule before attempts 2/3/4 — clearing a real 60s cooldown by the last attempt instead of giving up three times faster than the provider asked for. Also bumped the shared `MAX_RETRY_LOOP_ITERATIONS` (video.ts) 30 → 40 so the outer Inngest polling loop has enough headroom to actually reach that 4th attempt.

**🧪 Testing**
- New `rateLimiter.test.ts`: allows up to `max` immediately, blocks and waits for the (max+1)th until the window clears (via fake timers), and confirms two provider instances track independently.
- `backoff.test.ts`: new tests confirming `upload_post` now allows a 4th attempt, and that the 20000ms `backoffBaseDelayMs` schedule requires exactly 60s before the 4th attempt — matching the provider's own `retry_after_seconds` hint.
- `avMerger.test.ts`'s existing 47 tests still pass unchanged with the rate limiter wired in (its cap is far above what a test run's handful of calls ever needs, so no test timing changed).
- `tsc --noEmit`, `eslint` clean. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/server/pipeline/lib/rateLimiter.ts` (new) — extracted `SlidingWindowRateLimiter`
- `src/server/pipeline/lib/kieRateLimiter.ts` — imports the shared class instead of defining its own copy
- `src/server/pipeline/lib/uploadPostRateLimiter.ts` (new) — `uploadPostSubmitLimiter`
- `src/server/pipeline/adapters/avMerger.ts` — `submitCommand` now acquires the limiter before every request
- `src/server/pipeline/lib/backoff.ts` — `MAX_ATTEMPTS.upload_post` 3 → 4
- `src/inngest/functions/video.ts` — render's `backoffBaseDelayMs` 5000 → 20000; `MAX_RETRY_LOOP_ITERATIONS` 30 → 40
- `src/server/pipeline/lib/rateLimiter.test.ts` (new), `backoff.test.ts` — new coverage

**💡 Decisions Made**
- Gated the rate limiter once inside `submitCommand` rather than at each call site (scale/duration-match/concat/mux/caption) — one change point, impossible for a future new pass to forget to throttle itself.
- Capped at 45/60s, not the full confirmed 62/60s — real margin for jitter, the render step's own multi-call-per-track bursts, and any other traffic (e.g. social posting) sharing this same upload-post.com account.
- Bumped the shared `MAX_RETRY_LOOP_ITERATIONS` rather than adding a render-specific constant — the render retry schedule needed more outer-loop headroom, and a shared bump is harmless for this file's other retry loops, which already finish comfortably inside the old ceiling.

**⭐ Pick Up Next Session**
- No fresh real render yet to confirm the rate limiter actually prevents a repeat 429 on a real multi-scene BOTH-language job — verified at the unit/integration level only.
- 45/60s was chosen as a safety margin under the confirmed 62/60s, not re-measured against a live burst — worth revisiting if a 429 still recurs (tighten further) or if renders feel newly slow because of throttling (loosen toward 62, still leaving some margin).

---

### Session 7 (cont'd) — 2026-09-19 — Fixed 4 real video-prompt defects behind "the videos generated are hideous"

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Reported: generated videos look "hideous." Rather than guess, downloaded and visually inspected the real character-ref image and all 6 real scene frames from a completed job ("both test", pipeline `e0ff783a-b52c-4e1a-a3fc-89fbfe5aafc9`). Found 4 concrete defects, all fixed:*

- **Fix #1 (highest priority) — the truck was forced into scenes that were never about it.** `composeSceneImagePrompt` used to ALWAYS attach the character-ref truck photo as the Flux Kontext edit source and ALWAYS inject the full `containerDescriptor`, for every scene, regardless of whether that scene's own `visual_description` had anything to do with the truck — a real scene of a family in their own kitchen came back with the truck/branded fridge hallucinated into it. Added a per-scene relevance gate reusing the SAME `isContainerRelevant` heuristic composeBlogImage/composePhotoPrompt already use (`defaultRelevant: false`, since most of a video's scenes — home life, cooking, eating — are not about the truck). A non-relevant scene now gets NO reference image at all (pure text-to-image) plus an explicit "this scene does not involve the Fresh-CAN truck" instruction, instead of `containerDescriptor`. Also fixed `generateSceneVisual.ts`'s `runSceneImageStep`, which was hardcoding `referenceImageUrl: characterRefUrl` at the `imageGenerator.submit()` call site instead of using the composition's own returned `referenceImageUrl` — without this the gate above would have had no effect on the actual API call.
- **Fix #2 — the side-door/hatch rule was still being violated for a customer-facing scene.** A real scene (family approaching to shop) rendered an open service hatch on the side, despite `containerDescriptor`'s existing generic "never a door/hatch/window/vent on either side" rule. Named the exact failure mode directly in `CONTAINER_DESCRIPTOR`: "customer service window" is now in the enumerated forbidden-opening list, and a new closing clause states the rear double door is "the only place customers are ever served."
- **Fix #3 — the character-ref image itself had a duplicate, garbled decal.** The shared character-ref image (which every scene edits from) showed a garbled second "Fresh-CAN"-like decal over an unexplained red blob graphic. Root cause, from `fresh-can.ts`'s own documented reference-photo notes: the 'arrival'/'standing' exterior photos are known to show a real decorative red graphic + "fresh-can.com" text that the prompt tells the model to disregard — and `composeCharacterRefPrompt` was rotating across all 3 exterior photos per-pipeline via `pickReferenceFrom`, meaning some pipelines' character-ref generation started from one of these contaminated photos, and the text instruction to ignore it lost to edit-mode's own bias toward reproducing its input. Fixed by always using the FIRST exterior photo (the clean rear/dead-on shot, no documented contamination) for character-ref specifically — cross-pipeline visual variety doesn't matter for this ONE locked internal reference the way it does for blog/photo images, so there's no downside to fixing it deterministically. Also added a new `ONE_WORDMARK_ONLY` instruction as a second line of defense.
- **Fix #4 — unscripted extra people appeared in interior/rear-door scenes.** A scene showed an unscripted person already inside the unit restocking shelves, with nothing in the scene's own `visual_description` calling for them. Added a new `NO_UNSCRIPTED_PEOPLE` instruction to every video scene image (relevant or not) telling the model not to add cast beyond who the scene explicitly describes.

**🧪 Testing**
- New `compose.test.ts` coverage: non-relevant scene gets no reference image / no `containerDescriptor` / the new "no truck" instruction instead; a relevant scene (arriving/scanning/browsing inside, without literally saying "truck") still shows it; `NO_UNSCRIPTED_PEOPLE` present in both branches; `composeCharacterRefPrompt` always picks the first exterior photo regardless of `pipelineId`; the new wordmark-count and customer-service-window assertions.
- Verified the real prompt length stays under KieImageGenerator's confirmed ~3000-char cap for all 3 real relevant scenes from the actual job that prompted this (max 2935 chars) — trimmed `PHYSICALLY_PLAUSIBLE_SCENE`/`CINEMATIC_QUALITY`'s connecting prose (same anchors kept, same rule) and kept the new additions terse to buy back the headroom the Fix #2/#4 additions spent.
- `compose.test.ts`: 56/56 passing. `tsc --noEmit`, `eslint` clean on all touched files. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/server/pipeline/prompts/core/compose.ts` — `composeSceneImagePrompt`'s new relevance gate; `composeCharacterRefPrompt` now uses `referenceImages.exterior[0]` deterministically; new `NO_UNSCRIPTED_PEOPLE`/`NO_SUBJECT_IN_SCENE`/`ONE_WORDMARK_ONLY` constants; trimmed `PHYSICALLY_PLAUSIBLE_SCENE`/`CINEMATIC_QUALITY`
- `src/server/pipeline/prompts/brand/fresh-can.ts` — `CONTAINER_DESCRIPTOR` now explicitly names a "customer service window" as forbidden and states the rear door is the only place customers are served
- `src/server/pipeline/steps/video/generateSceneVisual.ts` — `runSceneImageStep` now destructures `referenceImageUrl` from `composeSceneImagePrompt`'s return instead of hardcoding `characterRefUrl` at the `submit()` call site
- `src/server/pipeline/prompts/core/compose.test.ts` — new coverage for all 4 fixes

**💡 Decisions Made**
- Diagnosed by downloading and actually looking at real generated frames, not guessing from the prompt code alone — this is what surfaced the character-ref decal and the customer-facing hatch as real, specific defects rather than generic "prompt engineering" guesses.
- Scoped Fix #1 to a binary relevant/not-relevant gate, not a 3-way exterior/interior split (which would need a whole second locked interior reference image, mirroring blog's `referenceImages.interior` — a bigger feature). The binary gate directly fixes the worst, most jarring defect (truck forced into purely domestic scenes); interior-vs-exterior visual fidelity for "browsing inside the unit" scenes is left as a documented possible follow-up, not part of this fix.
- Fixed Fix #3 by always picking the first (cleanest) exterior reference photo for character-ref specifically, rather than adding a new `cleanForCharacterRef` field to `BrandReferenceImage` — the type already documents which real photos have known contamination in comments; a one-line change reusing that existing knowledge was enough, no schema change needed.

**⭐ Pick Up Next Session**
- No fresh real generation yet to visually confirm these 4 fixes actually land — verified at the prompt-composition/unit-test level only. Next real video job run is what will confirm it.
- Separately noted, not yet investigated: `generated_content` has zero rows for the "both test" job despite its render actually succeeding and real files existing in Storage (`freshcan-videos/.../EN.mp4`, `.../FR.mp4`).

---

### Session 7 (cont'd) — 2026-09-19 — Tightened Fix #1's relevance gate: reused blog/photo's heuristic false-positived on ordinary video narrative

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*User feedback on the fix above: "the scenes wont just be home kitchen and dining. it can be something creative as well like a mother son walking on the road etc. it shouldnt hallucinate and add illogical scenes to something simple." Correct, and a real gap — Fix #1's gate reused `isContainerRelevant`, built for blog/photo's short TOPIC/CATEGORY strings, where a generic action verb (`arrive`, `enter`, `door`, `visit`, `pick up`, `shop`, `scan`) plausibly implies a visit/access moment. `composeVideoScriptSystemPrompt` explicitly allows any scene to be built around the job's own free-form creative idea ("never a reason to force the vehicle into a scene it does not genuinely fit") — so a video scene's `visual_description` is full narrative prose that can trivially contain one of those generic words with nothing to do with the truck: "they **arrive** at the park," "she **enter**s the house," "front **door**," "**visit**ing his grandmother," "window **shop**." Every one of those would have wrongly forced the truck in under the reused heuristic — the exact "illogical scene" failure mode being fixed, just relocated rather than actually fixed.*

- Added a new, separate, much narrower `isVideoSceneAboutUnit` (`core/scene.ts`) that only fires on an explicit, unambiguous mention of the unit itself (`fresh-can`, `the unit`, `the truck`, `the container`, `mobile grocery`/`store`/`unit`, `qr code`) — no generic action verbs at all. `composeSceneImagePrompt` now gates on this instead of `isContainerRelevant`. Confirmed all 3 real relevant scenes from the actual job still match (they all name "Fresh-CAN" or "the unit" explicitly, as the script step's own real output already does), while a set of deliberately generic, unrelated narrative sentences no longer do.

**🧪 Testing**
- New `compose.test.ts` regression test: 5 unrelated creative scenes (mother/son walking, arriving at a park, entering a house, visiting a grandmother, window shopping) — none show the truck.
- Existing "shows the truck when relevant" tests still pass unchanged (real scene text names the unit/truck/QR code explicitly).
- `compose.test.ts`: 57/57 passing. `tsc --noEmit`, `eslint` clean. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/server/pipeline/prompts/core/scene.ts` — new `isVideoSceneAboutUnit` + `FRESH_CAN_UNIT_MENTION`
- `src/server/pipeline/prompts/core/compose.ts` — `composeSceneImagePrompt` now gates on `isVideoSceneAboutUnit`, not `isContainerRelevant`
- `src/server/pipeline/prompts/core/compose.test.ts` — new regression coverage

**💡 Decisions Made**
- Kept `isContainerRelevant` unchanged and untouched by video's needs — it's still correct for blog/photo's short topic strings, and video now has its own purpose-built, much more conservative heuristic rather than a shared one tuned for a different kind of input text.
- Didn't try to special-case or exclude specific generic verbs from the existing keyword set — a narrower positive-only allowlist (must name the unit/truck/container/QR code explicitly) is more robust than trying to patch an ever-growing list of exceptions to a heuristic built for different input.

**⭐ Pick Up Next Session**
- Same as above — no fresh real generation yet to visually confirm.

---

### Session 7 (cont'd) — 2026-09-19 — Confined the logo to the side panels only, after actually re-checking what the real reference photos show

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*User feedback: "make sure correct freshcan logo is used and the logo is not used at randon places. only on the side of the truck." Rather than patch the text again, opened and looked closely at all 3 real exterior reference photos (`assets/fresh-can/truck_exterior_{back,arrival,standing}.png`) against that exact claim for the first time — and found `CONTAINER_DESCRIPTOR` had been WRONG about the real truck all along:*

- `truck_exterior_back.png` (the photo Fix #3 earlier this session picked as character-ref's "clean" default, believing it had no contamination): the rear header bar actually carries a small SECOND wordmark, plus a whole separate "Scan to Shop Fresh" QR-code/feature-list panel next to the door — neither ever described.
- `truck_exterior_arrival.png`: the container's FRONT face (facing the cab) carries a large wordmark — directly contradicted the existing "front face... no wordmark" rule.
- All three: the visible side always also shows "fresh-can.com" URL text and a decorative red graphic wave alongside the real wordmark.
- This is the actual root cause of Fix #3's "duplicate garbled decal" character-ref defect — the model wasn't malfunctioning, it was faithfully (if messily) trying to reproduce real branding elements that nothing in the prompt had ever named or told it to disregard, on whichever photo it happened to load.

- **Fix**: simplified `CONTAINER_DESCRIPTOR` to one enforceable rule — the wordmark now appears ONLY on the two side panels (once each), and the front and rear are both explicitly plain (no wordmark, no signage, no QR code) — deliberately overriding what the real physical truck's wrap actually shows in 2-3 places, in favor of one consistent, simple, generateable rule.
- Reordered `referenceImages.exterior` so `truck_exterior_standing.png` (a full dead-on side profile — the one real photo showing the correct wordmark with the LEAST other real content competing in the same frame) is now index 0, and rewrote every framing string to explicitly name and disregard whatever real extra elements that specific photo shows (front wordmark for arrival; rear wordmark + QR panel for back; URL text/vents/red graphic for all three). `composeCharacterRefPrompt` already always used `exterior[0]` (from the earlier Fix #3) — no code change needed there, just the asset ordering and framing text.
- Updated `ONE_WORDMARK_ONLY` and `DEFAULT_NON_CONTAINER_HINT` (composeBlogImage's non-container fallback) to say "side panels only" instead of "rear header bar only".

**🧪 Testing**
- New `compose.test.ts` coverage: `containerDescriptor` confines the wordmark to the side panels and explicitly rules out front/rear/duplicates; `referenceImages.exterior[0]` is the full side-profile photo.
- Re-measured real prompt lengths after the rewrite (containerDescriptor grew from adding the rear/front plain-face language) — trimmed redundant restatements to land back at a max of 2974 chars for the real job's 3 relevant scenes, comfortably under KieImageGenerator's ~3000-char cap.
- `compose.test.ts`: 59/59 passing. `tsc --noEmit`, `eslint` clean. Full `vitest run` in progress at time of writing.

**📁 Files Changed**
- `src/server/pipeline/prompts/brand/fresh-can.ts` — `CONTAINER_DESCRIPTOR` rewritten (side-only logo); `referenceImages.exterior` reordered (standing first) and all 3 framing strings rewritten against the actual real photos
- `src/server/pipeline/prompts/core/compose.ts` — `ONE_WORDMARK_ONLY`/`DEFAULT_NON_CONTAINER_HINT` updated; `composeCharacterRefPrompt`'s rationale comment corrected
- `src/server/pipeline/prompts/core/compose.test.ts` — new coverage; one regex test flag fixed for `tsc`'s target (dropped unsupported `s` flag)

**💡 Decisions Made**
- Chose to simplify to a single side-only rule rather than keep describing every real placement (front + rear + side) — a generated image doesn't need to be faithful to the physical truck's exact wrap design; it needs to be CONSISTENT and CORRECT by the team's own simplified brand rule, and fewer legitimate locations means fewer chances for the model to duplicate or distort the logo.
- Verified this by actually opening and looking at the reference photo files directly, not by re-reading the existing prompt code's own claims about them — the existing claims turned out to be wrong in several specific, checkable ways once actually looked at.

**⭐ Pick Up Next Session**
- No fresh real generation yet to visually confirm. `freshcan_interior_1.png`/`_2.png` (the interior reference photos) haven't been re-checked against `interiorDescriptor` the same way — out of scope for this exterior-logo-specific fix, but worth the same treatment if an interior-scene defect is ever reported.

---

### Session 7 (cont'd) — 2026-09-19 — Fixed the video script ignoring the user's scene idea entirely and writing a generic Fresh-CAN mission pitch instead

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*User submitted a real scene idea for a video job — a family's cozy autumn dinner (pumpkin, squash, sweet potatoes, warm spices, ending around the dinner table), nothing about Fresh-CAN at all. The generated script/scene plan ignored it completely: cited real food-insecurity statistics, described "Fresh-CAN aims to change that," and forced the mobile grocery unit into 4 of the 7 generated scenes (arriving, browsing, scanning the QR code, a farmer harvesting) — user's own words: "very poor and unrelated."*

- **Root cause**: `composeVideoScriptSystemPrompt` (`core/composeText.ts`) already had scene-idea handling, but it was a single sentence appended at the very END of the whole system prompt — AFTER the brand's full mission statement, its category brief (a directive: "this category should focus on...", a second, directly competing topic), real statistics available to cite, the entire JSON schema, and every other instruction. By the time the model reached the one sentence asking it to build the story around the user's idea, it had already been primed hard toward brand/mission content by everything before it.
- **Fix**: restructured the prompt so the scene idea (when given) leads from the very first sentence, with the brand's mission reframed explicitly as background context/constraint rather than a competing topic. The category brief and statistics — the two most topic-like, directly competing pieces of brand content — are dropped entirely from the prompt in this case, rather than reworded softer (no safe phrasing of "here's a second, different topic you may also want to write about" avoids reintroducing the same bug). Voice/tone guidance (voice guidelines, banned words) still applies regardless, since that's tone, not topic. Added a short bookend reinforcement at the end of the prompt too (pointing back at "the idea given at the very start"), matching the layered-constraint pattern already used elsewhere in this file (`FOOD_MUST_LOOK_CLEAN`, `PHYSICALLY_PLAUSIBLE_SCENE`).
- Confirmed the scene_notes wiring itself was already correct end-to-end (`content_jobs.scene_notes` → `video.ts` → `generateScript.ts` → `composeVideoScriptSystemPrompt`) — this was purely a prompt-structure/emphasis bug, not a missing-data bug.

**🧪 Testing**
- Rewrote the relevant `composeText.test.ts` regression test to assert the scene idea now appears BEFORE the brand's mission statement in the composed string (`prompt.indexOf(sceneIdea) < prompt.indexOf(missionStatement)`), and that the category brief/stats are absent when a scene idea is given.
- New test confirming voice guidance (banned words) still comes through even though the category brief/stats are dropped.
- `composeText.test.ts`: 39/39 passing. `tsc --noEmit`, `eslint` clean. Full `vitest run`: 321/321 passing.

**📁 Files Changed**
- `src/server/pipeline/prompts/core/composeText.ts` — `composeVideoScriptSystemPrompt` restructured (scene-idea-first preamble; category brief/stats dropped when a scene idea is given; shortened bookend reinforcement at the end)
- `src/server/pipeline/prompts/core/composeText.test.ts` — updated + new coverage

**💡 Decisions Made**
- Chose to drop the category brief/statistics entirely rather than keep them with softer wording — this mirrors the same judgment call made for the image side of this session's other fixes (e.g. `NO_SUBJECT_IN_SCENE`): once something is confirmed to be a real competing-topic risk, the reliable fix is removing the competing content, not trusting a softer instruction to suppress it.
- Left `brandContext`/`statsLine` (shared by `composeOutlineSystemPrompt`/`composeCopySystemPrompt`) untouched — this fix is scoped to video's own system-prompt assembly, not a shared-function refactor, since blog/copy haven't shown this specific failure and a shared-function change would risk affecting them without matching evidence.

**⭐ Pick Up Next Session**
- No fresh real generation yet to confirm this holds on a real run — verified at the prompt-composition/unit-test level only.
- Worth watching whether `composeOutlineSystemPrompt`/`composeCopySystemPrompt` (blog) have the same latent risk (category brief competing with a given scene idea) — not yet reported broken, so not touched, but the same root cause could apply there too.

---

### Session 7 (cont'd) — 2026-09-19 — Answered "why did it mention food desert" — and closed the residual source, not just the category brief

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Follow-up question on the fix above: "why did it mention food desert when i never selected that category." The category brief was never the (sole) cause — `brand.missionStatement` itself is spliced into every text-generation prompt unconditionally, regardless of which category is selected, and it literally reads "...directly into food desert communities across Canada..." (`fresh-can.ts`). The previous fix already stopped quoting the category brief/statistics for a scene-idea-led video, but still quoted the FULL missionStatement verbatim (just reframed as "background context") — leaving this exact phrase sitting in the prompt regardless.*

- Added `BrandProfile.neutralIdentityLine` (optional, falls back to `missionStatement` when unset) — a short, purely factual line with the mission/statistics-adjacent framing deliberately stripped out, used ONLY by `composeVideoScriptSystemPrompt`'s scene-idea-led branch. `composeOutlineSystemPrompt`/`composeCopySystemPrompt` still correctly use the fuller `missionStatement` — those ARE Fresh-CAN content by definition, so the fuller framing is appropriate there; this is scoped to the one place a user's own unrelated story is what's supposed to be leading.
- Fresh-CAN's value: "Fresh-CAN operates a mobile grocery unit — a converted shipping container customers visit and shop in, found and unlocked via the free Fresh-CAN app and a QR code — in communities across Canada." — keeps the physical facts a story might legitimately need for accuracy (in case it does touch the truck/app) without the "food desert"/mission-pitch framing that has nothing to do with an arbitrary user idea.

**🧪 Testing**
- New `composeText.test.ts` coverage: a brand with `neutralIdentityLine` set uses it instead of `missionStatement` in the scene-idea branch; a brand without it (existing `testBrand` fixture) still falls back to `missionStatement` unchanged.
- `composeText.test.ts`: 41/41 passing. `tsc --noEmit`, `eslint` clean. Full `vitest run`: 323/323 passing.

**📁 Files Changed**
- `src/server/pipeline/prompts/types.ts` — new optional `BrandProfile.neutralIdentityLine`
- `src/server/pipeline/prompts/brand/fresh-can.ts` — `neutralIdentityLine` value
- `src/server/pipeline/prompts/core/composeText.ts` — `composeVideoScriptSystemPrompt`'s scene-idea branch now prefers `neutralIdentityLine` over `missionStatement`
- `src/server/pipeline/prompts/core/composeText.test.ts` — new coverage

**💡 Decisions Made**
- Added a new optional brand-profile field rather than string-manipulating `missionStatement` to strip the food-desert phrase at call time — string surgery on a fixed constant is fragile (silently breaks if the wording ever changes) and harder to reason about than a second, deliberately-written fact.
- Made it optional with a `missionStatement` fallback, not required — an existing or future brand file needs no change to keep working; only Fresh-CAN's own file was actually updated.

**⭐ Pick Up Next Session**
- Same as above — no fresh real generation yet to confirm.

---

### Session 7 (cont'd) — 2026-09-19 — Closed the remaining gaps in video's "brand relevance" prompt redesign: continuity, no-invented-props, creative expansion, and 3-layer motion

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*User provided a detailed spec for redesigning the video prompt architecture so Fresh-CAN's brand elements are a relevance-gated option, not a forced insertion (a "random truck" bug). Inspecting the codebase first found that the core of this — `isVideoSceneAboutUnit`'s narrow explicit-mention gate, `composeSceneImagePrompt`'s per-scene `showSubject`/`NO_SUBJECT_IN_SCENE` branch, and `composeVideoScriptSystemPrompt`'s scene-idea-leads/brand-facts-as-constraint restructuring — was already built and tested earlier this same session (see the two entries above). Rather than rebuild any of that, did a gap check against the full spec and closed the four pieces that were genuinely still missing.*

- **Continuity, without forcing the vehicle to persist**: `composeVideoScriptSystemPrompt` now asks for natural continuity of characters/clothing/setting across scenes that share a moment, and (in the scene-idea branch) explicitly says the vehicle appearing in one scene is never a reason to carry it into a later one.
- **No invented props/vehicles/people**: added a general "don't invent a prop, vehicle, building, or person that serves no purpose in the story" rule to the script prompt, plus a new `NO_UNEXPLAINED_PROPS` constant in `compose.ts` (same layered-constraint pattern as `NO_UNSCRIPTED_PEOPLE`/`FOOD_MUST_LOOK_CLEAN`) applied at image-render time too.
- **Creative expansion of brief ideas**: added an explicit instruction that a short idea (e.g. "a farmer's morning routine") should be expanded into specific, vivid detail — but every added detail must still serve that exact idea, never a generic/unrelated addition.
- **Three-layer video motion**: `composeSceneVideoPrompt` now explicitly separates subject action, ambient environmental motion (steam, wind, fabric, light), and camera motion, and states camera movement is never a substitute for the other two. `visual_description`'s schema description in the script prompt was also widened to ask for ambient motion, not just the subject's own action.

**🧪 Testing**
- New coverage in `composeText.test.ts` (continuity, no-invented-props, creative-expansion, vehicle-non-persistence, ambient-motion-in-visual_description) and `compose.test.ts` (`NO_UNEXPLAINED_PROPS`, three-layer motion in `composeSceneVideoPrompt`).
- Full suite: `tsc --noEmit` clean, `vitest run`: 330/330 passing.

**📁 Files Changed**
- `src/server/pipeline/prompts/core/composeText.ts` — `composeVideoScriptSystemPrompt`: continuity/no-invented-props/creative-expansion clauses added; scene-idea branch's vehicle-non-persistence sentence added; `visual_description` schema description widened to ask for ambient motion
- `src/server/pipeline/prompts/core/compose.ts` — new `NO_UNEXPLAINED_PROPS` constant (used in `composeSceneImagePrompt`); `composeSceneVideoPrompt` rewritten to separate subject/environmental/camera motion
- `src/server/pipeline/prompts/core/composeText.test.ts`, `src/server/pipeline/prompts/core/compose.test.ts` — new coverage

**💡 Decisions Made**
- Did not touch the DB schema (no new `environmental_motion` field) — the spec's 3-layer motion split is expressed entirely as prompt instructions over the existing `visual_description`/`shot_notes` fields, since a schema change wasn't necessary to get the model to produce and act on that separation.
- Left the already-complete brand-relevance gating (`isVideoSceneAboutUnit`, `showSubject`, `NO_SUBJECT_IN_SCENE`, the scene-idea-leads restructuring) untouched — it already matches the spec's core requirement and its own regression tests, so this session only added what was missing.

**⭐ Pick Up Next Session**
- No fresh real generation yet to confirm any of this holds end-to-end — verified at the prompt-composition/unit-test level only, same as the two entries above.

---

### Session 7 (cont'd) — 2026-09-19 — Fixed a real, confirmed money-losing bug: a downscale failure was discarding an already-paid KIE video generation

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*A real live video job (topic "test", the cozy-autumn-friends-cooking scene idea — coincidentally a good real-world confirmation that the brand-relevance prompt fix above works: the generated scenes were purely about the cooking story, zero forced Fresh-CAN content) hit "upload_post call failed: downscale poll timed out" on every one of its 6 scenes, 3 attempts in a row, before being cancelled — 18 wasted KIE video-generation charges. User's own words: "it ate up my credits."*

- **Root cause**: `generateSceneVisual.ts`'s `runSceneVideoClipStep` treated a failure of the downscale pass (upload-post.com's FFmpeg Editor API, which runs immediately AFTER a successful, already-billed KIE.ai video generation) as if the ENTIRE clip attempt had failed — discarding the KIE output and resubmitting a brand-new, separately-billed KIE video generation on every retry, just to redo a cheap, KIE-independent downscale step. The downscale timeout itself is most likely upload-post.com's own FFmpeg job queue getting backed up when several scenes' downscale jobs land within a ~25s window (matches a prior documented incident in `avMerger.ts` of upload-post.com jobs "vanishing" under similar conditions) — not confirmed with certainty since the scale job's id was never persisted anywhere to look up after the fact, but the actual money-losing bug is the discard-on-failure logic regardless of why the downscale step itself is slow.
- **Immediate mitigation**: cancelled the live job directly via Supabase (mirroring `POST /api/jobs/[jobId]/video/cancel`'s own logic, since the API route sits behind the login proxy and wasn't reachable from this session) to stop further KIE charges before implementing the real fix.
- **Fix**: new nullable `content_visual_assets.raw_file_url` column (migration `20260919170000_visual_asset_raw_file_url.sql`, applied manually via the Supabase SQL editor — additive only, no existing column/constraint touched). `runSceneVideoClipStep` now persists the raw KIE clip URL the moment KIE succeeds, BEFORE attempting the downscale pass. If downscale then fails, that URL is kept (not wiped) in the failure-path `upsertVisualAsset` call; the next attempt checks for it first and, if present, skips KIE entirely and resumes straight into the scale step alone. Once the asset reaches `status: ready`, `raw_file_url` is cleared back to null (no longer needed). Also fixed a smaller, related accuracy bug found while making this change: a downscale-only failure now records `provider: 'upload_post'` (was hardcoded `'kie'`) and checks its own, separate `MAX_ATTEMPTS.upload_post` retry budget instead of `MAX_ATTEMPTS.kie` — once `raw_file_url` exists, every subsequent failure genuinely is upload-post.com's, not KIE's.
- Confirmed the dependency directly: ran the full video e2e suite BEFORE applying the migration and watched it fail 8/16 tests with `Could not find the 'raw_file_url' column of 'content_visual_assets' in the schema cache` (the new `upsertVisualAsset` code unconditionally writes that column now, so this would have broken every visual-asset write — Blog/Image included — until the migration was applied) — then re-ran after the migration and got 330/330 passing.

**🧪 Testing**
- New `videoPipeline.e2e.test.ts` regression test: simulates KIE succeeding then the downscale step failing for every scene, asserts the raw KIE clip URL is persisted and kept through the failure, then retries with a working scaler and asserts `videoGenerator.submit` is never called again (no new KIE charge) while the clip still reaches `status: ready`.
- Full suite: `tsc --noEmit` clean, `vitest run`: 330/330 passing (post-migration).

**📁 Files Changed**
- `supabase/migrations/20260919170000_visual_asset_raw_file_url.sql` (new) — additive `raw_file_url` column
- `src/server/pipeline/db.ts` — `VisualAssetRow.raw_file_url`; `upsertVisualAsset` gains a `rawFileUrl` param
- `src/server/pipeline/steps/video/generateSceneVisual.ts` — `runSceneVideoClipStep` restructured: persists `rawUrl` right after KIE succeeds, resumes from it on retry instead of resubmitting to KIE, keeps it through a downscale failure, clears it on success; failure-path `provider`/max-attempts now reflect which provider actually failed
- `src/server/pipeline/steps/video/videoPipeline.e2e.test.ts` — new regression test

**💡 Decisions Made**
- Added a new column rather than reusing an existing status value/enum — `content_visual_assets.status` already has a fixed, narrow meaning (`pending`/`generating`/`ready`/`failed`) read by multiple call sites; overloading it to also encode "KIE done, only downscale pending" would have been a much larger, riskier change than one additive nullable column.
- Did not attempt to fix or even confirm the exact upstream cause of the downscale timeout itself (likely upload-post.com queue congestion under concurrent submission) — out of scope for this session, and not actionable without the failed scale job's id, which is never persisted. Worth watching for if the same timeout recurs after this fix, since the retry is now free but a job that keeps failing forever would still eventually exhaust `MAX_ATTEMPTS.upload_post` (4) and fail the pipeline.

**⭐ Pick Up Next Session**
- The cancelled job (`content_jobs.id = 7312e17c-3913-4784-8ab8-d72f410424c1`) was never regenerated after this fix — worth re-running end-to-end to confirm the fix holds against the REAL upload-post.com API (this session's testing was all against mocked adapters).
- If downscale timeouts keep recurring even with the free retry, worth persisting the scale job's provider_ref too (mirroring how the KIE clip's own provider_ref is already persisted before polling) so a future incident can actually look up what upload-post.com's side reported instead of only ever seeing "poll timed out."

---

### Session 7 (cont'd) — 2026-09-19 — Confirmed the raw_file_url fix live against the REAL upload-post.com API, found and fixed two more real bugs it surfaced

**Developer:** Pri
**Tool:** ✅ Claude Code CLI

**✅ Completed**

*Ran a fresh real video job (`content_jobs.id = 945dbde7-6d10-4f8c-8e87-46f0a1f65ee4`, 7 scenes) end-to-end against the REAL KIE/upload-post.com APIs (not mocks) to confirm the previous entry's `raw_file_url` fix actually holds in production. It did — but doing so surfaced two more real, previously-undiscovered bugs.*

- **Confirmed live**: all 7 scene clips hit the same "downscale poll timed out" failure again, and every one correctly kept its `raw_file_url` and retried the downscale alone — zero new KIE charges across 2 full failed attempts (verified byte-for-byte: the `raw_file_url` on each failed row was identical across attempts, and `pipeline_steps` correctly attributed the failure to `provider: 'upload_post'`, not `'kie'`).
- **Bug found — the account-wide rate limit wasn't just about submissions.** The pipeline eventually hard-failed on a 429 with an exact provider-reported violation (`"window":"per_min","count":63,"limit":62"`). Root cause: `uploadPostSubmitLimiter` (added earlier this session) only gates `submitCommand` — `UploadPostAVMerger.poll()` was completely unthrottled. With several scenes each polling their own downscale job every `SCALE_POLL_INTERVAL_MS` (5s) concurrently, POLLING ALONE generated enough GET-request volume to blow through the account's per-minute cap with zero new submissions involved. **Fix**: `poll()` (both the status check and the `finished`-branch download call) now also calls `uploadPostSubmitLimiter.acquire()` — the same account-wide budget every other call to this provider already shares.
- **Bug found — a manual recovery (bypassing the normal Inngest event flow to avoid re-paying KIE, see below) exposed a second, genuinely latent bug**: `transcribeAudio.ts`'s `runTranscribeAudio` short-circuited on `alreadySucceeded` BEFORE ever reaching its own `claimTrack('generating' -> 'awaiting_shared')` transition. `renderLanguageTrack.ts`'s `render` step already had the identical fix (with an almost word-for-word incident comment) for the exact same class of bug — `transcribeAudio.ts` was simply missing it. In real production use this would only bite on a genuine crash between `recordStepAttempt(succeeded)` and `claimTrack` (rare, but exactly the scenario `renderLanguageTrack.ts`'s comment already documents), but a direct external status reset reproduces it identically, which is how it was actually found live: a recovery script needed to reset a pipeline back to `generating` at its SAME generation (to let already-succeeded scene clips retry only their downscale step, per the earlier fix) — but its `content_language_tracks` reset was too broad and also rewound a track whose `localize_script`/`synthesize_voice`/`transcribe_captions` had ALL already genuinely succeeded, back to `generating`. That track then got permanently stuck: every subsequent call to `runTranscribeAudio` hit the early `alreadySucceeded` return and never reached the transition, exactly like a crash would. **Fix**: `runTranscribeAudio` now calls the same CAS-guarded `claimTrack('generating' -> 'awaiting_shared')` inside its `alreadySucceeded` branch, mirroring `renderLanguageTrack.ts`'s established pattern exactly.
- The stuck track above was corrected directly (one manual status update, matching what the fixed code now does automatically) and its render was resumed manually (real adapters) to confirm the whole chain works end-to-end — localize/synthesize/transcribe were already genuinely done, so nothing was re-paid there either. That manual render run was itself interrupted by an explicit user "stop generation" partway through (mid-poll, no error recorded) — left as-is; `renderLanguageTrack.ts`'s own resumability (a provider_ref persisted before polling, same pattern as the video-clip fix) means it's safe to resume normally, not stuck.

**🧪 Testing**
- New `videoPipeline.e2e.test.ts` regression test: simulates a track whose `transcribe_captions` step already succeeded but whose `status` was externally reset back to `generating` (the exact live scenario), asserts `runTranscribeAudio` recovers it to `awaiting_shared` without re-calling the transcription service.
- Full suite: `tsc --noEmit` clean, `vitest run`: 332/332 passing.

**📁 Files Changed**
- `src/server/pipeline/adapters/avMerger.ts` — `UploadPostAVMerger.poll()` now rate-limited (status check and download call), matching `submitCommand`
- `src/server/pipeline/steps/video/transcribeAudio.ts` — `runTranscribeAudio`'s `alreadySucceeded` branch now advances the track to `awaiting_shared` (CAS-guarded), instead of returning without ever reaching that transition
- `src/server/pipeline/steps/video/videoPipeline.e2e.test.ts` — new regression test

**💡 Decisions Made**
- Recovered the live stuck job via one-off scripts calling the real production step functions directly (real KIE/upload-post/OpenAI/ElevenLabs/AssemblyAI adapters), rather than through the normal Inngest event flow or the "Regenerate" button — `POST /video/regenerate` always bumps `current_generation`, which would have discarded all 7 already-successful KIE clips and re-paid for everything. No route exists for "resume this exact generation without bumping it," so this was done by hand; not something to repeat casually, but the right call given the alternative was re-paying for a full generation to recover from what turned out to be a pure rate-limiting hiccup.
- Fixed `transcribeAudio.ts`'s gap immediately rather than treating it as "only reachable via a manual mistake" — the identical fix already existing in `renderLanguageTrack.ts`, with its own incident comment, is strong evidence this is a real class of bug (crash between two separate writes) that this codebase already takes seriously elsewhere, not a one-off.

**⭐ Pick Up Next Session**
- Worth sweeping the remaining step functions once more for the same "hasSucceededStep early-return before a status transition" pattern (`generateScript.ts`/`generateCharacterRef.ts` were checked this session and are structured correctly — the transition happens unconditionally after the succeeded-check, not gated behind an early return — but `synthesizeVoice.ts`'s per-scene loop and the image/clip steps in `generateSceneVisual.ts` weren't exhaustively re-checked against this exact failure mode).
- The interrupted English track (`content_language_tracks.id = b377395f-3214-4600-9250-a57e84aad1b5`, status `rendering`) was left as-is per the user's explicit stop — needs a real resume/regenerate to actually finish.
