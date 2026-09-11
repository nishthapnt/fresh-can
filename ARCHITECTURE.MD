# Fresh-CAN — Current System Analysis & Backend Redesign

**Legend used throughout:** `[SOURCE]` = found directly in the provided files · `[RECOMMENDATION]` = my proposed design · `[UNKNOWN]` = cannot be determined from what was provided.

---

## 1. Current Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          BROWSER (Dashboard User)                        │
└───────────────────────────────┬────────────────────────────────────────-┘
                                 │ HTTPS
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                Next.js 16 App Router  (Vercel — 2 known deployments:    │
│                "freshcan-test-2qdv" and "fresh-can-zeta")               │
│                                                                          │
│  Pages: /dashboard, /dashboard/new, /dashboard/jobs/[id],               │
│         /dashboard/jobs/[id]/social, /dashboard/library, /login         │
│                                                                          │
│  Client-side direct-to-DB calls (via supabase-js, anon key)             │
│    - contentService.ts = single query layer                            │
│    - Supabase Realtime subscriptions (content_drafts, content_jobs)    │
│    - setInterval polling (multiple independent pollers, 1.5s–10s)      │
│                                                                          │
│  API routes (Next.js server, service-role or anon key):                │
│    POST /api/n8n/trigger            → fire-and-forget / synchronous     │
│    POST /api/jobs/[id]/regenerate   → reset + re-fire n8n               │
│    PATCH /api/jobs/[id]/draft       → edit draft_data                   │
│    POST /api/social/post            → upsert + fire n8n                │
│    DELETE /api/content/[id]                                            │
│    POST /api/webhooks/n8n-callback  → INBOUND, no auth in dev,          │
│                                        Bearer-token in prod             │
│    POST /api/auth/login, /logout    → HMAC session cookie               │
└───────┬───────────────────────────────────────────────────▲────────────┘
        │ fire webhooks (HTTP POST, shared secret header)    │ callback
        ▼                                                    │ (async)
┌────────────────────────────────────────────────────────────┴──────────┐
│                    n8n — ONE combined workflow                        │
│         Single inbound webhook "/webhook/freshcan-content"            │
│         dispatches internally by body.type via a Switch node:         │
│         video | video_approve | blog | image_questions |              │
│         image_post | social                                           │
│         (workflow currently exported as **inactive**)                 │
│                                                                        │
│  Each branch: long linear/looping chain of Code + HTTP Request +      │
│  Wait + If nodes running INSIDE ONE n8n execution for the entire      │
│  lifetime of the job (minutes to ~1 hour for video).                  │
└───────┬────────────────────────────────────────────────────┬──────────┘
        │                                                     │
        ▼                                                     ▼
┌───────────────────────────────┐   ┌──────────────────────────────────┐
│  External AI/Media Providers  │   │  Supabase Postgres (also used    │
│  - OpenAI (script/copy/agent) │   │  as blob storage for audio/video/│
│  - ElevenLabs (voice audio)   │   │  caption files)                  │
│  - AssemblyAI (captions/      │   │  Tables: content_jobs,           │
│    transcription timing)      │   │  content_drafts, generated_      │
│  - KIE.ai (image + video gen, │   │  content, social_posts,          │
│    incl. character reference) │   │  social_platform_logs            │
│  - upload-post.com (FFmpeg    │   └──────────────────────────────────┘
│    render-as-a-service AND    │
│    social posting to IG/FB/X) │
└────────────────────────────────┘
```

**Key structural fact `[SOURCE]`:** there is effectively **one** n8n workflow file (“Fresh-CAN — Combined Content Pipeline”), not three separate workflows as `CLAUDE.md`/`API_DOCS.md` describe. It has a single webhook path (`freshcan-content`) and a `Switch — Route by type` node that fans out to six branches (`video`, `video_approve`, `blog`, `image_questions`, `image_post`, `social`). The `.env.example` and `CLAUDE.md` docs describing three separate webhook URLs (`video-genration`, `blog-post`, `image-post`) appear to be **stale/legacy documentation** that no longer matches the actual n8n export provided.

---

## 2. Current Pipeline Breakdown

### 2.1 Job creation (`/dashboard/new`) `[SOURCE]`
- User fills a form (topic, keywords, category, target audience, language EN/FR/BOTH, content types to generate, optional province/city, optional free-text "scene notes", and for video: script type + duration).
- Browser **inserts directly into Supabase** (`content_jobs`, status `pending`) using the anon key — bypassing any API route entirely for job creation.
- For each selected content type except `image_post`, the browser calls `POST /api/n8n/trigger` with `type` = `video` | `blog`, which server-side POSTs to the single n8n webhook.
- If `image_post` is selected, the flow first requests **clarifying questions** from n8n (`type: image_questions`, this is the one call that is NOT fire-and-forget — the frontend waits for and renders n8n's JSON response), then submits the answers as a second call (`type: image_post`).
- Client-side Zustand stores (`newContentStore`, `contentJobStore`) persist in-flight state to `sessionStorage` so a page refresh doesn't lose the pending-job banner — this is a **browser-local, per-device** notion of "job in progress," not a real state machine.

### 2.2 Video pipeline `[SOURCE]`
Triggered by `type: video` (first draft) then `type: video_approve` (generation) via the same webhook, dispatched to n8n branch "Webhook1"/"FC — Webhook Trigger":
1. Build brand config → prepare script data → **OpenAI agent** generates the script → fix domain spelling → parse into `script_parts` → **write draft to Supabase (via HTTP call back to `/api/webhooks/n8n-callback` — not a direct DB write)** → job status → `draft_ready`.
2. If `language === 'FR'` or `'BOTH'`, a parallel "FR —" branch regenerates the script in French (forced-French code node), gated by `IF — Run Secondary Language?`.
3. On approval (`video_approve`), for each language required: get ElevenLabs voice ID → generate a **character reference image** via KIE.ai → poll it (max 12 retries) → generate per-scene audio via ElevenLabs → upload audio to Supabase storage → submit to **AssemblyAI** for transcription (used to time captions) → poll (max retries, code-tracked counter) → build captions → generate per-scene images/video via **KIE.ai** (image gen, then video gen) → poll (max retries) → build an FFmpeg merge job and submit to **upload-post.com's FFmpeg-as-a-service** → poll (up to 200 retries × 20s ≈ 66 min ceiling) → download the finished video → upload to Supabase storage → POST result to the callback (`generation_complete`/`video.completed` shape) → job → `ready` (only once **both** EN and FR rows exist in `generated_content` for a `BOTH` job).
4. Every "Complete?" check follows the same shape: `Wait N seconds → HTTP poll → If done? → else increment retry counter → If retries exceeded → throw`. There are **~10 independent copies** of this pattern (character ref, image gen, video gen, transcription, FFmpeg) duplicated per language (EN/FR), i.e. no shared/reusable polling abstraction.

### 2.3 Image pipeline `[SOURCE]`
Two entry points on the same webhook:
- `image_questions`: sanitizer → an **OpenAI agent** produces a short clarifying Q&A list → responded synchronously to the frontend (this is the only generation-adjacent call that is NOT fire-and-forget).
- `image_post`: sanitizer → agent builds a full KIE.ai prompt → **KIE.ai** creates one or more image tasks → poll (max retries) → extract URL → download final image → upload to Supabase storage → build caption/hashtags/alt text → POST `generation_complete` to the callback → **the frontend separately polls `generated_content` every 10s** (up to 5 minutes) since there's no realtime listener wired for `image_post`.

### 2.4 Blog pipeline `[SOURCE]`
`blog` type: two chained **AI agents** (outline/structure, then full copy) → generates hero + inline images via **KIE.ai** (`Generate Image 2`/`Generate Image 5`, each with its own retry counter and a **fallback placeholder** if KIE.ai never succeeds) → builds structured blog JSON (`FC — Blog Structure Output`) → **responds synchronously in the HTTP response body** of the original trigger call (not via the async callback) → the Next.js route (`/api/n8n/trigger`, `type==='blog'` branch) parses that response body itself and directly **upserts `content_drafts`** — this is architecturally different from every other content type, which write through the callback endpoint instead.

### 2.5 Social / posting pipeline `[SOURCE]`
`POST /api/social/post` → upserts `social_posts` (status `approved`) → fires `type: social` to n8n (webhook branch "Webhook" — separate secret-verification code node `FC — Verify Secret`, checking a **hardcoded** string) → n8n builds a caption+media payload → POSTs to **upload-post.com** (`/api/upload` for video, `/api/upload_photos` for images, platforms `instagram`/`facebook`/`twitter`) → polls upload-post.com's own async job status → on completion, POSTs `post_complete` back to the callback, which upserts `social_platform_logs` and sets `social_posts.status = 'posted'`.

### 2.6 Approval flow `[SOURCE]`
- **Video:** user edits AI-generated script parts in the UI, then "Approve & Generate" saves the (possibly edited) draft via `PATCH /api/jobs/[id]/draft`, fires `video_approve` (or an undocumented `video_approve_both` for BOTH-language jobs — see §3), marks `content_drafts.is_approved = true`, and flips `content_jobs.status` to `generating`.
- **Image:** there is no draft/approval step before generation — the image is generated immediately on submission; "approval" only marks the already-generated result as approved and is a **DB-only** action (no webhook fired).
- **Blog:** approval saves edits, is DB-only (no webhook), and — uniquely — **also writes a row directly into `generated_content`** from the client so the approved post shows up in the Library, duplicating logic that for every other content type lives in the callback route.
- All three types converge on a shared **regenerate** action (`POST /api/jobs/[id]/regenerate`) that resets the draft + job to `pending` and re-fires the original generation webhook with `extra_instructions`.

### 2.7 EN / FR / BOTH behavior `[SOURCE]`
- `content_jobs.language` is one of `EN | FR | BOTH`.
- For `BOTH`, the video branch actually runs the **entire per-language pipeline twice** (script, audio, images, render) and n8n itself decides internally whether to run the secondary language (`run_secondary` flag derived from `language==='BOTH'`).
- `content_drafts` and `generated_content` are keyed by `(job_id, content_type, language)` — a **schema fact only inferable from code**, since the checked-in `database.ts` types do **not** declare a `language` column on these tables at all (see §3.6).
- The UI defaults to showing the `EN` tab for `BOTH` jobs and provides a manual language toggle; a `BOTH` video job is only considered `ready` once **both** EN and FR rows exist in `generated_content`.
- Blog for `BOTH` appears to only be handled on the DB-upsert side (`onConflict: 'job_id,content_type,language'`) — there's no evidence in the n8n export of the blog branch running twice for two languages; it looks like it runs once per whatever `language` value was sent in the payload. **`[UNKNOWN]`** whether the blog/image branches actually produce two language variants for `BOTH`, or only ever produce one and the second is silently missing.

### 2.8 Async operations, polling & retries `[SOURCE]`
Three **independent, overlapping mechanisms** are all watching for the same state changes simultaneously:
1. **Supabase Realtime** — two channel subscriptions per job-detail page load (`content_drafts` INSERT/UPDATE, `content_jobs` UPDATE).
2. **Client-side `setInterval` polling** — at least four separate polling loops exist on the job detail page alone (a general draft-status poll at 1.5s–8s depending on state, an image-post-specific poll at 10s, plus timeout logic at 3–10 minutes), each independently querying Supabase.
3. **n8n's own internal polling loops** — 20s/30s/50s `Wait` nodes with hand-rolled retry counters stored in the n8n execution's JSON payload (not in any database), capped between 12 and 200 attempts depending on the stage.

None of these three layers know about each other. The code comments themselves acknowledge this is a workaround ("n8n updates content_jobs.status before it writes the draft, so realtime fires too early... this poll catches the window").

### 2.9 Job/status handling `[SOURCE]`
- `content_jobs.status` is a single flat enum (`pending → draft_ready → approved/generating → ready`, or `failed`) shared across **all** content types requested in a job. For a multi-type job (video + image + blog), this one field cannot represent "video is generating, blog is done, image failed" — the UI compensates with a client-computed `approvedTypes: Set<ContentType>` derived from scanning `content_drafts` rows, entirely in React state.
- **`status: 'failed'` is never written by anything** — not by the n8n workflow (confirmed: `'failed'` appears nowhere as an assignment in the workflow JSON, only as a possible poll-response value being checked), and not by any API route's catch block. A stuck job simply stays in `generating`/`pending` forever in the database; the only place "failure" is surfaced to a user is a client-side polling **timeout** banner that appears after 3–10 minutes, which does not change the database record.

### 2.10 Provider integrations `[SOURCE]`
| Provider | Used for | Auth style seen |
|---|---|---|
| OpenAI | Script/copy generation via n8n's LangChain agent nodes | n8n credential (not visible in export) |
| ElevenLabs | Text-to-speech voice audio per scene | n8n credential + `api.elevenlabs.io` |
| AssemblyAI | Transcription used to time captions | n8n credential + `api.assemblyai.com` |
| KIE.ai | Image generation, character-reference images, and video generation | n8n credential + `api.kie.ai` |
| upload-post.com | FFmpeg render-as-a-service (video+audio+captions merge) **and** social publishing to Instagram/Facebook/Twitter | n8n credential + `api.upload-post.com` |
| Supabase Storage | Blob storage for generated audio, captions, video, images (uploaded from inside n8n, not from the Next.js app) | service key inside n8n |
| Next.js app (as a "provider" from n8n's point of view) | Receives async completion callbacks | **hardcoded** shared secret string `freshcan_n8n_secret_2026`, sent as `Authorization: Bearer ...` |

---

## 3. Current Problems / Risks

### 3.1 No durable job/step state (highest severity) `[SOURCE + RECOMMENDATION-framing]`
All progress for a video (which can take up to ~66 minutes of polling for FFmpeg alone, on top of image/audio/transcription polling) lives **inside a single n8n execution's in-memory/JSON payload**. If n8n restarts, the server reboots, the execution hits a memory/time limit, or the workflow is edited while a job is mid-flight, **all progress for that job is lost** with no way to resume — the whole pipeline must run again from scratch, re-spending money on OpenAI/ElevenLabs/KIE.ai calls that already succeeded.

### 3.2 No failure state is ever persisted `[SOURCE]`
Every "max retries exceeded" path in the workflow does `throw new Error(...)`, which fails the n8n execution — but nothing updates `content_jobs.status` to `failed`. Combined with §3.1, a failed job is **indistinguishable from a slow job** from the database's point of view. Users only find out via a client-side timeout, and only if they happen to be on that page.

### 3.3 No idempotency / duplicate-prevention `[SOURCE]`
- The webhook trigger route (`/api/n8n/trigger`) has no idempotency key; a double-click, a retried fetch, or a user opening two tabs can fire the same generation twice.
- n8n itself has no deduplication — nothing checks "is there already a running job for this `job_id` + `content_type`" before starting expensive work.
- The `regenerate` endpoint resets state and re-fires, but doesn't cancel or fence off the original in-flight n8n execution, so a slow original run can still complete and overwrite/racing-write the regenerated result.

### 3.4 Callback authorization is weak and optional `[SOURCE]`
`isAuthorized()` in `/api/webhooks/n8n-callback/route.ts` explicitly **skips the check entirely if `N8N_WEBHOOK_SECRET` is unset** ("skip check if not configured (dev mode)") — if that env var is ever missing in production (a realistic ops mistake), the callback endpoint becomes a fully open, unauthenticated write endpoint into the jobs database. Separately, the shared secret is **hardcoded in plaintext inside the n8n workflow JSON** (`freshcan_n8n_secret_2026`, appearing 4 times) — if that workflow file is ever shared, exported, committed to source control, or backed up outside n8n's own storage, the secret leaks.

### 3.5 Two different callback target domains `[SOURCE]`
Six of the seven callback `httpRequest` nodes point to `https://freshcan-test-2qdv.vercel.app/api/webhooks/n8n-callback`, but the social "post complete" callback (`FC — Report Post Complete`) points to a **different** deployment: `https://fresh-can-zeta.vercel.app/api/webhooks/n8n-callback`. If these are meant to be the same environment, social-post completions may currently be landing on a stale/different deployment than every other event type — meaning `social_posts.status` may never actually reach `posted` in the live environment.

