-- User-selectable narration voice per language, for video jobs — read
-- directly by the worker (worker/src/index.ts's fetchJobInputs) and passed
-- to synthesize_voice as an override of the fixed brand-profile default
-- (worker/src/prompts/brand/fresh-can.ts's videoVoiceIds). No CHECK
-- constraint: unlike aspect_ratio/video_duration_seconds' small fixed
-- option sets, this is a curated-but-editable list maintained in
-- src/lib/videoVoices.ts on the app side, not a DB-level enum — locking it
-- to a CHECK list here would need a migration every time the curated list
-- changes. Defaults match today's hardcoded brand-profile voice IDs
-- exactly, so every existing job (and every new job that doesn't touch
-- this field) keeps its current voice with zero behavior change.
alter table content_jobs
  add column if not exists voice_id_en text not null default 'epkQ8pqDcY2DxhmFi8xl',
  add column if not exists voice_id_fr text not null default 'n2pCwUKS6q9Iur03Rten';
