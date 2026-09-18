-- Adds the columns the new in-repo social-posting worker needs on
-- social_platform_logs, replacing n8n's submit-to-upload-post.com/poll call
-- (see ARCHITECTURE.MD §2.5, docs/IMPLEMENTATION_PLAN.md Phase 4). Mirrors
-- the submit/poll shape worker/src/adapters/avMerger.ts already uses
-- against the same provider for video render — social posting becomes
-- another "submit, store a provider job ref, poll on later ticks" job the
-- worker's own loop drives, instead of a fire-and-forget call into n8n.
--
-- job_id: formalizes a column the callback route (src/app/api/webhooks/
-- n8n-callback/route.ts) already writes into this table without it being
-- declared anywhere in the schema or src/types/content.ts's
-- SocialPlatformLog — ARCHITECTURE.MD §3.5 flags this exact drift. FK'd to
-- content_jobs so a platform log can be looked up by job without a join
-- through social_posts, and backfilled below from social_posts for any
-- rows written before this migration.
--
-- provider_job_ref: upload-post.com's async job id, held between poll
-- ticks — same role AVMergeJobRef.providerRef plays for video render.
--
-- attempt_count / last_attempted_at: what the old n8n flow never had.
-- Confirmed live (TASKS.md, PROGRESS.md) that social_posts rows can get
-- stuck at status='posting' forever with zero matching platform logs and
-- no error surfaced anywhere. last_attempted_at lets the worker's poll
-- loop flip a row stuck in 'posting' past a staleness cap to 'failed' with
-- a real error_message instead of polling indefinitely.
alter table social_platform_logs
  add column if not exists job_id uuid references content_jobs(id),
  add column if not exists provider_job_ref text,
  add column if not exists attempt_count int not null default 0,
  add column if not exists last_attempted_at timestamptz;

update social_platform_logs spl
set job_id = sp.job_id
from social_posts sp
where spl.social_post_id = sp.id
  and spl.job_id is null;

create index if not exists idx_social_platform_logs_job_id
  on social_platform_logs (job_id);

-- Supports the worker's poll-loop query: rows waiting to be submitted
-- (status='approved', no provider_job_ref yet) or already submitted and
-- awaiting resolution (status='posting'). 'posted'/'failed' are terminal
-- and never re-queried, so they're deliberately excluded from this index.
create index if not exists idx_social_platform_logs_pending
  on social_platform_logs (status)
  where status in ('approved', 'posting');
