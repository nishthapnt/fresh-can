# Implementation Plan

Status values: Pending · In Progress · Blocked · Deferred · Completed.

**This document is a historical planning snapshot, not a live status tracker** — it was written before any of Phase 1+ existed and was never updated once work moved past Blog's M4 (2026-09-14 note). Blog, Image, and Video have all since been fully built and cut over off n8n — see `PROGRESS.md`'s session log for what actually shipped and when. Individual status cells below are corrected where they were flatly wrong; the surrounding prose is left as the historical record it is.

## Phase 0 — Isolated hotfix

| Item | Status |
|---|---|
| Fix `onConflict` target in `upsertDraftFromCallback`/`upsertGeneratedContent` (`contentService.ts`) to match the live 3-column constraint | Completed |
| Verify against a live Video and Image draft_ready/generation_complete callback | Deferred |

Not part of the architecture migration — see `docs/DECISIONS.md` #7. No schema change required.

**Implementation note:** both functions now take a required `language` parameter. `upsertGeneratedContent`'s call in the `video_complete` branch passes `vc.video.language` (already present in that payload). The two legacy-format call sites (`draft_ready`, `generation_complete`) default to `'EN'` — their existing `N8nCallback` payload types carry no language field, so there's nothing to thread through without extending n8n's payload contract, which is out of scope for this isolated fix. Flagged inline in `n8n-callback/route.ts` and here so it isn't mistaken for an oversight.

