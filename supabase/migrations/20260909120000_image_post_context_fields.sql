-- Persists the inputs the old n8n image_post flow sent directly in its
-- webhook payload (never stored in the DB) so the new worker-based pipeline
-- can read them the same way it already reads topic/category/target_audience.
-- Without this, moving image_post's trigger to the new pipeline would
-- silently drop location targeting, scene notes, and the clarifying
-- question answers from influencing the generated photo — see
-- src/app/dashboard/new/page.tsx's buildPayload() for the fields this
-- mirrors (province/city -> buildLocationTargeting(), scene_notes, and the
-- image_questions round-trip's answers array).
--
-- All columns are nullable and additive — safe for existing rows, no
-- backfill needed, no impact on video/blog which don't use these fields.

alter table content_jobs
  add column if not exists province text,
  add column if not exists city text,
  add column if not exists scene_notes text,
  add column if not exists image_answers jsonb;

comment on column content_jobs.province is
  'Manual province override for image_post location targeting; null/omitted means auto-rotation. See buildLocationTargeting() in src/app/dashboard/new/page.tsx.';
comment on column content_jobs.city is
  'Manual city override, only meaningful alongside a non-null province.';
comment on column content_jobs.scene_notes is
  'Free-text scene guidance for image_post photo generation.';
comment on column content_jobs.image_answers is
  'Array of {question, answer} from the image_questions clarifying round-trip, used to build a more targeted photo prompt.';
