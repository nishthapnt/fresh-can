<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Fresh-CAN Engineering Rules

## Architecture boundaries
- New pipeline-owned state (jobs/pipelines/tracks/drafts/generated content for Blog) is written only through a backend API route — never directly from a component via the anon Supabase client.
- The backend API is the only caller of the job/pipeline queue. Workers are the only thing that calls external providers (OpenAI, KIE.ai, etc.) directly.
- n8n remains the executor for Video and Image, unchanged, until those pipelines are explicitly migrated. Don't route Video/Image traffic through the new worker, and don't retrofit Video/Image's existing direct-write pattern just because Blog is moving off it.

## Database safety
- Never assume a table, column, or constraint exists — check `docs/DATABASE_DESIGN.md` and, where it matters, the live schema before writing a query. (This codebase has one confirmed live case of code silently drifting from the real constraint — see `docs/DECISIONS.md`.)
- Migrations are additive only while Video/Image still depend on the current shape of `content_drafts`, `generated_content`, `content_jobs`, `social_posts`, `social_platform_logs`: no dropped or renamed columns on these tables until Video/Image are themselves migrated.
- A schema change isn't written until it's reflected in `docs/DATABASE_DESIGN.md`'s current → target mapping.

## API / backend ownership
- New pipeline-owned mutations (job/pipeline/track state, draft edits, approvals, regeneration, retry) get a dedicated backend API route — they are not added to `contentService.ts` as another direct-client-call function.
- `contentService.ts` stays the read path for existing Video/Image/Library UI and for the legacy columns Blog also denormalizes into; it does not become the write path for new pipeline-owned tables.

## Idempotency
- Every new mutating endpoint and every worker step handler must be safe to call twice: check for an existing successful record for the same (pipeline or track, step, generation) before doing provider work or writing a result.
- Before adding any new `upsert`, confirm its `onConflict` target matches a real live unique constraint — this exact class of bug already exists once in this codebase.

## Testing
- The main Next.js app still has no automated test suite — verification there is `npx tsc --noEmit` plus manual exercise via the dev server. Don't introduce a test framework for it as a side effect of unrelated work.
- `worker/` (the Blog worker package) has its own Vitest suite (`cd worker && npm test`), added when the worker itself was built — because the task explicitly required unit/integration tests, not incidentally. Pure logic (state machines, backoff/retry calculation, provider adapters against a mocked `fetch`) is unit-tested and must actually pass, not just typecheck. DB-touching code gets integration tests gated on `DATABASE_URL` (`describe.skipIf(!process.env.DATABASE_URL)`) rather than assumed to work — never claim a DB-dependent test "passed" when it only skipped.
- For Blog's new async flow specifically, verification covers the full API → worker → DB round trip for both language tracks independently, not just the EN happy path, once `DATABASE_URL` is actually available.
- Run `npx tsc --noEmit` (root) and `cd worker && npm test && npx tsc -p tsconfig.json --noEmit` after any change touching either — both are cheap and catch regressions immediately.

## Incremental migration
- Blog is the only pipeline being built on the new architecture right now. Video and Image are not touched, refactored, or migrated as part of this work, even opportunistically.
- Each phase in `docs/IMPLEMENTATION_PLAN.md` ships independently verifiable — don't build ahead into a later milestone because it's convenient.

## Avoiding unrelated changes
- Don't fix pre-existing issues noticed in passing (e.g. the `twitter`/`x` enum duplication, the unused `job_overview` view, the `video_url` column question) unless asked — note them in `docs/DECISIONS.md` or flag them, don't silently touch them.
- Keep changes scoped to what the current milestone names.

## Docs stay in sync
- A change that alters pipeline/job/status/track behavior updates the relevant doc (`SPECIFICATIONS.md`, `ARCHITECTURE.MD`, `docs/DATABASE_DESIGN.md`, `docs/DECISIONS.md`) in the same change, not after.