### 3.6 Schema drift between code and declared types `[SOURCE]`
The hand-maintained `src/types/database.ts` (used for the Supabase client generic) is **missing columns that the application code depends on everywhere**:
- `content_drafts.language` and `content_drafts.is_edited` are read/written throughout (`draft/route.ts`, `n8n/trigger/route.ts`, job detail page) but do not exist in the `content_drafts` type.
- `content_jobs.webhook_sent_at` is written from the "new content" page but isn't declared.
- `generated_content` is queried for many extra columns (`image_url`, `caption`, `hashtags`, `alt_text`, `headline_text`, `subtitle_text`, `status`, `language`, `topic`, `category`, `completed_at`) in `contentService.ts`'s library functions, none of which exist in the declared `Row` type.
- `social_platform_logs` is queried by a `job_id` column (in `getPostedContent()` and in the callback's `post_complete` insert) that isn't declared on that table at all, and per the ADR the type layer was already worked around with `createClient<any>` specifically because of this kind of mismatch.

This means the actual live Supabase schema has organically grown far beyond what's checked into source control, and nobody has regenerated types from the live DB (a follow-up the team's own `DECISIONS.md` flags as "future work" that was apparently never done). **`[UNKNOWN]`**: the true current shape of the live Supabase schema — only inferable indirectly from query call-sites, which is itself a risk (some call-sites may be querying columns that no longer exist, or that were added ad hoc by different n8n workflow edits over time).

### 3.7 Dead/undocumented webhook types `[SOURCE]`
`api/n8n/trigger/route.ts` defines webhook types `video_approve_both`, `image_approve`, and `blog_approve`, and the job-detail page actively calls `video_approve_both` for `BOTH`-language video approval — but **none of these three types exist as a Switch-node branch in the provided n8n workflow**, and `.env.example` doesn't define `N8N_VIDEO_APPROVE_BOTH_WEBHOOK`, `N8N_IMAGE_APPROVE_WEBHOOK`, or `N8N_BLOG_APPROVE_WEBHOOK` at all. Two possibilities, both bad: either (a) these point at n8n webhook URLs that 404, meaning **BOTH-language video approval may already be broken in production**, or (b) there are additional n8n workflows not included in this export that duplicate/fork the logic already present in the combined workflow — meaning the “Combined Content Pipeline” isn't actually the whole picture and there's hidden logic and additional secrets/state elsewhere. **`[UNKNOWN]`** which is true; this must be verified against the live n8n instance before any migration work starts.

### 3.8 Blog pipeline is architecturally inconsistent with the others `[SOURCE]`
Every other content type reports its result asynchronously via the callback endpoint. Blog instead returns its full draft **synchronously in the HTTP response** to the original trigger call, and the Next.js trigger route parses and writes it directly. This means: (a) the blog generation call cannot be fire-and-forget — the serverless function must stay alive for the entire OpenAI+KIE.ai blog generation time, risking Vercel function timeouts on longer posts; (b) blog approval duplicates the "write to `generated_content`" logic that the callback route owns for every other type, in a second place, with subtly different field-shaping code, which is a direct source of future divergent bugs.

### 3.9 No shared retry/backoff abstraction `[SOURCE]`
The same "wait → poll → check → increment counter → check-max → fail" shape is hand-duplicated roughly ten times across the workflow (once per external polling dependency, doubled for EN/FR). Retry limits are inconsistent and undocumented in one place (12 for image/character-ref, 60 for transcription/video, 200 for FFmpeg) with no visible business rationale, and are stored as ad hoc fields on the flowing JSON payload rather than a first-class concept.

### 3.10 "Proceed anyway" on partial failure `[SOURCE]`
At least two code nodes (`Poll Image ... Success?`, character-reference polling) explicitly log `WARNING: Max retries — proceeding anyway` and continue the pipeline even when the provider never returned success. This produces **silently degraded output** (missing images, fallback placeholders) that is reported to the user as a normal "complete" event, with no flag distinguishing "fully succeeded" from "completed with fallbacks."

### 3.11 Auth/session model is minimal `[SOURCE]`
Single shared ID/password for the whole dashboard, no per-user identity, no audit trail of who approved/regenerated/posted what. Acceptable for a small internal tool today per the team's own ADRs, but doesn't scale to more than one operator, and there's no rate-limiting on `/api/auth/login`.

### 3.12 Client does far too much orchestration `[SOURCE]`
The browser directly inserts into `content_jobs` (bypassing any server-side validation), directly updates `content_jobs.status`, directly upserts `generated_content` for approved blogs, and runs the retry-timeout/redirect logic that arguably belongs server-side. This means the **source of truth for "is this job done" is partly computed in a React component**, not in the backend — anyone calling the DB with a different client (or a future mobile app) would have to reimplement all of this logic.

### 3.13 Long-running, expensive, unattended generation with no hard budget/cost controls `[RECOMMENDATION-framed observation]`
Nothing in the current system caps total spend per job, detects runaway retry loops early, or throttles concurrent n8n executions — a stuck retry loop (up to 200×20s per stage, doubled for BOTH-language jobs) can tie up provider quota and n8n capacity for over an hour per job, multiplied across however many jobs are submitted concurrently.

---

## 4. Proposed Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         Next.js Dashboard                          │
│   (kept largely as-is — see §13 migration plan for what changes)   │
│   Talks ONLY to the backend's HTTP API — no direct Supabase writes │
│   from the browser for anything that mutates job state.            │
└───────────────────────────┬─────────────────────────▲──────────────┘
                             │ REST/JSON                │ SSE / polling
                             ▼                          │ (job status)
┌────────────────────────────────────────────────────────────────────┐
│                        Backend API (Node/TS)                       │
│  ─ Domain services: Jobs, Drafts, GeneratedContent, Social         │
│  ─ Validates input, owns all state transitions                     │
│  ─ Publishes jobs to the queue; never talks to providers directly  │
│  ─ Exposes: job status, progress %, step-level detail              │
└───────────────┬───────────────────────────────────────▲────────────┘
                │ enqueue                                 │ read
                ▼                                          │
┌────────────────────────────────────────────────────────────────────┐
│                    Durable Queue (e.g. Postgres-backed             │
│                    job table + worker, or BullMQ/Redis)             │
│    One row/job per STEP, not per whole pipeline. Each step is      │
│    small, retryable, and independently resumable.                  │
└───────────────┬──────────────────────────────────────────────────-─┘
                │ pulls work
                ▼
┌────────────────────────────────────────────────────────────────────┐
│                     Worker pool (horizontally scalable)             │
│   ─ Script Worker      (OpenAI)                                    │
│   ─ Voice Worker       (ElevenLabs)                                │
│   ─ Caption Worker     (AssemblyAI)                                │
│   ─ Image Worker       (KIE.ai)                                    │
│   ─ Video Render Worker(KIE.ai video + FFmpeg service)             │
│   ─ Blog Worker        (OpenAI + KIE.ai images)                    │
│   ─ Social Worker      (upload-post.com)                           │
│   Each worker = thin orchestration + a Provider Adapter (§8).      │
│   Long external waits become QUEUE DELAYS, not held connections —  │
│   a worker can crash and be restarted mid-job without losing state.│
└───────────────┬──────────────────────────────────────────────────-─┘
                │
                ▼
┌────────────────────────────────────────────────────────────────────┐
│         Same external providers as today (OpenAI, ElevenLabs,      │
│         AssemblyAI, KIE.ai, upload-post.com) — unchanged, wrapped   │
│         behind adapters. Object storage: keep Supabase Storage or  │
│         move to S3-compatible storage; either works behind an      │
│         adapter.                                                    │
└──────────────────────────────────────────────────────────────────-─┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│              Postgres (can remain Supabase Postgres)                │
│   All job/step/content state lives here as the single source of    │
│   truth — the queue, the workers, and the API all read/write the   │
│   same normalized schema (§5).                                     │
└──────────────────────────────────────────────────────────────────-─┘
```

`[RECOMMENDATION]` Nothing here requires abandoning Supabase's Postgres — it can remain the database of record. What changes is that **n8n is removed from the critical path** and replaced by an application-owned queue + worker layer that treats every external call as a small, retryable, resumable unit of work instead of one giant stateful execution.

### 4.1 Video is architecturally special — a shared-master layer

Everything above still applies to video, but video cannot be modeled as "N independent per-language pipelines" the way blog and image can, because video's most expensive and highest-risk steps — script/scene planning, character-reference generation, and per-scene visual (image + video clip) generation via KIE.ai — must produce **exactly one** result per job, shared by every requested language. Only voice synthesis, transcription/captions, and final render are genuinely language-specific.

Today's n8n workflow gets this wrong on both counts: for a `BOTH` job it (a) regenerates the **script itself** in French via a second OpenAI call (the "FR —" branch, §2.2 step 2) instead of reusing one semantic scene plan, and (b) reruns character-reference generation and per-scene image/video generation **once per language**, inside the `for each language required` loop (§2.2 step 3). Nothing stops EN and FR from ending up with different scenes, different character likenesses, or different environments — because structurally, nothing shares that layer today. That is the defect this revision fixes at the schema/queue level, not by convention or code review.

**This same defect exists in blog and image, confirmed by live production data (§17.4), and is now fixed by the same pattern, not a video-only one.** A real `BOTH`-language `generated_content` row for an image post has its English and French captions concatenated into a single string field — one row standing in for two languages, with no way to approve, retry, or post one independently of the other. Blog has the same structural exposure (unconfirmed by a live sample, but architecturally identical — one generation call producing one row per whatever `language` value the request carried). §5–§11 below introduce a **shared project + language track** split as a general pattern, not a video-specific one: every content type has something genuinely shared (video: character + scenes; image: the photo; blog: the hero/inline images) and something genuinely per-language (video: audio/captions/render; image: caption/hashtags/alt text; blog: title/body/SEO copy). The shared steps have no code path that can run twice per language, and language-specific steps have no code path that can touch shared assets — for all three content types, not just video.

### 4.2 Recommended video pipeline — exact step sequence

Steps marked **[ONCE]** execute exactly once per video job regardless of how many languages were requested. Steps marked **[PER LANGUAGE]** execute once per entry in `requestedLanguages` (so once for EN-only/FR-only, twice for BOTH — same code, same worker, just more queue entries).

```
[ONCE]  1. Build brand config, prepare input (topic, keywords, category, script
           type/duration, scene notes)
[ONCE]  2. Generate master script AND scene/shot plan in ONE call — a
           structured, LANGUAGE-NEUTRAL scene breakdown: scene count,
           per-scene visual description, shot notes (image_prompt/
           video_prompt equivalents), narration INTENT (semantic content —
           "hero explains the product's key benefit" — not literal wording),
           and a target duration budget per scene. Written to content_drafts
           as the one master draft; video_scenes rows are persisted from this
           same output, before approval.
        ── DECISION (resolved from evidence, see §17.1): the prior draft of
           this doc had scene/shot planning as a separate step 3, running
           AFTER approval. Real production draft data shows the scene
           breakdown — including per-scene visual/video prompts — is already
           produced in the SAME generation call as the script, before
           approval, today. Planning is cheap (it's free-form output in one
           LLM call); only actual asset GENERATION is expensive. Steps 2+3
           are merged here to match that reality and avoid an unnecessary
           extra round-trip. ──
        ── APPROVAL GATE ── user reviews/edits the master script AND scene
           plan (draft_data) in the existing DraftEditor UI, then approves
           ONCE — not once per language. This is the correct point for
           approval: after the semantic content AND visual plan are locked,
           before any expensive generation (character ref, visuals, audio)
           has been spent on it.
[ONCE]  3. Generate character reference image(s) via KIE.ai (pipeline-level
           content_visual_assets row, video_scene_id = NULL).
[ONCE]  4. Generate per-scene visual assets via KIE.ai (image gen, then video
           clip gen), one content_visual_assets row per scene, fanned out and
           fanned back in per §7.1. When the last scene's asset succeeds,
           content_pipelines.status → visuals_ready.

        ── from here, language tracks branch — see §6.5 for why steps 6a can
           start immediately after step 2's approval gate, not after step 4 ──

[PER LANGUAGE] 6a. Localize script — turn each scene's narration_intent into
           actual EN or FR wording (this is the ONLY place translation
           happens, and it never feeds back into visual generation).
[PER LANGUAGE] 6b. Generate audio per scene via ElevenLabs, using that
           language's voice ID and the localized wording from 6a.
[PER LANGUAGE] 6c. Submit audio to AssemblyAI for transcription/timing;
           build captions from the result (video_captions row).
[PER LANGUAGE] 7. Render — for this language, composite the SAME shared
           scene visual assets (step 4) with THIS language's audio (6b) and
           captions (6c) via the FFmpeg/upload-post.com render service. This
           step is gated: it cannot start until content_pipelines.status =
           visuals_ready AND this track's master_generation_used matches
           content_pipelines.current_generation (§10.1). It is the only step
           that requires BOTH the shared output and this language's output.
[PER LANGUAGE] 8. Upload final render, write generated_content (one row per
           track), track → ready.
