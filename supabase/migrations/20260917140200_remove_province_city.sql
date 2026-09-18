-- Province/city targeting is no longer part of the job or image prompt contract.
-- Existing values are intentionally deleted; scene_notes and image_answers remain.

alter table content_jobs
  drop column if exists province,
  drop column if exists city;
