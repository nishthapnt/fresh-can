# Architectural Decisions

Each entry: the decision, why it was made, and what it implies going forward. Trivial implementation details are not recorded here.

## 1. Adopt the ARCHITECTURE.MD/DATABASE_DESIGN.md redesign as the long-term foundation; Blog is the first pipeline migrated
**Reasoning:** Blog has confirmed, structural bugs (see #4) that the redesign's shared-asset/language-track pattern fixes directly, not just architecturally. Blog is also the cheapest, lowest-risk pipeline to migrate first (2 AI calls + 2 image calls vs. Video's multi-provider, hour-long chain).
**Consequences:** Video and Image stay on the current n8n-orchestrated flow until separately, explicitly migrated later. The new tables must be shaped so Video/Image can adopt them without a rebuild, even though they're not being touched now.

## 2. The new architecture is introduced additively
**Reasoning:** A destructive schema rewrite risks breaking Video/Image, which must keep working throughout.
**Consequences:** New tables only; existing tables gain nullable FK columns, never dropped/renamed columns, for this phase.

## 3. Existing Video/Image code paths must continue working, unmodified, during the transition
**Reasoning:** Explicit constraint from the outset of this work.
**Consequences:** No shared helper, table, or route Video/Image currently depend on is changed as part of Blog's migration, even where it's tempting (e.g. the onConflict bug, handled separately — see #7).

## 4. BOTH is a request-level concept; it always produces independent EN and FR tracks
**Reasoning:** Confirmed live bug: a BOTH blog job today fires generation once and writes the literal string `'BOTH'` into `content_drafts.language` — one ambiguous row, not two outputs. The same defect exists structurally for Image posts (documented in `ARCHITECTURE.MD`'s prior audit).
**Consequences:** The new `content_language` enum is restricted to `EN`/`FR` only — `BOTH` is structurally unrepresentable below the job level. `content_jobs.language` remains free text (unconstrained, intent-only) since it already is in the live schema.

## 5. Blog's shared visual assets (hero + inline images) are generated once per job and reused by every language track
**Reasoning:** Same root cause as #4 — without a shared-asset guarantee, nothing stops EN and FR from getting different hero/inline images if generation is ever split per language.
**Consequences:** A new `content_visual_assets`-equivalent construct is required; language-track-level generation (outline/copy) must never trigger image generation itself.

## 6. Legacy columns on `content_drafts`/`generated_content` are retained, not dropped, for this phase
**Reasoning:** The live schema audit confirms Video/Image's entire current code path (`getDraftsForJob`, the draft PATCH route, `getVideoLibrary`/`getImageLibrary`/`getBlogLibrary`) reads/writes `job_id`/`content_type`/`language`/`status` directly. `DATABASE_DESIGN.md`'s original plan to drop these assumed all three content types migrate together, which is no longer the case.
**Consequences:** `content_pipeline_id`/`content_language_track_id` are added as new, nullable columns alongside the existing ones. Blog's backend populates both the new FKs and the legacy denormalized columns at write time, so the existing Library UI needs no changes. Full column removal is deferred until Video/Image themselves migrate.

## 7. The pre-existing `onConflict` mismatch is a separate, isolated hotfix
**Reasoning:** Live schema audit confirmed `content_drafts`/`generated_content`'s real unique constraints are 3-column (`job_id, content_type, language`), but `contentService.ts`'s shared `upsertDraftFromCallback`/`upsertGeneratedContent` helpers (used by Video/Image via the callback route) target a 2-column `onConflict` that matches no existing constraint — a live defect unrelated to the architecture migration.
**Consequences:** Tracked and fixed as Phase 0, independently of and before the architecture work — not folded into the Blog migration's scope, not blocking it either.

## 8. Blog pipeline steps are executed by a new, separate always-on worker service; n8n's blog branch is retired
**Reasoning:** Explicit choice over keeping n8n as executor-with-a-restructured-contract or a poll-based serverless approach — chosen to most literally match `ARCHITECTURE.MD`'s queue/worker design.
**Consequences:** New infrastructure must be provisioned (hosting platform not yet chosen — a Phase 1 task). The worker becomes responsible for calling OpenAI (outline + copy) and KIE.ai (hero/inline images) directly, reimplementing what n8n's blog branch currently does. n8n continues orchestrating Video and Image, completely unchanged.

## 9. Video and Image migration to the new architecture is explicitly deferred
**Reasoning:** Scope control — Blog is the proving ground; migrating three pipelines at once was rejected as too large and risky.
**Consequences:** `ARCHITECTURE.MD`/`docs/DATABASE_DESIGN.md` describe the target shape generally (so Video/Image slot in later without a redesign), but no Video/Image migration work is scheduled or detailed yet.
