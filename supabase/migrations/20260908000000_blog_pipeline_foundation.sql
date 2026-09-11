-- Phase 1 — additive database foundation for the Blog pipeline architecture.
-- See ARCHITECTURE.MD, docs/DATABASE_DESIGN.md, docs/DECISIONS.md (#1-#6, #9)
-- and docs/IMPLEMENTATION_PLAN.md (Phase 1) for the reasoning behind every
-- choice below. Nothing here has been run against the live database — this
-- is a draft for review.
--
-- Guiding constraints (see docs/DECISIONS.md #2, #3, #6):
--   * Additive only. No existing table is dropped, renamed, or has a column
--     dropped/renamed. Video and Image's current code paths (contentService.ts,
--     the draft PATCH route, the job-detail page, all three *Library functions)
--     read/write content_jobs/content_drafts/generated_content exactly as they
--     do today and are completely unaffected by this migration.
--   * Only Blog populates the new tables/columns right now. Video/Image are not
--     migrated as part of this phase (docs/DECISIONS.md #9).
--   * Table/column vocabulary (status CHECK value lists, asset_type values,
--     etc.) intentionally includes Video's future needs, not just Blog's
--     current ones, so a later Video/Image migration can adopt these tables
--     without altering their constraints (docs/DECISIONS.md #1). Concretely:
--     content_pipelines/content_language_tracks status lists and
--     content_visual_assets.asset_type both carry values nothing writes yet.
--   * video_scenes and content_visual_assets.video_scene_id are intentionally
--     NOT created in this migration — Video isn't being built now, and adding
--     a nullable FK to a table that doesn't exist yet isn't meaningful. These
--     get added in a future Video-migration pass via ALTER TABLE, additively,
--     the same way this migration adds to content_drafts/generated_content
--     today.

begin;

-- ── 1. New enum: content_language ───────────────────────────────────────────
-- Deliberately EN|FR only — never BOTH. docs/DECISIONS.md #4: a live audit
-- found a generated_content row with the literal value 'BOTH' and two
-- languages' captions concatenated into one string. This enum makes that
-- class of bug a type error instead of a possible value. content_jobs.language
-- is untouched — it stays free text, unconstrained, intent-only, exactly as
-- it is in the live schema today.
create type content_language as enum ('EN', 'FR');

-- ── 2. content_pipelines ─────────────────────────────────────────────────────
-- The shared/project entity, one row per (job_id, content_type). For this
-- phase only content_type = 'blog' rows are ever created — the shape is
-- generic so Video/Image can adopt it later without a redesign.
create table content_pipelines (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null references content_jobs(id),
  content_type       content_type not null,
  current_generation int not null default 1,
  status             text not null default 'created'
                       check (status in (
                         'created', 'drafting', 'draft_ready', 'awaiting_approval',
                         'approved', 'generating', 'ready', 'stale', 'failed'
                       )),
  current_step       text,
  retry_count        int not null default 0,
  last_error         text,
  idempotency_key    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint content_pipelines_job_content_type_key unique (job_id, content_type)
);

create unique index content_pipelines_idempotency_key_idx
  on content_pipelines (idempotency_key)
  where idempotency_key is not null;

-- Worker polling support ("give me pipelines in state X") — needed by M1/M2,
-- not speculative.
create index content_pipelines_status_updated_idx
  on content_pipelines (status, updated_at);

create trigger trg_content_pipelines_updated
  before update on content_pipelines
  for each row execute function update_updated_at();

-- ── 3. content_language_tracks ──────────────────────────────────────────────
-- One row per REQUESTED language, for every content_pipelines row. This is
-- what makes BOTH a request-level concept: a BOTH job creates two of these
-- rows, an EN-only or FR-only job creates one (docs/DECISIONS.md #4).
create table content_language_tracks (
  id                     uuid primary key default gen_random_uuid(),
  content_pipeline_id    uuid not null references content_pipelines(id),
  language               content_language not null,
  status                 text not null default 'waiting_on_shared'
                           check (status in (
                             'waiting_on_shared', 'generating', 'draft_ready',
                             'awaiting_approval', 'approved', 'awaiting_shared',
                             'rendering', 'ready', 'stale', 'failed'
                           )),
  current_step           text,
  master_generation_used int not null,
  retry_count            int not null default 0,
  last_error             text,
  approved_at            timestamptz,
  approved_by            uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint content_language_tracks_pipeline_language_key
    unique (content_pipeline_id, language)
);

create index content_language_tracks_status_updated_idx
  on content_language_tracks (status, updated_at);

create trigger trg_content_language_tracks_updated
  before update on content_language_tracks
  for each row execute function update_updated_at();

-- ── 4. content_visual_assets ─────────────────────────────────────────────────
-- Shared, language-independent generated media. For Blog: exactly one
-- hero_image row and exactly one inline_image row per (content_pipeline_id,
-- generation) — asset_type distinguishes the two, so the unique constraint
-- below already enforces "at most one of each per generation" correctly.
-- No asset_index / multi-inline support is added — not currently required;
-- can be introduced later if Blog's requirements change (docs/DECISIONS.md #5).
-- asset_type includes Video's future values (character_ref/scene_image/
-- scene_video_clip/photo) so this table's CHECK constraint doesn't need
-- altering when Video migrates later — nothing writes those values yet.
create table content_visual_assets (
  id                  uuid primary key default gen_random_uuid(),
  content_pipeline_id uuid not null references content_pipelines(id),
  generation          int not null,
  asset_type          text not null
                        check (asset_type in (
                          'character_ref', 'scene_image', 'scene_video_clip',
                          'photo', 'hero_image', 'inline_image'
                        )),
  status              text not null default 'pending'
                        check (status in ('pending', 'generating', 'ready', 'failed')),
  provider_ref        text,
  file_url            text,
  duration_ms         int, -- video-only; always null for blog's rows
  attempt_number      int not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- No video_scene_id column yet (see header note) — every row this phase is
  -- pipeline-scoped, not scene-scoped, so one plain unique constraint covers
  -- it. Revisit when video_scenes/video_scene_id are added: that will need a
  -- second partial unique index split on video_scene_id is/is not null,
  -- per docs/DATABASE_DESIGN.md's original two-index design.
  constraint content_visual_assets_pipeline_type_gen_key
    unique (content_pipeline_id, asset_type, generation)
);

create trigger trg_content_visual_assets_updated
  before update on content_visual_assets
  for each row execute function update_updated_at();

-- ── 5. pipeline_steps ────────────────────────────────────────────────────────
-- Durable attempt log, one row per attempt, shared by every worker and every
-- content type. Exactly one of the two scope FKs is set per row — this is
-- what makes "which layer wrote this" a queryable fact instead of an
-- inference from step_name.
create table pipeline_steps (
  id                        uuid primary key default gen_random_uuid(),
  content_pipeline_id       uuid references content_pipelines(id),
  content_language_track_id uuid references content_language_tracks(id),
  step_name                 text not null,
  generation                int not null,
  attempt_number            int not null default 1,
  status                    text not null
                              check (status in (
                                'pending', 'running', 'succeeded',
                                'failed_retryable', 'failed_terminal', 'superseded'
                              )),
  provider                  text,
  input_snapshot            jsonb,
  output_snapshot           jsonb,
  error_message             text,
  started_at                timestamptz,
  finished_at               timestamptz,
  created_at                timestamptz not null default now(),

  constraint pipeline_steps_exactly_one_scope check (
    (content_pipeline_id is not null)::int
    + (content_language_track_id is not null)::int = 1
  )
);

create index pipeline_steps_pipeline_step_idx
  on pipeline_steps (content_pipeline_id, step_name, generation, status);

create index pipeline_steps_track_step_idx
  on pipeline_steps (content_language_track_id, step_name, generation, status);

-- ── 6. content_drafts — additive columns only ───────────────────────────────
-- job_id/content_type/language/status/is_approved/is_edited/draft_data/
-- original_data/approved_at/approved_by are UNTOUCHED — Video/Image's entire
-- current read/write path (getDraftsForJob, the draft PATCH route, the
-- job-detail page) keeps working exactly as-is (docs/DECISIONS.md #3, #6).
--
-- At most one of the two new FKs is ever set per row (not exactly-one):
-- legacy Video/Image rows set neither (both null). A future Video master
-- script draft would set content_pipeline_id only; Blog's per-language draft
-- sets content_language_track_id only.
alter table content_drafts
  add column content_pipeline_id       uuid references content_pipelines(id),
  add column content_language_track_id uuid references content_language_tracks(id),
  add constraint content_drafts_at_most_one_scope check (
    (content_pipeline_id is not null)::int
    + (content_language_track_id is not null)::int <= 1
  );

create index content_drafts_pipeline_idx
  on content_drafts (content_pipeline_id) where content_pipeline_id is not null;

create index content_drafts_track_idx
  on content_drafts (content_language_track_id) where content_language_track_id is not null;

-- ── 7. generated_content — additive columns only ────────────────────────────
-- job_id/content_type/language/file_url/thumbnail_url/output_data/status/etc.
-- are UNTOUCHED — getVideoLibrary/getImageLibrary/getBlogLibrary and the
-- Library UI keep working exactly as-is (docs/DECISIONS.md #3, #6). Blog's
-- backend populates BOTH the new FKs and the legacy denormalized columns at
-- write time, so the Library grid needs no changes.
--
-- Unlike content_drafts, the two new FKs here are set TOGETHER or not at all
-- — a language track's final output always belongs to exactly one pipeline,
-- so content_pipeline_id is a denormalized convenience alongside
-- content_language_track_id, not an alternative to it.
alter table generated_content
  add column content_pipeline_id       uuid references content_pipelines(id),
  add column content_language_track_id uuid references content_language_tracks(id),
  add column quality_flag              text
                check (quality_flag in ('ok', 'degraded_fallback')),
  add constraint generated_content_scope_pair_consistent check (
    (content_pipeline_id is null) = (content_language_track_id is null)
  );

create index generated_content_pipeline_idx
  on generated_content (content_pipeline_id) where content_pipeline_id is not null;

-- content_language_track_id is the eventual identity key for this table's
-- pipeline-owned rows (docs/DATABASE_DESIGN.md §3.10) — unique, not just
-- indexed, so a track can never end up with two final outputs.
create unique index generated_content_track_key
  on generated_content (content_language_track_id) where content_language_track_id is not null;

-- ── 8. RLS — mirror the existing authenticated-blanket-access pattern ──────
-- content_jobs/content_drafts/social_posts/social_platform_logs all use this
-- same shape live today (auth_read_X SELECT + auth_write_X ALL, both
-- `qual: true`, no anon access). These four new tables are internal pipeline
-- state, never publicly readable — content_visual_assets' file_url reaching
-- the public happens through generated_content, which already has its own
-- "Public read completed" anon policy, untouched by this migration.
alter table content_pipelines        enable row level security;
alter table content_language_tracks  enable row level security;
alter table content_visual_assets    enable row level security;
alter table pipeline_steps           enable row level security;

create policy auth_read_content_pipelines on content_pipelines
  for select to authenticated using (true);
create policy auth_write_content_pipelines on content_pipelines
  for all to authenticated using (true) with check (true);

create policy auth_read_content_language_tracks on content_language_tracks
  for select to authenticated using (true);
create policy auth_write_content_language_tracks on content_language_tracks
  for all to authenticated using (true) with check (true);

create policy auth_read_content_visual_assets on content_visual_assets
  for select to authenticated using (true);
create policy auth_write_content_visual_assets on content_visual_assets
  for all to authenticated using (true) with check (true);

create policy auth_read_pipeline_steps on pipeline_steps
  for select to authenticated using (true);
create policy auth_write_pipeline_steps on pipeline_steps
  for all to authenticated using (true) with check (true);

commit;
