-- Lets the Regenerate dialog's "extra instructions" text actually reach the
-- worker, which only picks up work on its own polling tick — the browser's
-- in-memory instructions string has to be persisted somewhere the worker
-- can read from, the same reason province/city/scene_notes/image_answers
-- were persisted in 20260909120000.
--
-- content_pipelines.regen_instructions: image_post's shared-photo regen
-- (pipeline-scoped, since the photo is shared across languages).
-- content_language_tracks.regen_instructions: blog's copy-only regen
-- (track-scoped, since copy is per-language and this must never touch the
-- shared hero/inline images — ARCHITECTURE.MD's "conflating regenerate the
-- words and regenerate the picture into one button is the wrong
-- implementation").
--
-- Both nullable, additive, overwritten on each regenerate call — no
-- backfill needed.

alter table content_pipelines
  add column if not exists regen_instructions text;

alter table content_language_tracks
  add column if not exists regen_instructions text;

comment on column content_pipelines.regen_instructions is
  'Optional user-provided guidance for the most recent shared-visual regenerate action (image_post photo prompt). Overwritten on each regenerate call.';
comment on column content_language_tracks.regen_instructions is
  'Optional user-provided guidance for the most recent copy-only regenerate action (blog). Overwritten on each regenerate call.';