**Verification not yet done:** `npx tsc --noEmit` could not be run in this environment (`node_modules` isn't installed — dependencies were never installed here). The diff is small and reviewed by hand only.

**Live verification deliberately deferred:** decided against running the local-dev-server + synthetic-callback verification now — reasoning was "we're moving away from n8n, we'll test when the worker replaces it." Worth being explicit about the scope of that: per `docs/DECISIONS.md` #8/#9, the new worker replaces n8n only for Blog. Video/Image stay on n8n, deferred, and this hotfix touches exactly the callback route Video/Image depend on (Blog bypasses it via its own sync-response path). So this fix will most likely stay unverified against real live traffic unless/until Video/Image are separately migrated or someone runs the verification steps independently of the Blog worker work. Accepted as a known, low-stakes risk given the diff's small size and hand review — not an oversight.

## Phase 1 — Additive database & worker foundation

| Item | Status |
|---|---|
| Migration: `content_pipelines`, `content_language_tracks`, `content_visual_assets`, `pipeline_steps` (new tables) | **Completed** — applied to live Supabase |
| Migration: nullable `content_pipeline_id`/`content_language_track_id` on `content_drafts` and `generated_content` (no drops) | **Completed** |
| New `content_language` enum (`EN`\|`FR` only) | **Completed** — verified: inserting `language='BOTH'` is rejected by the enum |
| Migration reviewed and run against the live database | **Completed** |
| Confirm zero query/behavior change for existing Video/Image/Library code paths post-migration | **Completed** — `content_jobs`/`content_drafts`/`generated_content` row counts identical pre/post migration (286/241/137) |
| Choose and provision worker hosting platform | Pending |
| Worker foundation: process skeleton, DB connectivity, no business logic yet | In progress |

**Post-apply verification (this session, against the live database, self-cleaning test rows):**
- New tables queryable via service role; new nullable columns present on `content_drafts`/`generated_content`.
- `UNIQUE(content_pipeline_id, language)` on `content_language_tracks` correctly rejects a duplicate EN track.
- `content_language` enum correctly rejects `'BOTH'`.
- **RLS is genuinely enforced on all four new tables** (confirmed via a real row, not an empty-table false negative): anon key sees 0 rows on SELECT, gets an explicit `new row violates row-level security policy` error on INSERT, and 0 rows affected on UPDATE. Service-role key succeeds on all three. This is the first place in the project where RLS is actually active — see the note below.
- **Important finding, not a defect in this migration:** the *existing* tables (`content_jobs`, `generated_content` at minimum) have RLS policies defined but RLS is not actually enabled on them — an anon-key INSERT into `content_jobs` and `generated_content` both succeeded in a live test despite policies scoped to `authenticated`/`anon`-read-only. This means the anon key (which ships to every browser, `NEXT_PUBLIC_...`) has effectively unrestricted read/write on those tables today, independent of anything in this migration. Recording here rather than silently working around it; not in scope to fix as part of Blog's migration.

**Migration draft notes** (full reasoning is inline as SQL comments in the migration file itself):
- `video_scenes` and `content_visual_assets.video_scene_id` are deliberately *not* created now — Video isn't being built this phase, and a nullable FK to a nonexistent table isn't meaningful. Added later, additively, when Video migrates.
- `content_pipelines`/`content_language_tracks` status `CHECK` lists and `content_visual_assets.asset_type` intentionally include values nothing writes yet (Video's future states/asset types) — so a later Video/Image migration doesn't need to alter these constraints, per `docs/DECISIONS.md` #1.
- `content_drafts`'s two new FKs are constrained "at most one set" (legacy rows: neither). `generated_content`'s two new FKs are constrained "both set or neither" — a language track's output always belongs to exactly one pipeline, so `content_pipeline_id` there is a denormalized convenience alongside `content_language_track_id`, not an alternative to it. Different constraint shapes on purpose, not an inconsistency.
- RLS on the four new tables mirrors the existing `content_jobs`/`content_drafts`-style pattern (authenticated blanket access, no anon policy) rather than `generated_content`'s pattern (which also has an explicit anon "Public read completed" policy) — these are internal pipeline state, not public-facing content. Worth double-checking against the live project's actual `service_role` RLS-bypass behavior before applying, since `generated_content` has an explicit `service_role` policy the other tables don't, and it's not confirmed why.

## Phase 2 — Blog implementation

**Status: Phase 1 migration is applied and verified live — M1–M4 are functionally built and tested against the real database (mocked providers).** The existing n8n Blog path (`/api/n8n/trigger`'s blog branch, `N8N_BLOG_WEBHOOK`, the synchronous draft-save in that route) is untouched and stays the live path, per `docs/DECISIONS.md` #3 — cutover only happens at M8.

### Progress so far

- **Worker (`worker/`)**: all 5 step handlers built — `generate_outline`, `generate_hero_image`/`generate_inline_image` (2-item fan-in), `generate_copy`, `finalize_draft` — plus the polling-loop entrypoint (`src/index.ts`), the `pg`→`supabase-js` DB access layer (`src/db.ts`), and OpenAI/KIE.ai provider adapters. 47 tests passing: 32 pure-logic (state machines, backoff) + 15 live integration/e2e (real Supabase, mocked providers) covering EN-only, BOTH (two independent tracks, never a literal `'BOTH'` value), identical shared hero/inline URLs across languages, one-language-failing-doesn't-touch-the-other, provider failure+retry, and no-duplicate-provider-calls idempotency.
- **API routes**: `POST /api/jobs/[jobId]/blog/generate` and `GET /api/jobs/[jobId]/blog/status` built and verified against a real running dev server + live database (through the app's actual login flow, not bypassed) — including a genuine concurrent-duplicate-request race test, which correctly converged on one pipeline via a unique-violation catch.
- **Two real bugs found via testing and fixed, not just reported**: (1) `generateOutline`/`generateCopy` originally only supported a fresh claim, never a retry-after-failure — a retry's claim always failed and silently stranded the row forever. (2) `generateVisualImage` shared the pipeline's single `retry_count` between hero and inline, inflating one asset's attempt count from the other's unrelated failures — now tracked independently via each asset's own `attempt_number`/`updated_at`. Both fixes are covered by dedicated tests. Also fixed: a real ~1.3s clock-skew between this environment and the live Supabase server broke naive backoff-elapsed-time math — `isReadyToRetry` now clamps negative elapsed time instead of misbehaving.
- **Not yet built**: `tracks/[lang]/{draft,approve,retry}` and `regenerate` routes, real provider credentials (`OPENAI_API_KEY`/KIE.ai key still absent, so nothing has run against a real provider — only mocked ones), frontend wiring (M5+).

### n8n Blog branch → new backend/worker mapping

Per `ARCHITECTURE.MD` §2.4 (no n8n workflow export exists in this repo — this mapping is only as accurate as that prior audit):

| n8n node (current) | New equivalent |
|---|---|
| Webhook trigger (`type: blog`) | `POST /api/jobs/:jobId/blog/generate` — creates one `content_pipelines` row + 1-2 `content_language_tracks` rows, returns immediately (fire-and-forget) |
| Sanitizer / prep node | Request validation inside the route handler |
| AI Agent 1 — outline/structure (OpenAI) | Worker step `generate_outline` (pipeline-scoped, shared, runs once) |
| AI Agent 2 — full copy (OpenAI) | Worker step `generate_copy` (track-scoped, once per requested language) |
| Generate Image 2 — hero (KIE.ai, poll + fallback placeholder) | Worker step `generate_hero_image` (pipeline-scoped, shared) |
| Generate Image 5 — inline (KIE.ai, poll + fallback placeholder) | Worker step `generate_inline_image` (pipeline-scoped, shared) |
| "FC — Blog Structure Output" assembly node | `finalize_draft` step (track-scoped) — gated on this track's copy AND the pipeline's shared visuals both ready; writes `content_drafts` in the exact JSON shape `BlogEditState`/`blogEditFromDraft` already expect |
| Respond to webhook (synchronous body) | Removed — replaced by the async `generate` call + a status-polling endpoint |
| Fallback placeholder on exhausted image retries | Removed — real failure surfaced instead (`SPECIFICATIONS.md` §14 TARGET) |

### Worker step sequence

Shared (pipeline-scoped, once regardless of EN/FR/BOTH): `generate_outline` → `generate_hero_image` + `generate_inline_image` concurrently (2-item fan-in → `content_pipelines.status = shared_visual_ready`). Per language track (once per requested language): `generate_copy` (gated only on `generate_outline`, not images) → `finalize_draft` (gated on this track's copy AND `shared_visual_ready`). Approval/regenerate/retry are user-triggered, not worker steps — approval writes `generated_content` from the backend (fixes the client-side write bug in `SPECIFICATIONS.md` §11); regenerate has two independent scopes (`visual` vs. `copy`) so a picture change never forces a copy rewrite or vice versa; retry resumes the last failed step at the same generation.

**Idempotency/claiming/backoff** (no new migration columns — reuses `retry_count`/`last_error`/`updated_at`, already in the paused migration): a step checks `pipeline_steps` for an existing `succeeded` row at the same (scope, step_name, generation) before doing provider work; a conditional `UPDATE ... WHERE status = 'created'` claims a row (CAS-style — simpler than `SKIP LOCKED`, sufficient at this scale); backoff is `last_error IS NOT NULL AND updated_at < now() - (retry_count * base_delay)`.

**Proposed new files** (not created yet): a separate `worker/` directory (own `package.json`, deployable independently once a hosting platform is chosen — that choice doesn't block writing this code) with `adapters/` (OpenAI, KIE.ai), `steps/` (one file per worker step above), and `lib/` (claim/idempotency/backoff helpers); plus `src/app/api/jobs/[jobId]/blog/{generate,status,regenerate}/route.ts` and `.../tracks/[lang]/{draft,approve,retry}/route.ts` — all new paths, nothing existing changes.

| Milestone | Scope | Status |
|---|---|---|
| M0 | Worker package scaffold, test framework, pure business logic (state machines, backoff/retry), provider adapters (OpenAI, KIE.ai) | **Completed** |
| M1 | Backend API + worker: pipeline/track creation, status endpoint, real DB verified | **Completed** — `generate`/`status` routes live-tested (incl. concurrent-duplicate-request race), worker polling loop built |
| M2 | Single-language (EN) async generation, end-to-end, worker calling OpenAI for outline+copy | **Completed (mocked provider)** — e2e-tested against real DB; real OpenAI call still needs `OPENAI_API_KEY` |
| M3 | Shared hero/inline image generation + reuse | **Completed (mocked provider)** — 2-item fan-in, per-asset retry/backoff, e2e-tested; real KIE.ai call still needs a key and un-verified endpoint shape |
| M4 | Second language track / BOTH — two independent tracks, never a literal `'BOTH'` value | **Completed** — verified live via the actual API route, not just unit tests |
| M5 | Draft editor wired to new backend, reusing existing `BlogTabContent` UI | **Completed** (Session 5, 2026-09-09) |
| M6 | Per-language approval | **Completed** (Session 5, 2026-09-09) |
| M7 | Failure, retry, and regeneration (visuals-only / copy-only / full) | **Completed** (Session 5, 2026-09-09) — real copy-only regen live-verified |
| M8 | Library cutover; remove the old synchronous trigger-route blog path | **Completed** (Session 5, 2026-09-09) — old blog/image_post n8n paths structurally removed, not just unused |

**Note (2026-09-14):** the M5-M8 rows above sat as "Pending"/"Blocked" for a long time after they actually shipped — this table was never updated once work moved past M4. Treat `PROGRESS.md`'s session log as the current source of truth for status going forward; this file predates Blog's full build-out and was never maintained as a living document past that point.

### M0 detail (completed)

New `worker/` package (own `package.json`/`tsconfig.json`/Vitest config, deployable independently):
- `src/lib/pipelineStateMachine.ts` + `.test.ts` — legal `content_pipelines.status` transitions for Blog's subset of the DB's shared CHECK vocabulary (video-only values like `draft_ready`/`awaiting_approval`/`approved` are deliberately excluded from Blog's transition table, since Blog has no project-level approval gate — ARCHITECTURE.MD §6.4).
- `src/lib/trackStateMachine.ts` + `.test.ts` — same for `content_language_tracks.status` (Blog's subset excludes video-only `awaiting_shared`/`rendering`; `draft_ready → ready` directly, no separate `awaiting_approval` state — a simplification made at this implementation layer, documented inline).
- `src/lib/backoff.ts` + `.test.ts` — retry/backoff calculation reusing the migration's existing `retry_count`/`last_error`/`updated_at` columns (no new column proposed).
- `src/adapters/{types,openai,kie}.ts` + tests — `ScriptGenerator`/`ImageGenerator` interfaces per ARCHITECTURE.MD §8. OpenAI adapter implemented with confidence (documented, stable API). **KIE.ai adapter is best-effort, not verified** — no KIE.ai API documentation was available, only ARCHITECTURE.MD's secondhand audit of n8n's HTTP calls; exact endpoint/field names need confirming against real KIE.ai docs before live use — flagged in the file header, not silently assumed correct.

**Verified this session:** `cd worker && npm test` → 32/32 passing. `cd worker && npx tsc -p tsconfig.json --noEmit` → clean. Root `npx tsc --noEmit` → clean (no regression). Root `npm run lint` → 45 pre-existing findings, all in files untouched by this work (confirmed by direct diff/grep against the two files the Phase 0 hotfix touched).

**Not done / explicitly deferred to M1+:** DB access layer (`pg`-based), the five worker step handlers, the worker polling loop (`index.ts`), and the Next.js API routes under `src/app/api/jobs/[jobId]/blog/` are designed (see the n8n mapping and step sequence above) but not yet written — next chunk of work. None of it can be integration-tested until `DATABASE_URL` exists.

## Later phases (not detailed yet)

| Phase | Status |
|---|---|
| Image migration | **Completed** (Session 5, 2026-09-09) — built from scratch on this same architecture, live-verified, n8n path removed |
| Video migration | **Completed** (Session 6, 2026-09-14) — script/character-ref/per-scene-visuals shared once per job, per-language narration/captions/render, live-verified end-to-end (real EN+FR run) |

This plan was never expanded with Image/Video-specific detail the way Phase 2 covers Blog (see `ARCHITECTURE.MD`/`docs/DATABASE_DESIGN.md` for the target shape both were built against instead, and `PROGRESS.md`'s Session 5/6 entries for what actually shipped).

## Explicitly not in scope for this plan
- No migration SQL is written until the Phase 1 migration itself is reviewed and approved separately.
- No worker code is written in this pass.
- No Video/Image application code is modified anywhere in this plan.
