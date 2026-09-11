-- Video pipeline foundation (M0 of the video migration — see
-- ARCHITECTURE.MD §4.2/§5/§13 Phase 5 and the approved plan). Additive only,
-- same discipline as 20260908000000_blog_pipeline_foundation.sql: no
-- existing table is dropped/renamed, no existing column is dropped/renamed,
-- and Blog/Image's current code paths are completely unaffected.
--
-- Scope note: this migration adds ONLY the new tables/columns video needs.
-- It deliberately does NOT widen any status CHECK constraint —
-- content_pipelines' status list is already generic enough
-- (created/drafting/draft_ready/awaiting_approval/approved/generating/
-- ready/stale/failed) to cover video's shared-layer states; the
-- already-nullable `current_step` text column (no CHECK) carries the
-- fine-grained phase ("generating_character_ref" vs "generating_scene_
-- visuals") instead. content_language_tracks' status list already contains
-- `awaiting_shared` and `rendering` — added defensively during the Blog
-- migration specifically for video's later use — so no change needed there
-- either. Use those exact literal spellings in code, not
-- ARCHITECTURE.MD's prose name `awaiting_visuals`.

begin;

-- ── 1. video_scenes ─────────────────────────────────────────────────────────
-- The language-neutral scene plan, produced by generate_script (worker/src/
-- steps/generateScript.ts, not yet written) in the same call as the script
-- itself (ARCHITECTURE.MD §17.1 — scene planning is not a separate step).
create table video_scenes (
  id                  uuid primary key default gen_random_uuid(),
  content_pipeline_id uuid not null references content_pipelines(id),
  generation          int not null,
  scene_number        int not null,
  visual_description  text not null,
  shot_notes          text,
  narration_intent    jsonb not null,
  target_duration_ms  int not null,
  created_at          timestamptz not null default now(),

  constraint video_scenes_pipeline_gen_scene_key
    unique (content_pipeline_id, generation, scene_number)
);

create index video_scenes_pipeline_gen_idx
  on video_scenes (content_pipeline_id, generation);

-- ── 2. content_visual_assets — add the scene dimension ──────────────────────
-- Existing rows (Blog's hero_image/inline_image, Image's photo) all have
-- video_scene_id NULL and are unaffected. The single unique constraint from
-- the Blog migration is replaced by two partial ones, exactly as that
-- migration's own inline comment said would be needed here.
alter table content_visual_assets
  add column video_scene_id uuid references video_scenes(id);

alter table content_visual_assets
  drop constraint content_visual_assets_pipeline_type_gen_key;

-- character_ref (video_scene_id IS NULL, shared by every content type that
-- has no scene concept too — Blog/Image's rows also match this index):
-- at most one row per (pipeline, asset_type, generation).
create unique index content_visual_assets_pipeline_type_gen_key
  on content_visual_assets (content_pipeline_id, asset_type, generation)
  where video_scene_id is null;

-- scene_image / scene_video_clip (video_scene_id IS NOT NULL): at most one
-- of each per scene per generation — critically, this does NOT block two
-- DIFFERENT scenes from each having their own scene_image row in the same
-- generation, which the old single constraint would have wrongly prevented.
create unique index content_visual_assets_scene_type_gen_key
  on content_visual_assets (content_pipeline_id, video_scene_id, asset_type, generation)
  where video_scene_id is not null;

-- ── 3. content_pipelines — per-scene fan-in counters ────────────────────────
-- NULL/0-and-unused for blog/image_post; only generate_scene_visual reads/
-- writes these. scenes_visuals_ready_count reaching scenes_total is the
-- transactional trigger that flips this pipeline's status to 'ready'
-- (ARCHITECTURE.MD §7.1's fan-in counter, minus the queue framing we don't
-- have — same idea, applied directly against these columns).
alter table content_pipelines
  add column scenes_total               int,
  add column scenes_visuals_ready_count int not null default 0;

-- ── 4. video_scene_audio ─────────────────────────────────────────────────────
-- Per (language track, scene): localized wording (written by localize_script)
-- then synthesized audio (written by synthesize_voice). One row per scene per
-- track per generation — the track's OWN generation
-- (content_language_tracks.master_generation_used-scoped), bumped only on a
-- full script-level reset, per ARCHITECTURE.MD §5.
create table video_scene_audio (
  id                        uuid primary key default gen_random_uuid(),
  content_language_track_id uuid not null references content_language_tracks(id),
  video_scene_id            uuid not null references video_scenes(id),
  generation                int not null,
  narration_text            text,
  file_url                  text,
  duration_ms               int,
  provider_ref              text,
  status                    text not null default 'pending'
                              check (status in ('pending', 'generating', 'ready', 'failed')),
  attempt_number            int not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint video_scene_audio_track_scene_gen_key
    unique (content_language_track_id, video_scene_id, generation)
);

create index video_scene_audio_track_gen_idx
  on video_scene_audio (content_language_track_id, generation);

create trigger trg_video_scene_audio_updated
  before update on video_scene_audio
  for each row execute function update_updated_at();

-- ── 5. video_captions ────────────────────────────────────────────────────────
-- Per language track (not per scene — one transcription covers the whole
-- track's assembled audio). Never shared across languages even though both
-- key off the same shared scenes (ARCHITECTURE.MD §6.5).
create table video_captions (
  id                        uuid primary key default gen_random_uuid(),
  content_language_track_id uuid not null references content_language_tracks(id),
  generation                int not null,
  provider_ref              text,
  timing_data               jsonb,
  file_url                  text,
  status                    text not null default 'pending'
                              check (status in ('pending', 'generating', 'ready', 'failed')),
  attempt_number            int not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint video_captions_track_gen_key
    unique (content_language_track_id, generation)
);

create trigger trg_video_captions_updated
  before update on video_captions
  for each row execute function update_updated_at();

-- ── 6. RLS — mirror the exact pattern the Blog migration used for its four
-- new tables (authenticated blanket access, no anon policy — internal
-- pipeline state, never publicly readable) ──────────────────────────────────
alter table video_scenes      enable row level security;
alter table video_scene_audio enable row level security;
alter table video_captions    enable row level security;

create policy auth_read_video_scenes on video_scenes
  for select to authenticated using (true);
create policy auth_write_video_scenes on video_scenes
  for all to authenticated using (true) with check (true);

create policy auth_read_video_scene_audio on video_scene_audio
  for select to authenticated using (true);
create policy auth_write_video_scene_audio on video_scene_audio
  for all to authenticated using (true) with check (true);

create policy auth_read_video_captions on video_captions
  for select to authenticated using (true);
create policy auth_write_video_captions on video_captions
  for all to authenticated using (true) with check (true);

commit;
