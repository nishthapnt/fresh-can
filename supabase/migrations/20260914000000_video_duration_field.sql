-- User-selected per video job — one of the dashboard's fixed duration
-- options (src/app/dashboard/new/page.tsx's VIDEO_DURATIONS: 24-52s in 4s
-- steps), read directly by the worker (worker/src/index.ts's
-- fetchJobInputs) and passed to generate_script as a target for the
-- script's total runtime — worker/src/prompts/core/composeText.ts's
-- composeVideoScriptSystemPrompt. Existed only in the browser's local form
-- state until now: the job-creation insert (src/app/dashboard/new/page.tsx)
-- never persisted it (it was read solely by the old n8n buildPayload
-- branch, dead now that video runs on the worker), so the worker had no
-- length signal at all and the model was free to invent any total runtime
-- within its own "4-10 scenes" instruction — confirmed live 2026-09-13: a
-- real run picked 9 scenes at 10s each (90s), nearly double the UI's own
-- 52s ceiling, which is what pushed the render past Supabase Storage's
-- global upload size limit. Same additive/nullable-with-check convention
-- as aspect_ratio (20260912120000)/image_style (20260910000000).
alter table content_jobs
  add column if not exists video_duration_seconds integer not null default 36
  check (video_duration_seconds in (24, 28, 32, 36, 40, 44, 48, 52));