```

**On scene duration/timing (the tricky part the user's spec flagged, correctly):** EN and FR narration for the same semantic content will not take the same number of seconds to speak — French is typically ~15-20% longer than English for equivalent meaning. But the shared scene visual assets (step 4) are generated once, at a fixed duration, before either language's actual narration exists. Real production draft data confirms this isn't handled today at all — every sampled draft's `script_config` (`estimated_words`, `actual_speech_rate`, `estimated_audio_dur`, `total_duration`) is an identical hardcoded constant regardless of actual content or language, so there's no existing logic to preserve here, only a placeholder to replace. Three options, in order of correctness:
1. **(Recommended) Plan for a duration band, not a fixed length.** Step 2's `target_duration_ms` per scene is a budget, not an exact figure, and must be computed from the real script (word count ÷ a realistic speech rate), not copied from a fixed template as today. Step 4 generates scene visual clips slightly longer than the shortest expected narration (e.g. KIE.ai video clips generated at a duration that comfortably covers the target band, or generated as loopable/holdable segments). Step 6a's localization is instructed to fit within the same target band per scene (a soft constraint on wording length, similar to subtitling conventions), keeping EN and FR reasonably close without forcing artificial padding.
2. **Render-time reconciliation absorbs the residual mismatch.** Even with (1), some drift is inevitable. The render step (7) handles per-scene sync by holding the last frame of a scene's visual clip if audio runs slightly long, or trimming trailing silence if audio runs short — never by regenerating or re-timing the shared visual asset itself, since that would violate the "shared visuals aren't language-aware" constraint. A small TTS pacing adjustment (ElevenLabs supports a stability/speed-ish parameter) can also be applied per language during 6b as a secondary lever.
3. **What NOT to do:** generating scene visuals to match one language's exact narration length (e.g. building EN first, timing scenes off it, then forcing FR to match) — this silently reintroduces a language dependency into the "shared" visual layer and defeats the entire point of this redesign. The visual asset's duration must be set from the script's planned duration budget (step 2), never from a specific language's realized audio length.

This step sequence, the duration handling above, and the queueing mechanics in §7.1 are the same for EN-only, FR-only, and BOTH — see §11 for why BOTH is not a special case of any of this.

---

## 5. Proposed Database / Domain Model `[RECOMMENDATION]`

**This section reflects two product decisions made after the live-database audit** (both recorded in §17.4): blog and image's `BOTH`-language handling is fixed in this same pass, not deferred, and `social_posts` gains a real language dimension. The consequence is a genuine simplification, not just more scope: once every content type has language-specific tracks, `content_pipelines` never needs a `language` column, for any type — the split that used to be "video is special, blog/image aren't" becomes one uniform pattern.

Core principle, now universal: **one job → one shared "project" per content type → N language tracks (1 for EN-only/FR-only, 2 for BOTH) → language-specific outputs.** What differs between video, image, and blog is only *what's shared* and *what's per-language* — not the shape of the split:

| Content type | Shared (once per job) | Per-language (once per track) |
|---|---|---|
| Video | Script + scene plan, character reference, per-scene visual clips | Localized narration, audio, captions, final render |
| Image | The photo itself (one KIE.ai image, from a language-neutral prompt) | Caption, hashtags, alt text |
| Blog | Hero + inline images | Title, slug, body copy, SEO fields |

```
content_jobs
  id, topic, keywords, category, target_audience, language (EN|FR|BOTH — display/
  intent only now; the real per-language state lives on content_language_tracks),
  content_types (text[]), status (derived/aggregate — see §6),
  created_by, created_at, updated_at

content_pipelines                 -- ONE row per (job, content_type), for EVERY
                                   -- type — video, image, and blog alike. No
                                   -- `language` column at all anymore: which
                                   -- language(s) were requested lives on
                                   -- content_language_tracks below, universally.
  id, job_id FK, content_type,
  current_generation (int, default 1),        -- version fence, see §10
  status (shared/project state machine, §6.4 — generalized, not video-only),
  scenes_total, scenes_visuals_ready_count,   -- video-only fan-in counters,
                                               -- NULL/unused for image/blog
  last_error, created_at, updated_at
  -- This absorbs what the previous draft of this doc called `video_projects` —
  -- there is no longer a separate table for that concept. `content_pipelines`
  -- IS the shared/project entity for all three content types.

pipeline_steps                    -- durable step log, one row per attempt,
                                   -- shared by every worker, every content type
  id, content_pipeline_id FK (nullable), content_language_track_id FK (nullable),
  step_name, status (pending|running|succeeded|failed), provider, attempt_number,
  input_snapshot (jsonb), output_snapshot (jsonb), error_message,
  started_at, finished_at
  -- Exactly one of the two FKs is set: shared/project-scoped steps reference
  -- content_pipeline_id; language-track-scoped steps reference
  -- content_language_track_id. This is what makes "which layer wrote this"
  -- a queryable fact instead of an inference from step_name.

-- ───────────────────── SHARED PROJECT LAYER (generalized, all types) ─────────────────────

content_visual_assets             -- shared, language-independent generated media —
                                   -- used by ALL THREE content types now
  id, content_pipeline_id FK, video_scene_id FK (NULL except for video's
  per-scene assets), generation (int), asset_type (character_ref | scene_image |
  scene_video_clip [video] | photo [image] | hero_image | inline_image [blog]),
  status (pending|generating|ready|failed), provider_ref, file_url, duration_ms
  (video only), attempt_number, created_at, updated_at
  -- Video: one character_ref row + one scene_image/scene_video_clip row per
  --   scene (per §4.2).
  -- Image: exactly one `photo` row.
  -- Blog: one `hero_image` row + one or more `inline_image` rows.
  -- These rows are written ONLY by shared/project step handlers. No
  -- language-track step handler holds a reference to this table's writer
  -- for ANY content type — see §10.

video_scenes                      -- VIDEO-ONLY: the language-neutral scene plan
  id, content_pipeline_id FK, generation (int),
  scene_number, visual_description, shot_notes, narration_intent (jsonb — the
  semantic content to be localized per language, NOT literal wording),
  target_duration_ms, created_at
  -- UNIQUE (content_pipeline_id, generation, scene_number)
  -- Image and blog have no scene concept — their shared visual asset(s) are
  -- flat rows on content_visual_assets with no scene decomposition.

content_language_tracks           -- one row per REQUESTED language, for EVERY
                                   -- content type — this is what replaces "one
                                   -- content_pipelines row per language" for
                                   -- blog/image, and what "video_language_tracks"
                                   -- was called in the prior draft of this doc
  id, content_pipeline_id FK, language (EN|FR),
  status (track state machine, §6.5 — generalized), master_generation_used (int),
  current_step, retry_count, last_error, created_at, updated_at
  -- UNIQUE (content_pipeline_id, language) — this is the row a "BOTH" request
  -- creates TWO of, for ANY content type; EN-only/FR-only create exactly one.

video_scene_audio                 -- VIDEO-ONLY: per language track, per scene
  id, content_language_track_id FK, video_scene_id FK, generation (int — the
  TRACK's generation, bumped on a full script-level reset only),
  narration_text (localized wording, produced by the localize_script step),
  file_url, duration_ms, provider_ref, status, created_at

video_captions                    -- VIDEO-ONLY: per language track
  id, content_language_track_id FK, generation (int),
  provider_ref, timing_data (jsonb), file_url (srt/vtt), status, created_at
  -- captions are NEVER shared across languages, even though they key off the
  -- same shared scenes — see §6.5/§13.
  -- Image/blog have no audio/caption concept — their per-language content is
  -- just text, which lives directly in content_drafts/generated_content below.

content_drafts
  id, content_pipeline_id FK (nullable), content_language_track_id FK (nullable),
  draft_data (jsonb), original_data (jsonb), is_approved, is_edited, status,
  language (legacy denormalized column, kept for read compatibility — see
  §17.4), version, created_at, updated_at
  -- Exactly one of the two FKs is set, by content type:
  --   Video: content_pipeline_id set (the ONE master script+scene draft),
  --     content_language_track_id NULL. There is no per-language video draft.
  --   Image/blog: content_language_track_id set (one draft per requested
  --     language — this is unchanged from how content_drafts already worked
  --     before this revision; only WHAT it's keyed to changes, from a loose
  --     (job_id, content_type, language) tuple to a real FK). content_pipeline_id
  --     NULL for these rows.
  -- UNIQUENESS: two partial unique indexes replace the single blanket
  -- UNIQUE(job_id, content_type, language) the live schema has today —
  -- UNIQUE(content_pipeline_id) WHERE content_pipeline_id IS NOT NULL
  -- (exactly one master draft per video project) and
  -- UNIQUE(content_language_track_id) WHERE content_language_track_id IS NOT
  -- NULL (exactly one draft per language track, for image/blog).

generated_content
  id, content_pipeline_id FK, content_language_track_id FK,
  file_url, thumbnail_url, output_data (jsonb),
  quality_flag (ok|degraded_fallback), created_at   -- quality_flag fixes §3.10
  -- For ALL THREE content types now: one row per language_track, not per
  -- pipeline. A BOTH job produces two generated_content rows for whichever
  -- type(s) were requested as BOTH, both pointing at the same
  -- content_pipeline_id but different content_language_track_id.
  -- UNIQUENESS: UNIQUE(content_language_track_id) — one rule for every
  -- content type now, replacing the old (job_id, content_type, language)
  -- constraint entirely (that constraint's job is now done by the track's
  -- own uniqueness, one level up).
  -- job_id/content_type/language stay as DENORMALIZED, derived-at-write-time
  -- columns (not the identity key) for the Library page's existing query
  -- patterns — contentService.ts's heavy filtering by these columns doesn't
  -- need to change to a join-based query as part of this migration.
  -- STORAGE PATH (video): today's files are at freshcan-videos/{job_id}.mp4 —
  -- no language segment, which collides for two renders under one job. New
  -- convention: freshcan-videos/{job_id}/{language}.mp4. Existing completed
  -- rows keep their current file_url as-is — nothing forces touching
  -- historical files. Blog's hero/inline images currently point at a
  -- third-party ephemeral host (tempfile.aiquickdraw.com, confirmed via
  -- live sample data) instead of permanent storage — now that blog's images
  -- are formally a shared, persisted asset referenced by two language
  -- tracks, they must be downloaded and re-uploaded to permanent storage as
  -- part of the shared blog-visual step, the same way video and image
  -- already do (§13 Phase 3 note).
  -- STATUS COUPLING: generated_content.status = 'completed' is the literal
  -- string an existing RLS policy ("Public read completed") keys off.
  -- quality_flag is ADDITIVE, not a replacement for `status` — the terminal
  -- string value must stay 'completed' or that policy silently breaks public
  -- content visibility.

social_posts
  id, job_id FK, content_type, language (NEW — NOT NULL going forward),
  content_language_track_id FK (NEW — points at the exact language variant
  being posted, not just a loose language string), caption, hashtags,
  platforms, is_edited, original_caption, status (state machine, §6.6),
  approved_at, approved_by, scheduled_at, created_at, updated_at
  -- UNIQUENESS: UNIQUE(job_id, content_type, language) — replaces the live
  -- schema's UNIQUE(job_id, content_type), which today makes a BOTH job's
  -- social post a single row with no language dimension at all. A BOTH job
  -- now creates two independent social_posts rows, one per language, each
  -- postable/retryable/failable on its own — see §6.6 and §17.4.

social_platform_logs
  id, social_post_id FK, platform, status, platform_post_id, post_url,
  error_message, attempt_number, retry_count, last_retry_at, created_at, updated_at
  -- RETRY TRACKING: the live schema already has retry_count/last_retry_at
  -- columns here, doing real work today. pipeline_steps becomes the
  -- canonical attempt/retry log for everything, including social — but these
  -- two columns stay as a cheap denormalized "latest count" for existing
  -- queries/UI to keep reading directly, updated alongside pipeline_steps
  -- rather than replaced by them. No migration of existing rows required.

provider_credentials               -- see §9 secure-credentials design
  id, provider_name, secret_ref (pointer into a secrets manager, never the
  raw secret), rotated_at

webhook_inbound_events             -- idempotency & audit log for any inbound event
  id, source, external_event_id (unique), payload (jsonb), received_at,
  processed_at, result   -- inbound provider webhooks are only ever
                          -- processed once per external_event_id (§10)
```

**Relationships at a glance (generalized — the same shape for video, image, and blog; video shown with its extra scene/audio/caption detail tables, image/blog have a flatter version of the same shape):**

```
content_pipelines (1 per job × content_type — video, image_post, OR blog)
        │
        │ 1:N (video: per-scene; image: one row; blog: hero+inline)
        ▼
  content_visual_assets ◀── video_scenes (video only — the scene plan that
        │                    content_visual_assets' per-scene rows key off)
        │
        │ 1:N (one per requested language, ANY content type)
        ▼
  content_language_tracks (EN, FR) ──1:N──▶ video_scene_audio (video only)
        │                        └──1:N──▶ video_captions (video only)
        │ 1:1 (once ready)                 (image/blog tracks have no
        ▼                                   audio/caption children — their
  generated_content (final output,          per-language output IS the
   one per track, ANY content type)         content_drafts/generated_content
        │                                   text itself)
        │ 0:N (one per language, if the language's output is posted)
        ▼
  social_posts (EN post, FR post — independently postable, §6.6/§17.4)
```

Key changes vs. the prior revision:
- `content_pipelines` is now the universal shared/project entity for all three content types — the prior draft's `video_projects` table is gone, absorbed into `content_pipelines` directly, because there's no longer any content type where the "project" concept doesn't apply.
- `content_visual_assets` + (for video only) `video_scenes` are the shared/project layer's actual generated media — the schema-level guarantee that EN and FR reuse identical scenes/photos/images, because there is exactly one row set per project generation, not one per language, **for any content type**, not just video.
- `content_language_tracks` replaces "one `content_pipelines` row per language" universally — it carries its own status, retries, and generation fence, so a language can fail/retry/regenerate in complete isolation from the shared assets and from the other language, for video, image, AND blog.
- `generated_content.content_language_track_id` lets a `BOTH` job have two final outputs under one pipeline, for any content type, instead of the language ambiguity flagged in §3.6/§2.7 and confirmed live in §17.4's image-post sample.
- `social_posts` gaining a real `language` column and `content_language_track_id` FK closes the gap the audit found: a `BOTH` job can now produce two independently postable social posts, each tied to the specific language variant of the content it's posting — not one post with no way to represent which language (or a bilingual smash) it's for.
- `pipeline_steps` is still the durable step log, now explicit about which layer (`content_pipeline_id` vs. `content_language_track_id`) each step belongs to, for every content type uniformly.
- `quality_flag` and `webhook_inbound_events` are unchanged from the prior revision.

---

## 6. Job + Step State Machines `[RECOMMENDATION]`

**Note on scope (updated after §17.4's decisions):** §6.1 below is now a superseded/legacy reference only — it described a per-(content_type, language) pipeline state machine that no longer exists for ANY content type, now that blog and image also use the shared-project + language-track split. §6.4 (project-level, generalized) and §6.5 (track-level, generalized) are the real state machines for all three content types now. §6.6 (social) reflects the new per-language post model.

### 6.1 Pipeline-level (SUPERSEDED — kept only as a reference to the shape being replaced)
```
   created ──▶ drafting ──▶ draft_ready ──▶ awaiting_approval ──▶ approved
                  │                                                  │
                  ▼                                                  ▼
                failed ◀──────────────── (any state can fail) ── generating
                  ▲                                                  │
                  │                                                  ▼
                  └───────────────────────────────────────────── ready
                                                                      │
                                                                      ▼
                                                              (posted, via
                                                               separate social
                                                               state machine)
```
This was the assumption blog/image ran on before the audit — one state machine per (content_type, language), no shared layer at all. It's what let a `BOTH` image post collapse into one bilingual-concatenated row instead of two independent lifecycles (§17.4). It's superseded by §6.4/§6.5 below for every content type; kept here only so the "before" shape is legible in this document's history.

### 6.2 Job-level status (aggregate, computed — not stored as free-standing truth)
`content_jobs.status` becomes a **read-side projection** computed from its child pipelines:
- `pending` — no pipeline has left `created`
- `partial_draft_ready` — at least one pipeline reached `draft_ready`, not all
- `draft_ready` — all pipelines reached `draft_ready`
- `generating` — at least one pipeline is `generating`, none `failed`
- `ready` — all pipelines reached `ready`
- `failed` — at least one pipeline reached `failed` and hasn't been retried/resolved
- `partial_ready` — some pipelines `ready`, others `failed` (lets a user post the video while the blog is retried)

This directly fixes §2.9's core complaint and removes the need for client-side `approvedTypes` reconstruction.

**Every content type's contribution to this projection is now the same shape of aggregate** (not just video's, per §17.4): a `content_pipelines` row's own status is `ready` only when the shared/project layer is `visuals_ready` **and every row in `content_language_tracks` for that pipeline is `ready`**; it's `generating` if the project or any requested track is mid-flight and none have failed terminally; it's `partial_ready`-flavored at the pipeline level (surfaced up through the job aggregate's existing `partial_ready` state) if, say, EN is `ready` and FR is `failed_terminal` — whether that pipeline is a video, an image post, or a blog post.

### 6.3 Step-level (generic, reused by every worker)
```
pending → running → succeeded
             │
             ├──▶ failed_retryable ──▶ (requeued with backoff) ──▶ running
             │
             └──▶ failed_terminal (max attempts hit — pipeline → failed,
                                    with the real last-error preserved,
                                    unlike today's silent timeout)
```
This single reusable state machine replaces the ~10 hand-duplicated "wait/poll/count/fail" copies in the current n8n workflow (§3.9).

### 6.4 Project-level (shared) state machine (`content_pipelines.status`) — generalized to all three content types

**The general shape:** `created → generating shared content → shared content ready (fan-out unblocks tracks) → [regeneration loop] → failed_terminal on any unrecoverable step.` One structural choice varies by content type: **whether user approval gates the shared generation, or happens after it** — because that's how each type already behaves today (§17.1), and this redesign fixes the language-independence bug without relitigating that existing UX choice.

**Video's instantiation** (approval gates shared generation, because it's expensive — character ref + per-scene clips cost real money, so the script is locked first):
```
created ──▶ drafting_script ──▶ script_draft_ready ──▶ awaiting_approval ──▶ script_approved
             (script + scene plan                                                 │
              generated together —                                                ▼
              see §17.1)                                        generating_character_ref
                                                                                    │
                                                                                    ▼
                                                                  generating_scene_visuals
                                                                                    │
                                                                                    ▼
                                                                          visuals_ready ─────▶ (fan-out event: every
                                                                              │  ▲               waiting language track
                                                                              │  │               unblocks its render step)
                                    (explicit "regenerate visuals" action) ──┘  │
                                                                                 │
                                                              visuals_stale ─────┘
                                                         (re-enters generating_scene_visuals
                                                          with current_generation + 1)

failed_terminal ◀── any state above can fail terminally (script generation fails,
                     character-ref or a scene-visual step exhausts retries).
                     A project failure blocks ALL language tracks — none can start
                     or render without approved script + ready visuals.
```

**Image/blog's instantiation** (generation happens immediately, matching current UX — §2.3/§2.4 show both already generate first and let the user review/edit afterward; there is no pre-generation approval gate to preserve here, and this redesign doesn't add one):
```
created ──▶ generating_shared_visual ──▶ shared_visual_ready ─────▶ (fan-out event: every
                    │                          │  ▲                  requested language
                    │      (explicit "regenerate visual" action) ──┘  track unblocks)
                    ▼                          │
              failed_terminal          visual_stale ─────┘ (re-enters generating_shared_visual
                                                             with current_generation + 1)
```
Image: `generating_shared_visual` is the one KIE.ai photo call. Blog: it's the hero + inline image generation (now uploaded to permanent storage as part of this step, per §5's storage-path note — not left on KIE.ai's ephemeral tempfile host as today).

Two distinct regeneration triggers apply to every content type, with different blast radii (see §10 for the full rules) — video's has two scopes because it has two shared layers (script *and* visuals); image/blog only ever have one shared layer (the visual itself), so they only have one regeneration scope:
- **Video — regenerate the script** (`scope: "script"`) → back to `drafting_script`, generation bumped, scenes/visuals/**and every language track** invalidated.
- **Video — regenerate visuals only** (`scope: "visuals"`) → back to `generating_scene_visuals`, generation bumped, every language track's **audio and captions untouched** — only final render is affected.
- **Image/blog — regenerate the shared visual** (`scope: "visual"`) → back to `generating_shared_visual`, generation bumped, every language track's **caption/copy text untouched** — the photo/images changed, the words didn't, so tracks flip to `stale` and only need to re-associate with the new asset, not regenerate their text.

### 6.5 Language-track state machine (`content_language_tracks.status`) — generalized to all three content types

**The general shape:** `waiting_on_shared_content → (language-specific generation work) → draft_ready → awaiting_approval → approved → ready`, with a gate somewhere in the middle for whichever step actually needs the shared asset to exist.

**Video's instantiation** (audio/caption work doesn't need the shared visuals at all — only final render does, so the gate sits right before rendering, and there's no separate approval step after rendering: the track's own script wording was already approved as part of the shared master):
```
waiting_on_shared ──▶ localizing_script ──▶ generating_audio ──▶ transcribing_captions ──▶ awaiting_visuals ──▶ rendering ──▶ ready
      │                                                                                          │                   │
      │                                                                                          │                   ▼
      │                                                                                          │           failed_retryable ──▶ (requeue, same
      │                                                                                          │                   │            generation) ──▶ rendering
      │                                                                                          │                   ▼
      │                                                                                          │           failed_terminal
      │                                                                                          │
      └──────────────────────────────── any step above can also fail_retryable/failed_terminal ──┘           independently of the
                                                                                                                other language and of
ready ──(shared visuals regenerate, generation bump)──▶ stale ──▶ rendering (re-render only) ──▶ ready       the project, once past
ready/any ──(shared SCRIPT regenerates, generation bump)──▶ waiting_on_shared (full reset)                    awaiting_visuals.
```

**Image/blog's instantiation** (the language-specific work IS text — caption or blog copy — generated once the shared visual exists, then reviewed/edited/approved by the user exactly as today, per §2.6):
```
waiting_on_shared ──▶ generating_caption_or_copy ──▶ draft_ready ──▶ awaiting_approval ──▶ approved ──▶ ready
      │                          │                                                                        │
      │                          ▼                                                                        ▼
      │                  failed_retryable ──▶ (requeue) ──▶ generating_caption_or_copy          failed_terminal
      │                          │
      └──────────────────────────┘
ready ──(shared visual regenerates, generation bump)──▶ stale ──▶ (no automatic re-render — user re-approves
                                                                    against the new visual, since there's no
                                                                    "render" step to redo; just a re-association)
```
Image: `generating_caption_or_copy` produces caption/hashtags/alt text. Blog: it produces title/slug/body/SEO fields. Both reuse the SAME `draft_ready → awaiting_approval → approved` shape the pre-audit design already had (§6.1) — the only thing that changed is that this now happens **per language track**, against a **shared** visual asset, instead of as one pipeline row producing one (possibly bilingual-mashed) result.

**Key points that hold for every content type:**
- **Language-specific work starts as soon as the shared layer permits it, not strictly after the shared layer fully completes** — video's audio/caption work only needs `script_approved`; image/blog's caption/copy generation only needs the shared visual to exist (which, since there's no approval gate for those types, is immediately after project creation). Only the step that actually consumes the shared asset (video's render; nothing further for image/blog, since their "final output" is just text next to an already-shared file) is gated.
- **One language failing never affects the other or the shared project** — different rows, different queue keys, different worker invocations, for every content type. Job-level aggregate status (§6.2) becomes `partial_ready`: the succeeding language is fully postable now, the failed one shows a retry action scoped to just that track.
- **`stale` vs. full reset**: a visuals-only/visual-only regeneration leaves language-specific output untouched (video: audio+captions; image/blog: caption/copy text) — only the association with the new shared asset needs redoing. A video script-level regeneration is the one case that invalidates language-specific output too, since scene timing may have shifted.

### 6.6 Social post state machine — now one instance per language (§17.4)

```
draft ──▶ pending_approval ──▶ approved ──▶ posting ──▶ posted
                                              │
                                              ▼
                                            failed ──▶ (retry) ──▶ posting
```
The state machine's shape is unchanged from the prior revision. What changed, per the product decision in §17.4, is **how many `social_posts` rows exist per job × content_type**: today it's always exactly one (`UNIQUE(job_id, content_type)`, no language dimension at all — confirmed live). Going forward it's one **per requested language** (`UNIQUE(job_id, content_type, language)`), each independently walking this state machine. A `BOTH` video (or image, or blog) job now produces two `social_posts` rows — an EN post and an FR post, each referencing its own `content_language_track_id` and therefore its own caption and its own final content (its own video render, or the same shared image/blog visual paired with its own caption/copy) — so "EN posted successfully, FR failed to post" is representable at the social layer, not just at the content-generation layer. Per-platform outcomes within one language's post are still tracked independently in `social_platform_logs` so "EN posted to Instagram, EN failed on Twitter" is also representable (today `social_posts.status` is a single value shared across all selected platforms, per-post).

---

## 7. Queue / Worker Design `[RECOMMENDATION]`

**Goal:** replace one long n8n execution per job with many small, independently retryable jobs.

- **Queue technology:** either (a) Postgres-native (e.g. a `pgboss`/`graphile-worker`-style `SELECT ... FOR UPDATE SKIP LOCKED` job table — no new infra, fits the existing Postgres investment) or (b) Redis + BullMQ if higher throughput/visibility tooling is wanted. Given this system's volume (an internal content tool, not high-QPS), the Postgres-native option is the pragmatic default — one less moving part to operate.
- **Unit of work = one step**, not one pipeline. E.g. "generate script," "poll KIE.ai image task," "submit FFmpeg render," "poll FFmpeg render" are each their own queued job, not one giant function.
- **Long external waits become delayed re-enqueues**, not held connections or in-process `sleep`/`Wait` nodes. A "poll KIE.ai" job that isn't done yet re-enqueues itself with a delay (exponential backoff with a cap) instead of blocking a worker thread — this is what makes the system crash-safe (§10) and lets one worker process handle many jobs concurrently.
- **Per-content-type worker pools** so a backlog of video renders doesn't starve blog generation; concurrency limits per provider (e.g. cap concurrent KIE.ai calls) protect against rate limits.
- **Priority:** approval-triggered generation (user is actively waiting) can be prioritized over speculative/batch regeneration.
- **Dead-letter handling:** steps that exhaust retries move to `failed_terminal` and are visible in an operator queue for manual retry/inspection, rather than vanishing into an n8n execution log that nobody is watching.
- **Scheduling for polling steps:** a poll step re-enqueues itself; the total elapsed time and attempt count live in `pipeline_steps`, not in a per-execution in-memory counter, so they survive worker restarts.

### 7.1 Shared-project queuing vs. language-track queuing — generalized to all three content types

This is where the shared-project requirement becomes concrete and enforceable, not just documented — and per §17.4, it now applies to image and blog exactly as it does to video, not as a video-only mechanism.

- **Shared/project steps are queued under a namespace keyed by pipeline + generation, never by language:** `content:{content_pipeline_id}:project:{step}:gen:{generation}`. Video's steps: `generate_script`, `generate_character_ref`, `generate_scene_visual` (one queued job **per scene**). Image's step: `generate_photo` (one job, no fan-out). Blog's steps: `generate_hero_image`, `generate_inline_images`. There is no queue key that includes a language for any of these, for any content type — structurally, nothing can enqueue a second `generate_character_ref` or `generate_photo` job for the same pipeline generation just because two languages were requested.
- **Fan-out/fan-in only applies where there's actually more than one shared asset to wait for** — video's per-scene visuals (once `generate_character_ref` succeeds, one `generate_scene_visual` job is enqueued per row in `video_scenes`; each success transactionally increments `content_pipelines.scenes_visuals_ready_count`, and the job that reaches `scenes_total` flips `content_pipelines.status → visuals_ready`) and blog's hero+inline images (a two-item fan-in, same pattern). Image has nothing to fan in — its one `generate_photo` job directly flips `content_pipelines.status → visual_ready` on success. Using a DB-transactional counter (rather than a periodic sweep) keeps this responsive without needing a dedicated barrier/coordinator process.
- **Language-track steps are queued under a namespace keyed by pipeline + language + track generation:** `content:{content_pipeline_id}:track:{lang}:{step}:gen:{track_generation}`. Video: `localize_script`, `generate_audio` (per scene), `transcribe_captions`, `render`. Image: `generate_caption`. Blog: `generate_copy`. These run on entirely independent queue keys per language, for every content type — an FR worker crash, backoff, or rate-limit delay never blocks, delays, or is even visible to EN's queue entries, and vice versa. This is what makes "if FR fails, EN still completes" a property of the queue topology, not something a step handler has to remember to check, whether the content is a video, an image post, or a blog post.
- **Video's `render` step's precondition is checked, not assumed** (image/blog have no equivalent gated step — their caption/copy generation only needs the shared asset to exist, which for those types is available immediately since there's no pre-generation approval gate, per §6.4): `render` is enqueued (exactly once) by whichever of these two events resolves second — "this track's captions finished" or "the shared layer reached `visuals_ready`" — using an atomic compare-and-set on the track row so a race between the two events can't double-enqueue render or drop it.
- **Per-content-type worker pools isolate video from blog from image** (as in the original design above); within video specifically, it's worth also giving `generate_scene_visual`/`generate_character_ref` (shared, expensive, KIE.ai-rate-limited) a separate concurrency pool from `generate_audio`/`transcribe_captions`/`render` (language-track, ElevenLabs/AssemblyAI/upload-post.com-rate-limited), so a burst of scene-visual jobs for one video doesn't starve another video's language-track work.

---

## 8. Provider Abstraction Design `[RECOMMENDATION]`

Every current external call becomes a typed adapter implementing a small interface per capability, so business logic never calls a provider SDK/HTTP client directly:

```
interface ScriptGenerator     { generate(input): Promise<ScriptResult> }
interface VoiceSynthesizer    { synthesize(input): Promise<{jobRef}>; poll(jobRef): Promise<VoiceResult|Pending> }
interface TranscriptionService{ submit(input): Promise<{jobRef}>; poll(jobRef): Promise<TranscriptResult|Pending> }
interface ImageGenerator      { generate(input): Promise<{jobRef}>; poll(jobRef): Promise<ImageResult|Pending> }
interface VideoRenderer       { generate(input): Promise<{jobRef}>; poll(jobRef): Promise<VideoResult|Pending> }
interface AVMerger            { submit(input): Promise<{jobRef}>; poll(jobRef): Promise<MergeResult|Pending> }
interface SocialPublisher     { publish(input): Promise<{jobRef}>; poll(jobRef): Promise<PublishResult|Pending> }
```

Concrete implementations: `OpenAIScriptGenerator`, `ElevenLabsVoiceSynthesizer`, `AssemblyAITranscriptionService`, `KieImageGenerator`, `KieVideoRenderer`, `UploadPostAVMerger`, `UploadPostSocialPublisher`. Each adapter is responsible for its own auth, request shaping, and normalizing the provider's response into the shared `Result | Pending | Failed` shape — the generic step state machine (§6.3) doesn't need to know anything provider-specific.

Benefits over today: swapping KIE.ai for another image provider, or upload-post.com for a different social API, touches one adapter file, not N duplicated code nodes; every adapter can be unit-tested against recorded fixtures without hitting real providers (§14); rate limits and cost tracking can be centralized per adapter.

---

## 9. API Design `[RECOMMENDATION]`

Keep the dashboard's URL structure recognizable to minimize frontend churn, but move all state-mutating logic server-side and make responses reflect the new domain model.

```
POST   /api/jobs                          create job (server validates + persists;
                                           replaces direct browser insert)
GET    /api/jobs                          list (pagination, filter by status)
GET    /api/jobs/:jobId                   job + all pipelines + steps summary
GET    /api/jobs/:jobId/status            lightweight polling/SSE endpoint —
                                           aggregate status + per-pipeline %

-- Video, image, and blog now ALL follow the SAME shape (§17.4) — one shared
-- pipeline per job × content_type, N language tracks. `:type` is video | images
-- | blog below. There is no `video_approve_both`, and no equivalent special
-- case for image/blog either — BOTH is a two-element requestedLanguages array,
-- for every content type, on one endpoint.
GET    /api/jobs/:jobId/:type                      shared/project status +
                                                    generation + visual-asset
                                                    summary + every requested
                                                    language track and its status
GET    /api/jobs/:jobId/:type/status               lightweight polling/SSE:
                                                    { project: {...},
                                                      tracks: { EN: {...}, FR: {...} } }

-- Video only: approval gates shared generation (script is locked before the
-- expensive character-ref/visual spend — §6.4). Image/blog generate the shared
-- visual immediately, matching current UX, so they have no draft/approve step
-- at the project level — only `/generate` below.
POST   /api/jobs/:jobId/video/draft/regenerate     regenerate the ONE master
                                                    script draft (pre-approval)
PATCH  /api/jobs/:jobId/video/draft                edit the master script's
                                                    draft_data (pre-approval)
POST   /api/jobs/:jobId/video/approve              body: { requestedLanguages:
                                                    ("EN"|"FR")[] }. Approves the
                                                    master script ONCE, enqueues
                                                    the shared visual chain ONCE,
                                                    and creates exactly one
                                                    content_language_tracks row
                                                    per entry in requestedLanguages.
                                                    THIS is what replaces
                                                    EN-only/FR-only/BOTH for video.

-- Image/blog only: no pre-generation approval gate (§6.4) — this one call both
-- starts the shared visual generation AND creates the requested language
-- tracks, which begin generating caption/copy once the shared visual is ready.
POST   /api/jobs/:jobId/:type/generate             body: { requestedLanguages:
                                                    ("EN"|"FR")[] } — same shape
                                                    as video's /approve, just
                                                    without a prior draft/approval
                                                    round-trip on the shared layer.
                                                    THIS is what replaces the
                                                    image-post BOTH bug (§17.4) —
                                                    one bilingual-concatenated row
                                                    becomes two independent tracks.

-- All three content types:
POST   /api/jobs/:jobId/:type/regenerate           body: { scope }. Video: "script"
                                                    | "visuals" (two shared layers).
                                                    Image/blog: "visual" only (one
                                                    shared layer — the photo, or
                                                    the hero+inline images).
                                                    "visuals"/"visual" bumps
                                                    generation and re-runs shared
                                                    generation only — language
                                                    tracks' text/audio/captions
                                                    are untouched; `ready` tracks
                                                    flip to `stale` (§6.5).
POST   /api/jobs/:jobId/:type/tracks               body: { language }. Adds a
                                                    language track AFTER initial
                                                    approval/generation (e.g. EN
                                                    shipped, user now wants FR
                                                    too) without touching the
                                                    existing track or re-running
                                                    shared generation if the
                                                    generation is unchanged.
GET    /api/jobs/:jobId/:type/tracks/:lang/status
POST   /api/jobs/:jobId/:type/tracks/:lang/retry   retries ONLY this track from
                                                    its last failed step; has no
                                                    code path that can write to
                                                    content_visual_assets or touch
                                                    the other language's track —
                                                    see §10.
PATCH  /api/jobs/:jobId/:type/tracks/:lang/draft   image/blog only — edit this
                                                    language's caption/copy draft
                                                    before approving it
POST   /api/jobs/:jobId/:type/tracks/:lang/approve image/blog only — approves
                                                    this language's caption/copy
                                                    (video's track has no separate
                                                    approval step — the script was
                                                    already approved at the shared/
                                                    project level, §6.5).
POST   /api/jobs/:jobId/video/tracks/:lang/render  video only — explicit re-render
                                                    trigger for a `stale` track
                                                    after a visuals-only
                                                    regeneration (auto-enqueued by
                                                    default; exposed for a manual
                                                    "re-render now" UI action).
                                                    Image/blog have no render
                                                    step — a stale track just
                                                    needs re-approval against the
                                                    new shared visual.
GET    /api/jobs/:jobId/:type/tracks/:lang/generated-content

-- Social posts now carry a language dimension for every content type (§17.4):
POST   /api/social-posts                  body: { jobId, contentType, language,
                                           contentLanguageTrackId, caption,
                                           hashtags, platforms }. Creates one post
                                           per language — a BOTH job's approval
                                           flow makes two of these calls (or one
                                           call with two entries), never a single
                                           bilingual post. Replaces /api/social/post.
POST   /api/social-posts/:id/publish      enqueue publish step
GET    /api/social-posts/:id/status
DELETE /api/content/:id                   unchanged shape, now backend-validated

-- Inbound, provider-facing (replaces the single overloaded n8n-callback route):
POST   /api/webhooks/providers/:providerName
                                           per-provider signature verification,
                                           writes to webhook_inbound_events first
                                           (idempotent), then dispatches to the
                                           matching step handler
```

Design notes:
- Splitting the single `n8n-callback` endpoint (which today branches on an untyped `event` string and a separate ad hoc "new format" video-complete shape) into **one endpoint per provider**, each with its own signature verification scheme appropriate to that provider (HMAC, bearer token, etc.), removes the fragile "guess the payload shape" branching seen in the current callback route.
- `/status` is intentionally cheap (no joins beyond pipeline summary) so it can be polled or exposed over SSE for the dashboard's live-update needs, replacing the current three-layer realtime+polling mess (§2.8) with one clear source.
- Every mutating endpoint requires an idempotency key from the client (§10) or derives one server-side — `(jobId, type, "approve"|"generate")`, `(jobId, type, "regenerate", scope, generation)`, `(jobId, type, lang, "retry", attempt)` — the same key shape for every content type now, since the endpoint shapes themselves are uniform.
- **No `video_approve_both`, and no equivalent special case for image or blog either, anywhere in this API.** BOTH is represented purely as a two-element `requestedLanguages` array on one call to one endpoint, for every content type — see §11.

---

## 10. Retry / Idempotency / Recovery Strategy `[RECOMMENDATION]`

**Idempotency**
- Every enqueue derives a deterministic idempotency key, e.g. `pipeline:{pipeline_id}:step:{step_name}:attempt:{n}`. A step handler checks `pipeline_steps` for an existing `succeeded` row with the same key before doing any provider call — this fixes §3.3 (double-fire on double-click/retry).
- Inbound provider callbacks are deduplicated via `webhook_inbound_events.external_event_id` (provider-supplied event/request ID where available, else a hash of the payload) — a callback that arrives twice (network retry from the provider) is processed once.
- User-facing mutating actions (approve, regenerate, publish) require the client to send a request-scoped idempotency token; the API stores the token→result mapping briefly so a retried click returns the original result instead of double-enqueuing.

**Retries**
- Standardized exponential backoff with jitter, per-provider configurable caps (replacing today's inconsistent hardcoded 12/60/200 magic numbers), and a hard **wall-clock budget per pipeline** (e.g. "abandon video generation after 45 minutes total, not per-step") to fix §3.13's uncapped-cost risk.
- Only "retryable" provider errors (timeouts, 5xx, documented rate-limit responses) get automatic retries; "terminal" errors (bad request, invalid credentials, content policy rejection) fail fast into `failed_terminal` instead of being silently retried into an eventual generic timeout as happens today.

**Recovery / crash-safety**
- Because state lives in `pipeline_steps` and the queue, not in an in-memory n8n execution, a worker crash or deploy simply means the in-flight step gets picked up again (either automatically via a queue-visibility-timeout requeue, or via a startup reconciliation job that re-enqueues anything left `running` past a staleness threshold).
- A periodic **reconciliation/sweeper job** scans for pipelines stuck in a non-terminal state past an expected duration and either retries the last incomplete step or marks the pipeline `failed` with a clear reason — this directly replaces today's silent-forever-`generating` failure mode (§3.2).

**Partial failure**
- Partial failure is tracked per **language track**, not per pipeline (there is only one pipeline per job × content_type, for every type now — §17.4) — a failure in the French track of a `BOTH` job doesn't block the English track from completing and being approvable/postable, whether that job is a video, an image post, or a blog post. Today's all-or-nothing behavior (video: "both languages or the job never reaches `ready`"; image: "one bilingual row, no independent failure at all") is replaced uniformly by "the pipeline is `partial_ready`, EN is postable now, FR can be retried independently from wherever it failed, without re-touching the shared visual or the EN track." See §10.1 for exactly how that isolation is enforced, not just intended.

### 10.1 Generation fencing and regeneration scopes — generalized to all three content types

The general idempotency/retry machinery above (deterministic keys, `pipeline_steps` dedup, backoff, wall-clock budgets) applies to every step exactly the same way regardless of content type. What's new here is **generation fencing**, because every content type now has a shared layer where "regenerate" must never let an old in-flight attempt clobber a newer one — this used to be framed as video-specific; per §17.4 it's a property of the shared-project pattern itself, so it applies to image and blog too.

- **`content_pipelines.current_generation`** is an integer, starting at 1, bumped only by an explicit regeneration action — never by a retry. `content_visual_assets` (and, for video, `video_scenes`) rows are tagged with the generation they belong to; every read of "the current shared asset(s)" filters on `generation = content_pipelines.current_generation`, so a slow, still-in-flight step from a superseded generation can finish and write its row, but it writes it as a *past* generation that nothing reads — it cannot silently become "the" character reference, scene clip, photo, or hero image. A step handler additionally checks `WHERE generation = :expected_generation` (optimistic concurrency) before applying any write to these tables; a mismatch means the write is discarded and the step marks itself `superseded`, not `failed` (this is not an error — a newer generation genuinely superseded it).
- **`content_language_tracks.master_generation_used`** records which shared generation a track was (re)started against, for every content type. For video, this is what §6.5's `awaiting_visuals → rendering` transition checks before proceeding. For image/blog, it's what marks a track `stale` when the shared visual regenerates out from under it, even though there's no render step to gate.
- **Regeneration scopes** (surfaced as `POST /api/jobs/:jobId/:type/regenerate { scope }`, §9) — video has two, image/blog have one, because video has two distinct shared layers (script and visuals) and image/blog only have one (the visual itself):
  - **Video `scope: "visuals"`** — script/scenes/durations unchanged; only character reference and/or scene visuals redone. Bumps generation, re-runs the shared visual chain, leaves every language track's audio and captions **untouched**. `ready` tracks flip to `stale` and only need `render` re-run.
  - **Video `scope: "script"`** — the semantic scene plan changed. Bumps generation, invalidates scenes and visuals, **and** resets every language track fully back to `waiting_on_shared`, since audio/captions/duration mapping were all keyed off the old scene plan.
  - **Image/blog `scope: "visual"`** — the photo (or hero/inline images) is redone. Bumps generation, re-runs shared visual generation, leaves every language track's caption/copy text **untouched** — the words didn't change, only the picture did. `ready` tracks flip to `stale`, needing only re-approval against the new asset (no render step to redo).
  - Conflating "regenerate the words" and "regenerate the picture" into one button, for any content type, is the wrong implementation — it would force a full re-caption/re-copy cycle (or, for video, a full re-transcription/re-audio cycle) for a pure visual tweak, burning cost and time for zero reason. The API and state machines deliberately keep these separate for every content type.
- **Retrying a language track never regenerates the shared asset — structurally, not just by convention, for any content type.** `POST .../tracks/:lang/retry` only ever enqueues jobs under the `content:{pipeline_id}:track:{lang}:*` queue namespace (§7.1); the retry handler for a track step has no reference to the shared-generation step handlers (`generate_character_ref`/`generate_scene_visual`/`generate_photo`/`generate_hero_image`) or to the `content_visual_assets` table's write path at all — they live in different modules under `queue/steps/` (§12). This is deliberately a code-structure guarantee, not a runtime check that could be bypassed by a future bug.
- **For `BOTH` concretely, on any content type:** two `content_language_tracks` rows exist, each with its own `master_generation_used`, `retry_count`, and queue namespace, both pointing at the same `content_pipeline_id`. Retrying FR touches only the FR row and FR-namespaced queue jobs; retrying EN touches only the EN row and EN-namespaced queue jobs. A shared-asset regeneration bumps the one shared `current_generation` and marks *both* tracks `stale` if they were `ready` — both then independently re-render (video) or re-approve (image/blog) against the new asset, but neither re-runs localization/caption/copy generation from scratch.

---

## 11. EN / FR / BOTH Design `[RECOMMENDATION]`

**This section is a full rewrite, unified across all three content types (§17.4) — not a video-specific pattern with blog/image left alone.** The prior revision's model for blog/image ("BOTH creates two independent pipelines that happen to run in parallel") turned out, per the live-database audit, to not even be what's actually implemented — real `BOTH` image posts are one row with two languages' captions concatenated into a single string. And even the *intended* "two independent pipelines" model would have been wrong for image/blog once you look closely: an image post's photo and a blog's hero/inline images are exactly the kind of shared, language-independent asset that video's character reference and scene clips are — two independent pipelines would have no shared place to put that photo, so each would generate its own. All three content types now use one architecture.

### 11.1 One architecture, N requested language tracks — for video, image, and blog alike

- A job for any content type — EN-only, FR-only, or BOTH — creates **exactly one** `content_pipelines` row (`language=NULL`, for every type now) and its shared generation happens **once**, always. The number of requested languages never changes how many pipelines exist.
- What varies is only the number of `content_language_tracks` rows: **one** for EN-only or FR-only, **two** for BOTH. This is the single knob that represents "how many language variants were requested" — everywhere else in the system (schema, queue, state machines, API) is identical regardless of that count, for video, image, and blog.
- The shared layer — video's script+scenes+character-ref+clips, image's photo, blog's hero+inline images — is generated once, **before** any language-specific branching exists at all. Language enters the picture only at the localization step (video: `localize_script`; image: `generate_caption`; blog: `generate_copy`), which takes the approved/ready shared content and produces the actual EN or FR output — never a second call to the shared-generation model in a different language. This is precisely how today's forced-French "FR —" video branch (§2.2) and the image-post BOTH bilingual-concatenation (§17.4) both happen, from the same root cause, and both are fixed the same way.
- Concretely, at approval/generation time (`POST /api/jobs/:jobId/video/approve` or `POST /api/jobs/:jobId/:type/generate` for image/blog, §9): `requestedLanguages: ["EN"]` creates one track; `["FR"]` creates one track; `["EN","FR"]` creates two tracks, in the same call, against the same pipeline. **There is no separate code path, workflow, or endpoint for BOTH, for any content type** — it is not a third case to implement, test, or maintain; it is what happens when the array has two elements instead of one. §3.7's dead/broken `video_approve_both` webhook type is retired entirely, not replaced by an equivalent special case for any type.
- Because tracks are independent rows with independent queue namespaces (§7.1) and independent generation fences (§10.1), EN-only, FR-only, and BOTH are exercised by literally the same step handlers, workers, and state machine — BOTH just happens to have two track rows executing concurrently instead of one, for video, image, or blog. This is also why testing BOTH (§14) doesn't require a separate suite per content type: it's the same tests as EN-only and FR-only, run with two tracks instead of one, plus a small number of tests specific to their interaction (same shared-asset ID used by both languages, independent failure, independent retry — see §14).
- Job-level aggregate status (§6.2) is unaffected by this rewrite in shape — "ready" once every requested unit is ready, "partial_ready" otherwise — but that "unit" is now a language track, not a pipeline, for every content type, not just video.
- **Social posting follows the same knob, one level up** (§6.6/§17.4): a `BOTH` job's approval flow, once both language tracks reach `ready`, can create up to two `social_posts` rows — one per language, each referencing its own `content_language_track_id` — so EN and FR are independently postable, retryable, and failable at the publishing layer too, not just at the content-generation layer.

---

## 12. Recommended Backend Folder Structure `[RECOMMENDATION]`

```
backend/
├── src/
│   ├── api/                        # HTTP layer only — thin controllers
│   │   ├── routes/
│   │   │   ├── jobs.ts
│   │   │   ├── pipelines.ts
│   │   │   ├── drafts.ts
│   │   │   ├── social-posts.ts
│   │   │   └── webhooks/
│   │   │       ├── openai.ts       # if OpenAI ever calls back (unlikely; here for symmetry)
│   │   │       ├── elevenlabs.ts
│   │   │       ├── assemblyai.ts
│   │   │       ├── kie.ts
│   │   │       └── upload-post.ts
│   │   └── middleware/
│   │       ├── auth.ts
│   │       ├── idempotency.ts
│   │       └── requestValidation.ts
│   │
│   ├── domain/                     # pure business logic, no I/O
│   │   ├── job/
│   │   │   ├── job.entity.ts
│   │   │   ├── job.stateMachine.ts
│   │   │   └── job.service.ts
│   │   ├── pipeline/
│   │   │   ├── pipeline.entity.ts
│   │   │   ├── pipeline.stateMachine.ts
│   │   │   └── pipeline.service.ts
│   │   ├── content/                 # NEW, generalized (§17.4) — the shared-pipeline
│   │   │   │                          / language-track split, used by video, image,
│   │   │   │                          AND blog, not a video-only module anymore
│   │   │   ├── contentPipeline.entity.ts
│   │   │   ├── contentPipeline.stateMachine.ts     # §6.4
│   │   │   ├── contentPipeline.service.ts          # owns generation fencing, §10.1
│   │   │   ├── contentLanguageTrack.entity.ts
│   │   │   ├── contentLanguageTrack.stateMachine.ts  # §6.5
│   │   │   └── contentLanguageTrack.service.ts
│   │   ├── video/                   # video-only extensions on top of content/ —
│   │   │   │                          the scene decomposition + audio/caption
│   │   │   │                          concepts image/blog don't need
│   │   │   ├── videoScene.entity.ts
│   │   │   ├── videoSceneAudio.entity.ts
│   │   │   └── videoCaption.entity.ts
│   │   ├── draft/
│   │   ├── generatedContent/
│   │   └── social/                  # social.entity.ts now models one post per
│   │                                  # (job, content_type, language) — §6.6/§17.4
│   │
│   ├── providers/                  # adapters, §8
│   │   ├── contracts/              # the Provider interfaces themselves
│   │   ├── openai/
│   │   ├── elevenlabs/
│   │   ├── assemblyai/
│   │   ├── kie/
│   │   ├── uploadPost/
│   │   └── storage/                # Supabase Storage or S3 adapter
│   │
│   ├── queue/
│   │   ├── queueClient.ts
│   │   ├── stepRunner.ts           # generic retry/backoff/idempotency wrapper
│   │   └── steps/                  # one file per queued step type
│   │       ├── generateScript.ts            # video — [ONCE], §4.2 step 2 (now
│   │       │                                  includes scene planning, §17.1)
│   │       ├── generateCharacterRef.ts       # video — [ONCE], §4.2 step 3
│   │       ├── generateSceneVisual.ts        # video — [ONCE, fanned per scene], §4.2 step 4
│   │       ├── generatePhoto.ts              # NEW — image's shared step, [ONCE]
│   │       ├── generateHeroImage.ts          # NEW — blog's shared step, [ONCE]
│   │       ├── generateInlineImages.ts       # NEW — blog's shared step, [ONCE, fanned]
│   │       ├── localizeScript.ts             # video — [PER LANGUAGE], §4.2 step 6a
│   │       ├── generateCaption.ts            # NEW — image's per-language step, [PER LANGUAGE]
│   │       ├── generateCopy.ts               # NEW — blog's per-language step, [PER LANGUAGE]
│   │       ├── synthesizeVoice.ts            # video-only — [PER LANGUAGE], called
│   │       │                                   only by video-track step handlers;
│   │       │                                   image/blog have no audio concept
│   │       ├── transcribeAudio.ts            # video-only — [PER LANGUAGE]
│   │       ├── renderLanguageTrack.ts        # video-only — RENAMED from
│   │       │                                   renderVideo.ts — [PER LANGUAGE],
│   │       │                                   §4.2 step 7; the only step handler
│   │       │                                   allowed to read BOTH
│   │       │                                   content_visual_assets AND a track's
│   │       │                                   audio/captions
│   │       ├── mergeAudioVideo.ts            # video-only
│   │       └── publishSocialPost.ts
│   │       -- Deliberately: no step handler under generateCharacterRef.ts,
│   │       -- generateSceneVisual.ts, generatePhoto.ts, generateHeroImage.ts, or
│   │       -- generateInlineImages.ts imports anything from a track-scoped module
│   │       -- (localizeScript/generateCaption/generateCopy/synthesizeVoice/
│   │       -- renderLanguageTrack), for ANY content type, and vice versa — this
│   │       -- is what makes §10.1's "retrying a language track cannot regenerate
│   │       -- the shared asset" a compile-time/code-review-visible fact, not just
│   │       -- a runtime check, uniformly across video, image, and blog.
│   │
│   ├── workers/                    # process entry points that pull from the queue
│   │   ├── scriptWorker.ts
│   │   ├── sharedVisualWorker.ts    # NEW, generalized — pulls only
│   │   │                              content:*:project:* queue keys, for
│   │   │                              video, image, AND blog (§7.1)
│   │   ├── contentTrackWorker.ts    # NEW, generalized — pulls only
│   │   │                              content:*:track:* queue keys except
│   │   │                              video's render step (below), for all
│   │   │                              three content types
│   │   ├── renderWorker.ts          # video-only — the render step specifically
│   │   │                              gets its own pool per §7.1's concurrency note
│   │   └── socialWorker.ts
│   │
│   ├── infra/
│   │   ├── db/                     # migrations, query builder/ORM setup
│   │   ├── secrets/                # credential retrieval, §9
│   │   ├── logging/
│   │   └── reconciliation/         # the sweeper job from §10
│   │
│   └── config/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/                   # recorded provider responses for adapter tests
│
└── migrations/
```

Frontend (`FRESH-CAN-main`) stays as its own repo/deployment; it's updated to call the new backend API instead of Supabase directly and n8n webhooks (§13), but its page structure, components, and Zustand stores largely survive.

### 12.1 Frontend changes for the shared-pipeline / language-track model — now applies to video, image, and blog (§17.4)

This does **not** require a frontend rewrite — it's a change to what each content type's tab renders and which contentService calls back it, not a new page structure.

- **Video's draft/approval step in `/dashboard/jobs/[id]`** currently reuses the same `DraftEditor` component per language (an EN tab and an FR tab, each editing its own draft). Under this model there is only **one** master script draft to review and approve, so this becomes a single `DraftEditor` instance with no language toggle — simpler than today, not more complex. The recent EN/FR draft-editing toggle (`getEffectiveLanguage` and per-language draft keys) is removed from video's *draft/approval* step specifically. Image and blog have no equivalent pre-generation draft step to change (§6.4) — they keep generating immediately, as today.
- **Every content type's post-generation view needs two visually distinct progress regions instead of one:**
  - A **shared "Production" section** per content type (§6.4): video shows script approved / character reference / "6/8 scenes rendered"; image shows the one photo's status; blog shows hero + inline image status. This section has no language selector — it's the same for every viewer regardless of which languages were requested.
  - One **language-track card per requested track** (§6.5) — reusing the existing `SocialApprovalCard`-style card pattern already in the codebase — each showing that track's own status, current step, and a **retry button scoped to that track only** (`POST .../:type/tracks/:lang/retry`). For a `BOTH` job this is two cards, EN and FR, rendered side by side, for any content type; for EN-only or FR-only it's just the one card — same component, same code path, per §11. Image/blog's cards additionally carry the existing draft/edit/approve controls for that language's caption or copy (§6.5), since — unlike video's track — they still have their own per-language approval step.
  - If the shared layer fails, all track cards show a blocked state (nothing can proceed without the shared asset) rather than their own spinner — the UI should make the shared dependency visible, for every content type, not just show independent-looking spinners secretly gated on a third thing the user can't see.
  - If a shared-asset regeneration is triggered, ready track cards flip to a "stale — needs re-render" (video) or "stale — review against new image" (image/blog) state with the relevant CTA, without re-showing the draft/approval flow.
- **The EN/FR toggle on the video library card** (recent commit `add EN/FR toggle to video library cards`) is still correct and stays — that toggle is about choosing which **final output** to preview/post, which is still genuinely per-language under this model, and the same toggle now makes sense on image/blog library cards too (they didn't have one, since there was previously only one bilingual-mashed row to show). It should be double-checked, though: if it (or the recent `wire up Both video workflow to app` commit) was built against the old "two independent pipelines" assumption, that call site needs to be repointed at the new `/:type` and `/:type/tracks/:lang` endpoints during migration (§13), not left as-is.
- **Social posting UI needs a per-language post action, for every content type**, not just a single "post" button per job × content_type — since `social_posts` now supports one row per language (§6.6/§17.4), the approval/posting screen needs to show (and let the user independently trigger) an EN post and an FR post once each language's content track is `ready`, rather than assuming there's exactly one thing to post.
- **Realtime/polling source changes**, consistent with §2.8/§9: each content type's tab subscribes to (or polls) `GET /api/jobs/:jobId/:type/status`, not `content_drafts` twice and a separate per-language poll — replacing that page's most tangled piece of state management with one clear source per §9's design notes.
- **`contentService.ts`** gains generalized `getContentPipelineStatus(jobId, type)`, `retryContentTrack(jobId, type, lang)`, `regenerateSharedContent(jobId, type, scope)`, and `generateOrApproveContent(jobId, type, requestedLanguages)` functions — replacing the type-specific branches of today's `regenerate`/`draft`/`n8n/trigger` calls for video, image, AND blog, plus a `language` parameter added to the existing social-posting calls.

---

## 13. Incremental Migration Plan (n8n → Backend) `[RECOMMENDATION]`

A strangler-fig approach — run the new backend alongside n8n and cut over one pipeline at a time, so the dashboard never goes down and each cutover is independently verifiable.

**Phase 0 — Groundwork (no user-visible change)**
1. Reconcile the *actual* live Supabase schema against `database.ts` (§3.6) and against the n8n export — resolve the `video_approve_both`/`image_approve`/`blog_approve` mystery (§3.7) by checking the live n8n instance for workflows not included in this export.
2. Stand up the new Postgres tables (§5) alongside the existing ones; backfill `content_pipelines`/`pipeline_steps` from existing `content_jobs`/`content_drafts` history for continuity of the Library view.
3. Build the provider adapters (§8) and unit-test them against recorded fixtures — no production traffic yet.

**Phase 1 — Take over the callback/ingestion layer**
4. Replace the single `/api/webhooks/n8n-callback` with the per-provider structure (§9), but initially still fed by the *existing* n8n workflow (n8n keeps running exactly as today, just posting into the new, better-typed endpoints). This alone fixes the schema-drift and weak-auth issues (§3.4, §3.6) without touching the generation logic yet.

**Phase 2 — Cut over the simplest pipeline first: Blog**
5. Blog is the smallest, most self-contained pipeline (2 agents + fallback-safe image gen) and is already architecturally the odd one out (§3.8), making it the best low-risk first migration target. Re-implement it as backend workers using the OpenAI + KIE.ai adapters, structured as the shared-pipeline/language-track split from the start (§5/§17.4) — `generateHeroImage`/`generateInlineImages` as [ONCE] shared steps writing `content_visual_assets`, `generateCopy` as a [PER LANGUAGE] step per `content_language_tracks` row. This is also where blog's hero/inline images move off the third-party ephemeral tempfile host onto permanent storage (§5's storage-path note) — they were never migrated to Supabase Storage the way video/image are, so this needs to happen as part of this cutover, not be inherited as-is. Point the dashboard's blog trigger at the new `/api/jobs/:jobId/blog/generate` endpoint (§9); leave video/image/social on n8n.
6. Run both in parallel for a verification window (feature-flag per job or per percentage) before fully retiring the n8n blog branch. Verify with a real `BOTH` test job that exactly one hero/inline image set exists and two independent `content_language_tracks` rows (not one bilingual-concatenated row, per §17.4) are produced.

**Phase 3 — Image pipeline**
7. Similar cutover for `image_questions` + `image_post`, same shared-pipeline/language-track structure: `generatePhoto` as the [ONCE] shared step, `generateCaption` as the [PER LANGUAGE] step. This directly fixes the confirmed live bug (§17.4) where a `BOTH` image post produces one `generated_content` row with EN and FR captions concatenated in a single string — after this phase, it produces one shared photo plus two independent, independently-approvable/retryable caption tracks. Verify with a real `BOTH` test job that the photo `content_visual_assets` row is the same one both language tracks reference.

**Phase 4 — Social publishing**
8. Migrate the social/upload-post.com publishing flow — moderate complexity, but isolated from video/image generation, and directly benefits from the new per-platform state tracking (§6.6). This is also where `social_posts` gains its `language`/`content_language_track_id` columns and the `UNIQUE(job_id, content_type)` constraint is widened to `UNIQUE(job_id, content_type, language)` (§5/§17.4) — do this alongside Phase 2/3's blog/image cutover, since social posting for a `BOTH` job only makes sense once blog/image can actually produce two independent language tracks to post from.

**Phase 5 — Video (highest complexity, migrate last)**

**Mapping today's n8n steps onto shared vs. language-specific (do this mapping explicitly before writing any code — it's the whole point of this revision):**

| Today's n8n step (§2.2) | New home |
|---|---|
| OpenAI agent generates script; fix domain spelling; parse `script_parts` | **[ONCE]** → `generateScript` step, writes the one `content_drafts` row for the project |
| "FR —" branch: forced-French script regeneration, gated by `IF — Run Secondary Language?` | **RETIRED — do not migrate this branch at all.** It is replaced by `localizeScript` (§4.2 step 6a), a [PER LANGUAGE] step that translates the *already-approved* scene plan's narration intent, not a second call to the script-generation model. Porting this branch forward as-is would faithfully reproduce the exact bug this revision exists to fix. |
| Get ElevenLabs voice ID → generate character reference image via KIE.ai (currently *inside* the per-language loop) | **[ONCE]** → pulled OUT of the per-language loop entirely, becomes `generateCharacterRef`, writes one pipeline-level `content_visual_assets` row |
| Generate per-scene images/video via KIE.ai (currently *inside* the per-language loop) | **[ONCE]** → pulled OUT of the per-language loop entirely, becomes `generateSceneVisual`, fanned out per scene, writes `content_visual_assets` rows keyed by scene, not by language |
| Generate per-scene audio via ElevenLabs | **[PER LANGUAGE]**, unchanged in spirit → `synthesizeVoice`, now reading from `video_scene_audio` |
| Submit to AssemblyAI, build captions | **[PER LANGUAGE]**, unchanged in spirit → `transcribeAudio`, now writing `video_captions` |
| Build FFmpeg merge job via upload-post.com, poll, download, upload | **[PER LANGUAGE]** → `renderLanguageTrack`, but now consuming the SHARED `content_visual_assets` rows (read-only) plus this track's own audio/captions — this is the step that changes shape the most, since today it's the point where a language-specific visual generation call happened right before the merge; now the visual is already sitting in storage, generated once, and this step only composites |
| "Both EN and FR rows exist in `generated_content`" gate for job `ready` | **RETIRED as a special check** — replaced by the generic §6.2 aggregate rule ("ready" once every row in `content_language_tracks` for the pipeline is `ready`), which already handles 1 or 2 tracks identically |
| `video_approve_both` webhook type (§3.7, likely already broken) | **RETIRED** — replaced by `requestedLanguages` on the single `/video/approve` endpoint (§9) |

**Sub-stages, in order (each independently verifiable, dashboard stays up throughout):**
9. **5a — Script + approval.** Migrate `generateScript` (now including scene planning, §17.1) and the single approval gate. At this point in the migration, video drafts are created and approved through the new backend, but generation (character ref/visuals/audio/render) still happens on the old n8n path — verify the new draft/approval flow produces output n8n's old per-language-loop generation step can still consume, as a bridge.
10. **5b — Shared visual chain.** Migrate `generateCharacterRef` and `generateSceneVisual` as [ONCE] steps writing to `content_pipelines`/`video_scenes`/`content_visual_assets`. This is the highest-value, highest-risk sub-stage: verify with a manual BOTH-language test job that exactly one character-reference row and one set of scene-visual rows are created, and that no code path in this sub-stage is reachable from a per-language trigger. Do not proceed to 5c until this is confirmed with a real BOTH job, not just EN-only.
11. **5c — Per-language audio + captions.** Migrate `synthesizeVoice`/`transcribeAudio` as [PER LANGUAGE] steps against `content_language_tracks`/`video_scene_audio`/`video_captions`, still reading approved narration from step 5a's output via the new `localizeScript` step (this is also where the forced-French branch gets formally retired, not carried forward).
12. **5d — Render.** Migrate `renderLanguageTrack` last, since it's the longest-running, highest-current-risk step (§3.1) and the one that depends on both 5b and 5c being correct. Cut over the render step, then the `POST /video/approve`, `/video/regenerate`, and `/video/tracks/:lang/retry` endpoints (§9), retiring `video_approve_both` at this point.
13. Only after video is fully migrated and stable, decommission the n8n instance (or keep it solely for any workflows genuinely outside this system's scope, if such exist).

**Explicit warning:** the biggest risk in this phase is treating it as a lift-and-shift of the existing n8n branch structure into workers. The existing structure — character-ref and scene-visual generation living *inside* the `for each language required` loop — is the bug. Migrating it faithfully, just moving the same loop into a TypeScript worker, would reproduce today's "EN and FR can get different visuals" defect in the new system instead of fixing it. The migration must restructure step order (pull shared steps out of the per-language loop, per the mapping table above) as part of the cutover, not as a follow-up.

**Throughout:** keep the existing n8n webhook secret verification and dual endpoints running until each phase's traffic is fully cut over, so a rollback is always just "point the trigger back at n8n."

---

## 14. Testing Strategy `[RECOMMENDATION]`

- **Provider adapters:** unit tests against recorded HTTP fixtures (success, pending, rate-limited, malformed-response, timeout) for every adapter in §8 — this is currently impossible to test at all in the n8n version, since the logic lives inside Code nodes tightly coupled to live HTTP calls.
- **State machines:** pure unit tests for the pipeline and step state machines (§6) — every legal and illegal transition, especially the aggregate job-status projection logic, which is exactly the kind of thing that's easy to get subtly wrong (as evidenced by the current system's `0 >= 0` off-by-one bug that a code comment shows was already found and patched once in the callback route).
- **Idempotency:** tests that fire the same enqueue/webhook twice and assert exactly one side effect — directly targeting §3.3/§10.
- **Integration tests:** spin up a test Postgres + in-memory/test queue, run a full pipeline end-to-end against mocked provider adapters (not real APIs), asserting the full happy path and at least one failure-and-retry path per pipeline type.
- **Chaos/recovery tests:** kill a worker mid-step and assert the reconciliation sweeper (§10) picks the step back up without duplicating provider calls — this is the test that directly proves crash-recovery actually works, which nothing in the current system could even attempt to test.
- **Contract tests for inbound webhooks:** since providers occasionally change payload shapes, snapshot-test the parsing/normalization layer against both current and known-historical payload shapes (the current codebase already shows evidence of this happening once — the "new format: video-approve workflow completion" vs. "legacy format" branching in the existing callback route).
- **Frontend:** since the dashboard's data-fetching contract changes (client stops writing to Supabase directly), add integration tests around `contentService`-equivalent calls against the new API, and manual/E2E smoke tests per migration phase (§13) before flipping traffic.

### 14.1 Shared-pipeline / language-track tests — now for video, image, AND blog (§17.4)

These are integration tests against the real state machines (§6.4/§6.5) and generation fencing (§10.1) with mocked provider adapters — not just unit tests of individual steps, since the property being verified is cross-step and cross-table. Video's list below is written out in full since it has the most moving parts (audio/captions/render); image and blog run the structurally identical set with fewer steps involved, called out at the end rather than repeated in full.

- **EN-only:** approve/generate with `requestedLanguages: ["EN"]` → exactly one `content_language_tracks` row is created; shared generation runs once; job reaches `ready` once EN's track is `ready`.
- **FR-only:** same, with `["FR"]` — verifies there's no hidden EN-first assumption anywhere in the shared chain or the render step.
- **BOTH:** approve/generate with `["EN","FR"]` → exactly two `content_language_tracks` rows, exactly one `content_pipelines` row, exactly one character-reference asset and one set of scene-visual assets (assert row counts, not just "it completed").
- **Same shared asset IDs used by EN and FR:** for a BOTH job, assert that the `content_visual_assets` rows read by EN's `renderLanguageTrack` step and FR's `renderLanguageTrack` step are literally the same rows (same IDs), not just visually similar output — this is the test that would have caught today's bug.
- **FR failure while EN succeeds:** force FR's `generate_audio` (or any track step) to fail terminally; assert EN's track still reaches `ready`, the pipeline reaches `partial_ready`, and no write was attempted against `content_visual_assets` as part of FR's failure/retry handling.
- **EN failure while FR succeeds:** mirror of the above, in the other direction (don't just test one direction and assume symmetry — the render step's precondition check has historically been the kind of thing that's accidentally asymmetric).
- **Retrying FR without regenerating the shared asset:** fail FR, retry it, assert `content_visual_assets.generation` and row count are unchanged before/after the retry, and assert no `generate_character_ref`/`generate_scene_visual` job was enqueued as a side effect of the retry.
- **Retrying EN without regenerating the shared asset:** mirror of the above.
- **Shared-visual regeneration causing both tracks to become stale:** with two `ready` tracks, call `regenerate { scope: "visuals" }`; assert `content_pipelines.current_generation` incremented, both tracks transition to `stale`, and — critically — both tracks' `video_scene_audio`/`video_captions` rows are byte-for-byte unchanged (proves audio/captions weren't touched by a visuals-only regen).
- **Different EN/FR narration durations using the same visual assets:** synthesize EN and FR audio with deliberately different total durations (e.g. mocked TTS returns different `duration_ms` per language for the same scene) against the same `content_visual_assets` row; assert both tracks render successfully and the render step's duration-reconciliation logic (§4.2) is exercised, not skipped.
- **Duplicate approval/generation requests:** call `POST /video/approve` twice in quick succession with the same `requestedLanguages`; assert exactly one `content_pipelines` row and exactly the right number of `content_language_tracks` rows exist afterward (not two of each) — directly targeting §10's idempotency-token mechanism.
- **Worker crash during shared visual generation:** kill a worker mid-`generate_scene_visual` (say, scene 3 of 8); assert the reconciliation sweeper (§10) picks scene 3 back up without re-running scenes 1-2, without duplicating the KIE.ai call for scene 3, and without ever incrementing `content_pipelines.current_generation` (a crash is not a regeneration).
- **Worker crash during a language-specific step:** kill a worker mid-`transcribe_captions` for FR; assert FR resumes from that step on restart, EN (if running concurrently) is completely unaffected by the crash, and the shared visual assets are untouched.

**Image and blog run the same set of tests above**, substituting `generatePhoto`/`generateCaption` (image) or `generateHeroImage`+`generateInlineImages`/`generateCopy` (blog) for video's shared/track steps, with the render-specific and duration-specific tests dropped (no render step, no audio duration concept for either type) and one test added that's specific to the bug that motivated fixing them:
- **BOTH image/blog produces two independent rows, not one bilingual-concatenated row:** approve/generate with `["EN","FR"]`, assert two `generated_content` rows exist, each with a single-language `output_data.caption` (or blog body), and assert neither contains a `" / "`-joined bilingual string — this is the regression test for the exact live-data defect found in §17.4's audit.

---

## 15. Top 10 Implementation Tasks (in priority order) `[RECOMMENDATION]`

1. **Resolve the `video_approve_both` / `image_approve` / `blog_approve` mystery** (§3.7) against the live n8n instance — this blocks trusting any of the current BOTH-language video approval or blog/image approval webhook flows.
2. **Reconcile live Supabase schema vs. `database.ts`** (§3.6) — generate real types from the live DB before building anything else on top of it.
3. **Fix the callback authorization gap** (§3.4) immediately, independent of any migration — require `N8N_WEBHOOK_SECRET` to be set (fail closed, not open) and rotate the currently-leaked hardcoded secret.
4. **Fix the two-domain callback mismatch** (§3.5) — verify which Vercel deployment is actually production and correct the "post complete" callback URL.
5. **Stand up `content_pipelines` / `pipeline_steps` tables** (§5) and backfill from existing data, without yet changing any generation logic.
6. **Build the generic step-runner (queue + retry/backoff/idempotency wrapper)** (§7, §10) — the reusable piece that eliminates the ~10 duplicated retry-loop copies.
7. **Build provider adapters for OpenAI, KIE.ai, ElevenLabs, AssemblyAI, and upload-post.com** (§8), unit-tested against fixtures.
8. **Migrate the Blog pipeline end-to-end** (§13 Phase 2) as the proof-of-concept cutover, including its approval flow, to validate the whole new stack on the lowest-risk pipeline.
9. **Replace the single overloaded `/api/webhooks/n8n-callback` with per-provider endpoints + idempotent event logging** (§9, §10).
10. **Add the reconciliation/sweeper job** (§10) so stuck pipelines surface as `failed` with a real reason instead of hanging forever — this alone fixes the single worst user-facing symptom of the current system (§3.2) and can be deployed even before the full worker migration is complete, by having it also watch/timeout current n8n-backed jobs during the transition.
11. **Design and stand up the generalized shared-pipeline schema** (`content_pipelines`/`content_visual_assets`/`content_language_tracks`, plus video's `video_scenes`/`video_scene_audio`/`video_captions` extensions, §5) **before** starting Phase 2/3/5's blog/image/video migrations (§13) — this has to exist and be tested in isolation first, because retrofitting it after any content type's logic is already half-migrated into a flat per-language shape is exactly how the EN/FR divergence bug (confirmed live for image, §17.4) would get quietly reintroduced.

---

## 16. What Changed From the Original Architecture, and Why

The original architecture (§4–§15 above, prior to this revision) treated **every** content type — blog, image, and video — as "one job → N pipelines, one per `(content_type, language)`." That's correct for blog and image, where each language's generation is genuinely independent end to end. It is **wrong for video**, because it implicitly allows EN and FR to each independently drive character-reference generation and scene visual generation — which is precisely how today's n8n workflow already produces (or risks producing) different scenes/characters/environments per language, per the requirement that triggered this revision.

**What changed, concretely:**

1. **New entities, video only:** `video_projects`, `video_scenes`, `video_visual_assets`, `video_language_tracks`, `video_scene_audio`, `video_captions` (§5). `content_pipelines` is now a thin 1:1 wrapper around a video project for `content_type='video'`, instead of one row per language.
2. **Two state machines instead of one, for video:** a master state machine (§6.4) governing script/scene/visual generation, and a language-track state machine (§6.5) governing localization/audio/captions/render — with an explicit, checked dependency (`visuals_ready` + generation match) between them, instead of one flat per-language pipeline state machine trying to represent both.
3. **The video pipeline step sequence was restructured, not just re-hosted** (§4.2): character-reference and scene-visual generation moved from *inside* a per-language loop to *before* any language branching exists at all. Translation moved from "regenerate the whole script in French" to "localize the already-approved, language-neutral scene plan" — a smaller, safer, and structurally different operation.
4. **Queueing gained a shared-vs-track namespace split** (§7.1): shared steps are keyed by project+generation only, language-track steps by project+language+generation, so there is no queue key under which a language dimension could cause a shared step to run twice.
5. **Idempotency gained generation fencing** (§10.1), a concept that didn't exist in the original design: `current_generation` on the project, tagged generations on scenes/visuals, and `master_generation_used` on each track, plus two distinct regeneration scopes (`visuals` vs `script`) with deliberately different blast radii — this is what makes "retry FR without regenerating visuals" and "master regen makes both tracks stale without touching their audio" enforceable facts rather than intentions.
6. **The API's video surface was redesigned around one project + N tracks** (§9), retiring `video_approve_both` entirely rather than preserving it as a special case — BOTH is now just a two-element array on the same endpoint EN-only and FR-only use.
7. **§11 (EN/FR/BOTH) was rewritten, not patched:** the original "BOTH creates two independent pipelines" model is exactly the shape that would have reproduced the bug this revision fixes; it's now "BOTH creates two language tracks against one shared project." (This item was originally scoped to video only, with blog/image called out as unaffected — §18 records why and how that changed.)
8. **The folder structure, migration plan, and testing strategy were all updated in step** (§12.1, §13 Phase 5, §14.1) so the code-level module boundaries, the n8n-to-worker mapping, and the test suite all enforce the same shared/language split the schema and state machines define — a migration that just relocated the existing per-language loop into TypeScript workers would have shipped the same bug in a new language, which is why §13 calls that out explicitly as the wrong way to do this migration.

**What did *not* change:** the overall philosophy from §4 (queue + worker + provider-adapter, Postgres as source of truth, n8n removed from the critical path), the provider choices (§8), the social publishing model (§6.6), and the phased/strangler-fig migration approach (§13's phase ordering is unchanged; only Phase 5's internal content changed).

**Correction (post-audit, and now fully resolved — see §18):** §11.1 originally claimed blog/image are "unaffected — no shared-visual constraint applies to them." Live production data disproved that: a real `BOTH`-language `generated_content` row for an image post has EN and FR captions concatenated into one string field (`"...winter. / Trop de familles..."`), not two independent rows as originally assumed. Rather than leave that as a known-but-deferred gap, it was pulled into this same pass — §18 covers the full rewrite that resulted.

**One thing worth flagging back to you:** the recommended sequencing in §4.2 (localization/audio/captions starting right after script approval, in parallel with shared visual generation, rather than strictly after `visuals_ready`) is a deliberate deviation from the literal linear diagram in the original request. It's a strict improvement — same dependency semantics, less wall-clock time — but it's a design choice worth confirming you're fine with, since the request's diagram implied a stricter linear ordering than the dependency graph actually requires.

---

## 17. Decisions Resolved From the Live-Database Audit (2026-09-07)

This section records the 12 open decisions from the prior review, classified by who can resolve them, with the evidence-backed ones resolved here rather than left as open questions. See the chat response accompanying this revision for the full reasoning behind each classification — this section only records the outcomes so the doc stays self-contained.

### 17.1 Resolved directly in the pipeline/state-machine design (no schema impact)
- **Scene/shot planning merges into script generation** (§4.2 step 2, §6.4) — real draft data shows scenes are already produced in the same generation call as the script, before approval; the doc's prior 3-step split didn't match reality and added an unneeded round-trip.
- **BOTH-language video has no known-good production baseline to preserve** — every sampled `generated_content` row for video is `EN` or `FR` individually; zero `BOTH` rows exist. The design is free to define BOTH's behavior from first principles; there is no backward-compatibility constraint or "it used to work like X" case to accommodate.

### 17.2 Resolved as schema/technical decisions (recorded inline in §5) — updated by §18 to apply to all three content types
- Partial unique indexes replace relying on NULL semantics for the one-master-draft (video) / one-draft-per-track (image, blog) and one-output-per-track invariants.
- Video's storage path convention (`freshcan-videos/{job_id}/{language}.mp4`) is now specified; historical files are left untouched. Blog's hero/inline images move off their third-party ephemeral host onto permanent storage as part of the same pass (§18).
- `generated_content.status = 'completed'` is preserved as a fixed terminal string because a live RLS policy (`"Public read completed"`) keys off that exact literal; `quality_flag` is additive.
- `pipeline_steps` becomes the canonical retry/attempt log; `social_platform_logs.retry_count`/`last_retry_at` stay as a denormalized read cache rather than being replaced.

### 17.3 Deferred — do not block finalizing the architecture
- **Promoting `content_drafts`/`generated_content`'s free-text `status`/`language` columns to real Postgres enums** — this was coupled to whether blog/image's `BOTH` handling gets fixed, which is now resolved (§18). It's still deferred, but for a simpler reason now: it's a database-hygiene cleanup with no product-facing consequence, and can happen any time after the shared-pipeline model ships without blocking it. The live `generated_content.language = 'BOTH'` value should stop being written once §18 ships (every row becomes genuinely single-language), so this becomes a pure cleanup, not a decision entangled with an open product question.
- **The topic mismatch between the EN and FR drafts sharing a `job_id`** (`"Food Deserts in Calgary"` vs. `"Food desert both test"`) is a live-data anomaly worth understanding, but the new architecture structurally prevents its recurrence regardless of root cause — every language track now reads from one shared `content_pipelines` row fed by one job's input, so there's no code path left for them to diverge on topic. Worth a look for data hygiene, not a design blocker.
- **The `authenticated`-role RLS / custom-HMAC-auth mismatch** is a real, current-state question worth resolving as a standalone security item (independent of this redesign), but the target architecture (§4) already routes all mutating writes through the backend API rather than client-side Supabase calls — so whatever the current mystery's answer, the new design doesn't depend on client-side RLS for correctness. Doesn't gate schema work.

### 17.4 Product decisions made (2026-09-07) — full rewrite recorded in §18
Two decisions from §17.3's original "needs your input" list were resolved by you directly, not inferred from evidence:
1. **Blog and image's `BOTH`-language handling is fixed in this same pass**, not deferred — the same shared-pipeline/language-track pattern built for video now applies to all three content types uniformly.
2. **`social_posts` gains a real language dimension** — a `BOTH` job produces two independently postable social posts, each tied to its own language-specific content/output.

Both decisions turned out to *simplify* the architecture rather than just expand its scope: once every content type has language tracks, `content_pipelines` never needs a `language` column for any type, and the video-specific `video_projects`/`video_visual_assets`/`video_language_tracks` tables from the first revision collapse into one generalized `content_pipelines`/`content_visual_assets`/`content_language_tracks` set used by all three. See §18 for the full account of what changed as a result.

---

## 18. Generalizing the Shared-Pipeline Model to Image and Blog (2026-09-07)

Following §17.4's two product decisions, this section records what changed structurally across the whole document — every section from §5 onward was touched, not just the ones about video.

**What changed, concretely:**

1. **`video_projects` no longer exists as a separate table.** Its role is absorbed directly into `content_pipelines`, which is now the shared/project entity for every content type — video, image, and blog alike. `content_pipelines.language` is gone entirely, for every type, replacing the earlier design where only video's row lacked a language column.
2. **`video_visual_assets` → `content_visual_assets`, `video_language_tracks` → `content_language_tracks`, both generalized.** Video's extra scene decomposition and audio/caption needs stay in video-specific tables (`video_scenes`, `video_scene_audio`, `video_captions`), but the shared-asset and language-track concepts themselves are the same tables and the same rows for all three content types.
3. **§6.4/§6.5's state machines are now generalized**, with one structural branch point recorded explicitly: video gates user approval *before* shared generation (protecting an expensive spend); image/blog generate the shared visual immediately and gate approval on the *language track's* text output instead — matching each type's existing UX (§2.3/§2.4/§2.6) rather than forcing one pattern where the product never asked for it.
4. **§7.1's queue namespacing, §9's API shape, §10.1's generation fencing, §12's folder structure, §13's migration plan, and §14's tests were all re-derived from the generalized model**, not patched individually — the same reasoning that applied to video (shared steps keyed by pipeline+generation only, language steps keyed by pipeline+language+generation, retrying a track structurally cannot touch the shared asset) now applies uniformly.
5. **`social_posts` gained `language` and `content_language_track_id`, with uniqueness widened to `(job_id, content_type, language)`** — a `BOTH` job now produces two independently postable, independently failable social posts instead of one row with no language dimension at all (confirmed live: today's schema has no `language` column on `social_posts` whatsoever).
6. **Blog's images move off their third-party ephemeral host onto permanent storage** as part of this same pass (§5, §13 Phase 2) — a defect the audit surfaced (live sample data showed blog hero/inline images pointing at `tempfile.aiquickdraw.com`, not Supabase Storage) that becomes untenable once those images are formalized as a shared asset two language tracks depend on.
7. **§11 is now genuinely one section for all three content types**, not "video's real design plus a note that blog/image are different" — EN-only, FR-only, and BOTH are the same knob (1 vs. 2 `content_language_tracks` rows) regardless of content type.

**What did *not* change:** the core insight from the first revision (shared, language-independent generation must be structurally separated from language-specific generation) — this round is that insight applied consistently, not a new idea. Video's extra complexity (scenes, audio, captions, render, duration reconciliation) is still real and still lives in video-specific tables and steps; image and blog were never going to need those, just the same top-level split.

---

## If I Were Rebuilding Fresh-CAN

I'd keep Postgres (Supabase is fine to keep as the managed Postgres + storage layer — there's no need to rip that out) and keep the Next.js dashboard's shape largely intact, since its pages, components, and approval UX are reasonable and don't need a rewrite. The part that actually needs to go is **n8n as the stateful orchestrator** — not because n8n is a bad tool, but because this system asks it to hold hours of state per job in a single execution with no persistence, no idempotency, and no failure reporting, which is a job description no visual-workflow tool is well suited for at this scale of complexity (six branches, ten duplicated retry loops, per-language forking).

**Architecture I'd choose:** the queue + worker + provider-adapter design in §4–§10 — a small number of well-tested TypeScript services, a Postgres-backed job/step table as the single source of truth, and thin provider adapters wrapping the exact same external APIs already in use (OpenAI, ElevenLabs, AssemblyAI, KIE.ai, upload-post.com). Nothing about the current *provider choices* needs to change — only how their calls are orchestrated, retried, and recorded. I'd treat the shared-pipeline/language-track split (§5, §6.4/§6.5, §7.1) as load-bearing from day one of every content type's migration, not an optimization to layer on after — it's a correctness property (EN and FR must share whatever's genuinely shared), not a performance or cost one, confirmed necessary for video AND image by live production data (§17.4), and it's much cheaper to build into the schema and queue topology up front than to retrofit after a flat per-language pipeline is already half-migrated for any of the three content types.

**Order I'd implement it in:**
1. Stop the bleeding first (items 1–4 above) — these are correctness/security fixes independent of any migration and can ship in days, not weeks.
2. Build the durable schema and generic step-runner (items 5–6, now including item 11's generalized shared-pipeline tables) — this is the foundational piece everything else depends on, and it's testable in isolation before a single provider call is migrated.
3. Prove the pattern on Blog (items 7–8) — smallest surface area, already architecturally inconsistent with the rest, so migrating it also removes a wart rather than just adding one more system to maintain in parallel.
4. Add the reconciliation sweeper as early as possible (item 10) — even partially, watching n8n-backed jobs during the transition — because "a job silently hangs forever" is the single most damaging behavior in the current system and the cheapest one to blunt immediately.
5. Then work outward from Blog → Image → Social → Video, in that order of increasing complexity (§13), retiring n8n branch-by-branch rather than in one cutover, so the dashboard is never down and every phase is independently reversible — with video's sub-stages (§13 Phase 5, 5a-5d) deliberately front-loading the shared visual chain (5b) and verifying it against a real BOTH-language job before any per-language work is cut over, so the highest-risk part of this whole revision is validated earliest, not last.

The guiding discipline throughout: every external call becomes a small, named, retryable **step** recorded in the database — never a step inside someone else's execution log that disappears the moment something restarts.