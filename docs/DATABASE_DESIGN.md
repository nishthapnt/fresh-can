# Fresh-CAN — Target Database Design

**Status:** Planning only. No migration SQL, no database changes, no application code changes in this document or as a result of it.

**Basis:** `ARCHITECTURE.MD` (finalized, see especially §5, §6, §10, §17, §18) plus the live Supabase schema audit performed during architecture finalization (`information_schema` column dump, PK/FK/unique-constraint queries, enum values, RLS policies, triggers, and real sample rows from `content_drafts`/`generated_content`).

**Legend:** `[KEPT]` `[MODIFIED]` `[NEW]` `[DEPRECATED]` — used on every table heading below, per the disposition categories you asked for. See §6 for the full current → target mapping table and why "split" and "merge" don't actually apply to any live table in this design (explained there, not glossed over).

---

## 1. Design Principles (recap)

Everything below implements one idea, applied consistently: **one job → one shared "pipeline" per content type → N language tracks (1 for EN-only/FR-only, 2 for BOTH) → language-specific outputs.** What differs between video, image, and blog is only *what's shared* and *what's per-language* — never the shape of the split. Full rationale lives in `ARCHITECTURE.MD` §4.1/§17.4/§18; this document is the schema that shape compiles down to.

| Content type | Shared (once per job) | Per-language (once per track) |
|---|---|---|
| Video | Script + scene plan, character reference, per-scene visual clips | Localized narration, audio, captions, final render |
| Image | The one photo (language-neutral prompt) | Caption, hashtags, alt text |
| Blog | Hero + inline images | Title, slug, body copy, SEO fields |

A second, smaller principle governs every state/status column added in this design (explained fully in §3.3): **native Postgres enums only where the value set is genuinely identical for every content type; `text` + `CHECK` where it legitimately differs by type.** The live schema audit found zero `CHECK` constraints anywhere today — this design doesn't chase that gap everywhere, but does add targeted `CHECK`s exactly where the audit found a real defect they'd have caught (see §3.2 and §9).

---

## 2. Cross-Cutting Concerns

### 2.1 Shared vs. language-specific data

Every content type's data now falls into exactly one of two buckets, structurally, not by convention:

- **Shared** (owned by `content_pipelines`, materialized in `content_visual_assets` and, for video only, `video_scenes`): generated once, tagged with a `generation` number, written *only* by shared-step handlers. No per-language code path can write here — see §2.5.
- **Per-language** (owned by `content_language_tracks`, materialized in `content_drafts`/`generated_content` and, for video only, `video_scene_audio`/`video_captions`): generated once per requested language, independently retryable, independently approvable, independently postable.

Nothing in this schema has a "maybe shared, maybe not" column — a table is either scoped to `content_pipeline_id` (shared) or `content_language_track_id` (per-language), and `content_drafts`/`generated_content` (the two tables both kinds of content need) carry both FKs, nullable, with a `CHECK` enforcing exactly one is set (§4.7, §4.9).

### 2.2 EN / FR / BOTH representation

- **`content_jobs.language`** stays a free `text` field (`EN`/`FR`/`BOTH`) — it's *intent*, captured once at job creation, never read by any downstream generation logic. It exists for display and for deriving `requestedLanguages` at approval/generation time.
- **Every row below the job level that represents one specific artifact** — `content_language_tracks.language`, `social_posts.language`, `generated_content.language` — uses a new `content_language` enum restricted to `EN`/`FR` **only**. `BOTH` is structurally impossible here. This is not a theoretical safeguard: the live audit found a real `generated_content` row with `language = 'BOTH'` and a caption string with English and French concatenated by `" / "`. That defect can only exist because the column that held it allowed a value that doesn't describe a single artifact. The new enum makes it a type error, not a code-review catch.
- `BOTH` is represented purely as **two rows** — two `content_language_tracks`, two `generated_content`, up to two `social_posts` — never as a third enum value anywhere below the job level.

### 2.3 Status / state fields

Three different treatments, chosen deliberately, not uniformly:

1. **Truly universal, flat value sets stay native Postgres enums** — `content_type` (`image_post|video|blog`, unchanged), `social_status` (unchanged, already matches the target state machine exactly), and the new `content_language` (`EN|FR`, §2.2). These are identical for every row that has them; a native enum is the right, cheap guarantee.
2. **Per-content-type-varying state machines are `text` + `CHECK`, not a native enum.** `content_pipelines.status` and `content_language_tracks.status` each have a documented, `CHECK`-constrained value list, but the *legal subset* of that list differs by `content_type` (video's track uses `rendering`; image/blog's track never does). Union-ing two different automatons' vocabularies into one Postgres `ENUM` type would make illegal state/type combinations *representable* even though they're not *possible* — worse than the status quo, not better. `CHECK` gets the same "no typo'd value" protection without forcing one shape onto genuinely different processes. This is the direct answer to "support all four consistently without forcing unnecessary identical structures."
3. **`pipeline_steps.status` is one small enum-like `CHECK` shared by literally everything** (`pending|running|succeeded|failed_retryable|failed_terminal|superseded`) — this one really is identical regardless of content type or which layer (shared vs. track) the step belongs to, so it's the one state column safe to treat as uniform.

`content_jobs.status` (the existing `job_status` enum) is kept, but its role changes: it becomes a **read-side projection**, recomputed by the backend from child `content_pipelines`/`content_language_tracks` rows, never written directly by a client or a worker mid-flight (§4.1, §7.4). Concretely, this needs **two enum values added** (`partial_draft_ready`, `partial_ready`) that don't exist in the live `job_status` enum today — see §7.4 for why, and §9 for the flagged one-line schema change this requires.

### 2.4 Approval & retry support

- **Approval** is tracked with an `approved_at`/`approved_by` pair, present on `content_pipelines` (populated only for video's project-level script approval — image/blog have no project-level gate, §6.4 of the architecture doc) *and* on `content_language_tracks` (populated only for image/blog's per-language caption/copy approval — video's track has no separate approval step, since its wording was already approved at the project level). Both columns exist on both tables; which one actually gets populated is a function of `content_type`, not a schema difference. This is the same "same shape, different subset used" principle as §2.3.
- **Retry** is tracked at two levels: `retry_count`/`last_error`/`current_step` directly on `content_pipelines` and `content_language_tracks` for cheap, no-join status display, and the full attempt history in `pipeline_steps` (one row per attempt, every content type, every layer) for the durable log a reconciliation sweeper or an operator view actually needs. `social_platform_logs.retry_count`/`last_retry_at` — already real, working columns in the live schema — are kept as a denormalized read cache fed alongside `pipeline_steps`, not replaced by it (§7.8).

### 2.5 Idempotency

Three independent mechanisms, each closing a different gap the live audit found (§3.3 of the architecture doc — no idempotency anywhere today):

1. **Pipeline creation**: `content_pipelines.idempotency_key`, unique, dedupes a double-submitted "start this job's video/image/blog work" action.
2. **Per-step execution**: no single "idempotency key" column on `pipeline_steps` — instead, a step handler queries `pipeline_steps WHERE (content_pipeline_id | content_language_track_id) = :id AND step_name = :name AND generation = :gen AND status = 'succeeded'` before doing any provider call (indexes in §4.2 support this directly). A composite unique constraint was considered and rejected: `pipeline_steps` is an append-only attempt log by design (one row per attempt), so uniqueness would have to include `attempt_number`, which doesn't prevent the actual bug (a second *different* attempt of the same step) — the query-based check does.
3. **Inbound provider callbacks**: `webhook_inbound_events`, unique on `(source, external_event_id)` — a callback that arrives twice from the same provider is processed once.
4. **Structural idempotency for "retry can't touch the shared asset"**: not a schema mechanism at all — it's a code-module boundary (§10.1/§18 of the architecture doc). Worth restating here because it's easy to assume this document should add a table constraint for it: there isn't one, and there shouldn't be one. A track-retry handler simply has no FK, no table reference, and no import path to `content_visual_assets`'s writer. That's a stronger guarantee than a runtime check.

### 2.6 Generation / versioning

`content_pipelines.current_generation` (int, starts at 1) is the single fencing counter for everything shared. It's bumped only by an explicit regeneration action, never by a retry. `content_visual_assets` and `video_scenes` rows are tagged with the generation they belong to; a query for "the current shared asset(s)" always filters on `generation = content_pipelines.current_generation`. `content_language_tracks.master_generation_used` records which generation a track was (re)started against — comparing it to the pipeline's `current_generation` is what distinguishes "legitimately waiting" from "stale because the shared layer moved on." Video's track-level generation (`video_scene_audio.generation`/`video_captions.generation`) is a *second*, independent counter — it only bumps on a full script-level reset, not on a visuals-only regeneration, which is exactly what lets "regenerate the picture" leave "the words" untouched (§7.6).

---

## 3. Target Schema — Table by Table

### 3.1 `content_jobs` `[KEPT]`

One row per user-submitted job. Unchanged in shape; its `status` column's *meaning* changes (§2.3) but not its type or values.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `topic`, `keywords`, `category`, `brand`, `target_audience` | text | unchanged |
| `language` | text, default `'EN'` | intent only — `EN`\|`FR`\|`BOTH`, unconstrained at DB level as today (§2.2) |
| `status` | `job_status` enum | becomes a computed projection (§2.3, §7.4) — **enum needs 2 new values, see §9** |
| `content_types` | text[] | unchanged |
| `n8n_job_id`, `webhook_sent_at` | text / timestamptz | **legacy** — dead once n8n is fully retired; not removed by this design, flagged for a later cleanup pass |
| `video_url` | text | **unresolved** — exists live despite a recent commit implying it didn't (`1be76e6`); do not touch until that's clarified outside this document |
| `created_by` | uuid, no FK | unchanged — no real per-user identity system exists; out of scope here |
| `script_type`, `duration_sec` | text / numeric | unchanged |
| `created_at`, `updated_at`, `completed_at` | timestamptz | unchanged |

No new columns. No FK changes.

### 3.2 `content_pipelines` `[NEW]`

The shared/project entity for **every** content type — video, image, and blog alike. One row per `(job_id, content_type)`, always, regardless of how many languages were requested.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `job_id` | uuid FK → `content_jobs.id` | NOT NULL |
| `content_type` | `content_type` enum | NOT NULL — reuses the existing enum unchanged |
| `current_generation` | int, default 1 | version fence, §2.6 |
| `status` | text, default `'created'` | `CHECK IN ('created','drafting','draft_ready','awaiting_approval','approved','generating','ready','stale','failed')` — video uses the full set; image/blog only ever occupy `created`→`generating`→`ready`/`stale`/`failed` (§2.3) |
| `current_step` | text | e.g. `generate_script`, `generate_character_ref`, `generate_photo` — fine-grained display without a heavier state column |
| `retry_count` | int, default 0 | |
| `last_error` | text | |
| `scenes_total`, `scenes_visuals_ready_count` | int, nullable | **video-only** fan-in counters; always NULL for image/blog — an explicit example of "not forcing identical structures" |
| `approved_at`, `approved_by` | timestamptz / uuid | populated only for video (§2.4) |
| `idempotency_key` | text | dedupes pipeline creation (§2.5) |
| `created_at`, `updated_at` | timestamptz | |

**Constraints:** `UNIQUE(job_id, content_type)` · `UNIQUE(idempotency_key) WHERE idempotency_key IS NOT NULL`
**Indexes:** `(status, updated_at)` — supports the reconciliation sweeper scanning for stuck pipelines (§10 of the architecture doc)

### 3.3 `pipeline_steps` `[NEW]`

Durable attempt log, one row per attempt, shared by every worker and every content type — this is the table that makes "what actually happened, and when" a queryable fact instead of something that only ever lived inside an n8n execution log.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `content_pipeline_id` | uuid FK → `content_pipelines.id`, nullable | set for shared/project-scoped steps |
| `content_language_track_id` | uuid FK → `content_language_tracks.id`, nullable | set for language-track-scoped steps |
| `step_name` | text NOT NULL | e.g. `generate_script`, `generate_scene_visual`, `generate_caption`, `render` |
| `generation` | int NOT NULL | the generation this attempt ran against |
| `attempt_number` | int, default 1 | |
| `status` | text NOT NULL | `CHECK IN ('pending','running','succeeded','failed_retryable','failed_terminal','superseded')` |
| `provider` | text | `openai`\|`elevenlabs`\|`assemblyai`\|`kie`\|`upload-post`, nullable for non-provider steps |
| `input_snapshot`, `output_snapshot` | jsonb | |
| `error_message` | text | |
| `started_at`, `finished_at`, `created_at` | timestamptz | |

**Constraint:** `CHECK ((content_pipeline_id IS NOT NULL)::int + (content_language_track_id IS NOT NULL)::int = 1)` — exactly one scope per row, always.
**Indexes:** `(content_pipeline_id, step_name, generation, status)` · `(content_language_track_id, step_name, generation, status)` — both directly support the idempotency check in §2.5.

### 3.4 `content_visual_assets` `[NEW]`

The shared, language-independent generated media — for **any** content type.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `content_pipeline_id` | uuid FK → `content_pipelines.id` | NOT NULL |
| `video_scene_id` | uuid FK → `video_scenes.id`, nullable | **video-only** — NULL for the character reference (project-level) and always NULL for image/blog |
| `generation` | int NOT NULL | |
| `asset_type` | text NOT NULL | `CHECK IN ('character_ref','scene_image','scene_video_clip','photo','hero_image','inline_image')` |
| `status` | text, default `'pending'` | `CHECK IN ('pending','generating','ready','failed')` |
| `provider_ref` | text | the provider's own task/job id |
| `file_url` | text | |
| `duration_ms` | int, nullable | video's `scene_video_clip` only |
| `attempt_number` | int, default 1 | |
| `created_at`, `updated_at` | timestamptz | |

**Constraints:** `UNIQUE(content_pipeline_id, asset_type, generation) WHERE video_scene_id IS NULL` (character ref, photo, hero image, and blog's inline image — Blog has exactly one hero_image row and one inline_image row per generation, distinguished by asset_type, not by a separate index) · `UNIQUE(content_pipeline_id, video_scene_id, asset_type, generation) WHERE video_scene_id IS NOT NULL` (per-scene video assets). These are a DB-level backstop behind the application-level idempotency key (§2.5) — a defense-in-depth choice, not the primary mechanism.

### 3.5 `video_scenes` `[NEW, video-only]`

The language-neutral scene plan. Does not exist for image or blog — they have no scene concept, just flat rows on `content_visual_assets`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `content_pipeline_id` | uuid FK → `content_pipelines.id` | NOT NULL |
| `generation` | int NOT NULL | tagged so a script-level regeneration doesn't collide with the prior scene set |
| `scene_number` | int NOT NULL | |
| `visual_description`, `shot_notes` | text | the language-neutral visual prompt content |
| `narration_intent` | jsonb NOT NULL | **semantic** content to be localized per language — never literal wording (this is what prevents the localize step from becoming a second creative-generation call, §17.1/§18) |
| `target_duration_ms` | int | a duration *budget*, not an exact figure (§4.2's duration-handling design) |
| `created_at` | timestamptz | |

**Constraint:** `UNIQUE(content_pipeline_id, generation, scene_number)`

### 3.6 `content_language_tracks` `[NEW]`

One row per **requested** language, for every content type — this is the table that makes "how many languages were requested" a row count, not a branch in generation logic.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `content_pipeline_id` | uuid FK → `content_pipelines.id` | NOT NULL |
| `language` | `content_language` enum (`EN`\|`FR`) | NOT NULL — never `BOTH` (§2.2) |
| `status` | text, default `'waiting_on_shared'` | `CHECK IN ('waiting_on_shared','generating','draft_ready','awaiting_approval','approved','awaiting_shared','rendering','ready','stale','failed')` — video uses the full set including `awaiting_shared`/`rendering`; image/blog use `waiting_on_shared→generating→draft_ready→awaiting_approval→approved→ready` plus `stale`/`failed` (§2.3) |
| `current_step` | text | |
| `master_generation_used` | int NOT NULL | fences which shared generation this track was (re)started against (§2.6) |
| `retry_count` | int, default 0 | |
| `last_error` | text | |
| `approved_at`, `approved_by` | timestamptz / uuid | populated only for image/blog (§2.4) |
| `created_at`, `updated_at` | timestamptz | |

**Constraint:** `UNIQUE(content_pipeline_id, language)` — this is the row a `BOTH` request creates two of; EN-only/FR-only create exactly one.
**Index:** `(status, updated_at)` — reconciliation sweeper.

### 3.7 `video_scene_audio` `[NEW, video-only]`

Per language track, per scene.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `content_language_track_id` | uuid FK → `content_language_tracks.id` | NOT NULL |
| `video_scene_id` | uuid FK → `video_scenes.id` | NOT NULL |
| `generation` | int NOT NULL | the **track's** generation — bumped only on a full script-level reset, not a visuals-only one (§2.6) |
| `narration_text` | text NOT NULL | localized wording, produced by `localize_script` |
| `file_url`, `duration_ms`, `provider_ref` | text / int / text | |
| `status` | text, default `'pending'` | `CHECK IN ('pending','generating','ready','failed')` |
| `created_at` | timestamptz | |

**Constraint:** `UNIQUE(content_language_track_id, video_scene_id, generation)`

### 3.8 `video_captions` `[NEW, video-only]`

Per language track — one row per track generation (transcription produces one timed-caption document per full narration track, not per scene).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `content_language_track_id` | uuid FK → `content_language_tracks.id` | NOT NULL |
| `generation` | int NOT NULL | |
| `provider_ref` | text | |
| `timing_data` | jsonb | |
| `file_url` | text | srt/vtt |
| `status` | text, default `'pending'` | |
| `created_at` | timestamptz | |

**Constraint:** `UNIQUE(content_language_track_id, generation)`

### 3.9 `content_drafts` `[MODIFIED]`

**Kept columns:** `id`, `draft_data` (jsonb), `original_data` (jsonb), `is_approved`, `is_edited`, `approved_at`, `approved_by`, `created_at`, `updated_at`.

**Dropped columns:** `job_id`, `content_type`, `language`, `status`.

**Added columns:** `content_pipeline_id` uuid FK → `content_pipelines.id`, nullable · `content_language_track_id` uuid FK → `content_language_tracks.id`, nullable.

| Content type | Which FK is set | What the draft holds |
|---|---|---|
| Video | `content_pipeline_id` | the ONE master script + scene plan draft |
| Image / Blog | `content_language_track_id` | one draft per requested language (caption/hashtags/alt text, or title/body/SEO) |

**Constraints:** `CHECK ((content_pipeline_id IS NOT NULL)::int + (content_language_track_id IS NOT NULL)::int = 1)` · `UNIQUE(content_pipeline_id) WHERE content_pipeline_id IS NOT NULL` · `UNIQUE(content_language_track_id) WHERE content_language_track_id IS NOT NULL`.

**Why `job_id`/`content_type`/`language`/`status` are dropped, not kept as denormalized convenience (contrast with §3.10):** `content_drafts` is an internal editing surface, not a Library/public-facing read path — the audit found no evidence of heavy direct filtering on these columns outside of joins the new FK chain already satisfies. `status` specifically becomes fully redundant once the owning `content_pipelines`/`content_language_tracks` row carries the real state machine — keeping a second, independent status column on the draft itself is exactly the kind of "three different status representations" the audit flagged as a live problem (`content_jobs.status`, `content_drafts.status`, `generated_content.status` all meant slightly different things today). This design removes one of those three rather than adding a fourth.

### 3.10 `generated_content` `[MODIFIED]`

**Kept columns:** `id`, `file_url`, `thumbnail_url`, `output_data` (jsonb), `generation_started_at`, `generation_finished_at`, `generation_error`, `is_ready`, `status` (default `'completed'`), `created_at`, `updated_at`, `job_id`, `content_type`, `language`.

**Added columns:** `content_pipeline_id` uuid FK → `content_pipelines.id`, NOT NULL · `content_language_track_id` uuid FK → `content_language_tracks.id`, NOT NULL · `quality_flag` text, `CHECK IN ('ok','degraded_fallback')`.

**Flagged as deprecation candidates, kept for now (not confirmed fully dead):** `alt_text`, `headline_text`, `subtitle_text`, `kie_image_url`, `caption`, `hashtags` (text), `image_url`, `topic`, `category` — every sampled live row had these `NULL`, with the real data sitting in `output_data` instead, but that's eight sample rows, not a call-site audit. Recommend confirming no code path writes or reads them before dropping.

**Why `job_id`/`content_type`/`language` are kept here, denormalized, unlike `content_drafts` (§3.9):** this table backs the Library grid's heavy filter/sort queries (confirmed in the current `contentService.ts` usage pattern) — a join-per-row cost there is a real, measurable tradeoff a purely-normalized schema would impose for no correctness benefit, since these values can never drift from their source once written (the write path derives them from the same `content_language_track_id` at insert time, not from separate user input).

**Constraints:** `UNIQUE(content_language_track_id)` — **replaces** the live `UNIQUE(job_id, content_type, language)` entirely; that constraint's job is now done one level up, by `content_language_tracks`' own uniqueness.
**Index:** `(job_id, content_type, language)`, non-unique — preserves the Library page's existing query performance.

**Why `status = 'completed'` is untouched:** a live RLS policy (`"Public read completed"`, `anon` role, `qual: status = 'completed'`) keys off that exact literal string. `quality_flag` is additive, never a replacement — changing the terminal value here would silently break public content visibility with no error anywhere in the application.

### 3.11 `social_posts` `[MODIFIED]`

**Kept columns:** `id`, `job_id` FK, `content_type`, `caption`, `hashtags` (text[]), `platforms` (platform_type[]), `is_edited`, `original_caption`, `status` (`social_status` enum, unchanged), `approved_at`, `approved_by`, `scheduled_at`, `created_at`, `updated_at`.

**Added columns:** `language` `content_language` enum, NOT NULL · `content_language_track_id` uuid FK → `content_language_tracks.id`, NOT NULL.

**Constraint:** `UNIQUE(job_id, content_type, language)` — **widens** the live `UNIQUE(job_id, content_type)`, which today makes it structurally impossible to represent two language-specific posts for one job × content type. A `BOTH` job now produces two independent `social_posts` rows.

### 3.12 `social_platform_logs` `[KEPT]`

Unchanged. `retry_count`/`last_retry_at` — already real, working columns — stay as a denormalized read cache fed alongside `pipeline_steps`, per §2.4. `UNIQUE(social_post_id, platform)` unchanged.

**Cleanup note, not a schema change:** the live `platform_type` enum has both `twitter` and `x` as separate values. Worth confirming which one the application actually writes before this ships — if both are in live use for what's really one platform, that's a data-hygiene question to resolve, not something this design can fix by adding a column.

### 3.13 `provider_credentials` `[NEW]`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `provider_name` | text NOT NULL | `openai`\|`elevenlabs`\|`assemblyai`\|`kie`\|`upload-post` |
| `secret_ref` | text NOT NULL | pointer into a secrets manager — **never** the raw secret |
| `rotated_at` | timestamptz | |

**Constraint:** `UNIQUE(provider_name)` — one active credential per provider.

### 3.14 `webhook_inbound_events` `[NEW]`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `source` | text NOT NULL | which provider/callback route this came from |
| `external_event_id` | text NOT NULL | provider-supplied id, or a hash of the payload if none exists |
| `payload` | jsonb | |
| `received_at`, `processed_at` | timestamptz | |
| `result` | text | |

**Constraint:** `UNIQUE(source, external_event_id)` — composite, not just `external_event_id` alone, since different providers could plausibly issue overlapping ids.

### 3.15 `job_overview` (view) `[DEPRECATED]`

The live view already does part of §2.3's job by computing per-content-type approval flags (`video_draft_approved`, etc.) and URLs via `LEFT JOIN`s against `content_drafts`/`generated_content`/`social_posts`. It's superseded by the backend-computed aggregate status (§2.3, §7.4) reading `content_pipelines`/`content_language_tracks` directly — those tables now carry a real state machine per pipeline and per track, which this view's ad hoc `MAX(CASE WHEN ...)` pattern can't represent (it has no way to show "EN ready, FR failed" for a `BOTH` job, for instance). Recommend dropping it once the new status computation ships; not required to drop before then, since nothing in the target schema depends on it existing or not existing.

---

## 4. Entity-Relationship Diagram

```
content_jobs
     │ 1:N
     ▼
content_pipelines (1 per job × content_type — video, image_post, OR blog)
     │
     ├──1:N──▶ content_visual_assets ◀──┐
     │                                   │ (video_scene_id FK,
     │         video_scenes ─────────────┘  video-only)
     │           (video-only)
     │
     ├──1:N──▶ content_language_tracks (one per requested language)
     │               │
     │               ├──1:N──▶ video_scene_audio (video-only)
     │               ├──1:N──▶ video_captions (video-only)
     │               │
     │               ├──0:1──▶ content_drafts (image/blog: keyed here;
     │               │                          video: keyed to content_pipelines
     │               │                          directly instead, dashed line below)
     │               │
     │               ├──1:1──▶ generated_content (final output, one per track,
     │               │                             any content type)
     │               │
     │               └──0:N──▶ social_posts (one per language, independently
     │                                        postable — §2.2)
     │                              │
     │                              └──1:N──▶ social_platform_logs
     │
     └╌╌0:1╌╌▶ content_drafts (video only: the ONE master script draft,
                               keyed to content_pipeline_id instead of a track)

pipeline_steps ──scoped to either── content_pipelines OR content_language_tracks
                                     (never both, never neither — §3.3's CHECK)
```

---

## 5. Enum & CHECK Summary

| Type | Kind | Values | Used by |
|---|---|---|---|
| `content_type` | native enum, unchanged | `image_post`, `video`, `blog` | `content_pipelines`, `generated_content`, `social_posts`, `pipeline_steps` (indirectly via parent) |
| `job_status` | native enum, **2 values added** | `pending`, `partial_draft_ready`\*, `draft_ready`, `approved`†, `generating`, `ready`, `failed`, `partial_ready`\* | `content_jobs.status` |
| `social_status` | native enum, unchanged | `pending_approval`, `approved`, `posting`, `posted`, `failed` | `social_posts.status` |
| `platform_type` | native enum, unchanged (cleanup flagged) | `instagram`, `facebook`, `twitter`, `x` | `social_posts.platforms`, `social_platform_logs.platform` |
| `content_language` | **new native enum** | `EN`, `FR` — no `BOTH` (§2.2) | `content_language_tracks.language`, `social_posts.language`, `generated_content.language` |
| `content_pipelines.status` | `text` + `CHECK` | `created`, `drafting`, `draft_ready`, `awaiting_approval`, `approved`, `generating`, `ready`, `stale`, `failed` | `content_pipelines` only |
| `content_language_tracks.status` | `text` + `CHECK` | `waiting_on_shared`, `generating`, `draft_ready`, `awaiting_approval`, `approved`, `awaiting_shared`, `rendering`, `ready`, `stale`, `failed` | `content_language_tracks` only |
| `pipeline_steps.status` | `text` + `CHECK` | `pending`, `running`, `succeeded`, `failed_retryable`, `failed_terminal`, `superseded` | `pipeline_steps` only |
| `content_visual_assets.asset_type` | `text` + `CHECK` | `character_ref`, `scene_image`, `scene_video_clip`, `photo`, `hero_image`, `inline_image` | `content_visual_assets` only |
| `generated_content.quality_flag` | `text` + `CHECK` | `ok`, `degraded_fallback` | `generated_content` only |

\* **Needs adding to the live `job_status` enum** — `ARCHITECTURE.MD` §6.2's aggregate-status design requires these two values to represent "some but not all pipelines reached draft_ready/ready" for a multi-content-type job, and neither exists in the live enum today. This is the one place this document identifies a required change to an *existing* enum, as opposed to a wholly new table/column.
† **Becomes unused** once `content_jobs.status` is a computed projection — §6.2's aggregate rules never produce `approved` as a job-level value (approval now happens per-pipeline/per-track, not per-job). Not removed here — Postgres enum value removal is awkward and unnecessary; it's simply a value nothing will write going forward.

---

## 6. Current → Target Table Mapping

**Note on categories used:** every live table maps to exactly one target table, either unchanged or modified in place. **No live table is split into two target tables, and no two live tables are merged into one** — the "merge" that happened during architecture finalization (§18 of `ARCHITECTURE.MD`) was `video_projects`/`video_visual_assets`/`video_language_tracks` — a *previous draft* of this design — collapsing into the generalized tables below; none of those three ever existed in the live database, so nothing physically merges here. Being precise about this matters: it means every row of every live table survives this migration under a clear, traceable rule, not a lossy consolidation.

| Current table | Target table | Disposition | What changes |
|---|---|---|---|
| `content_jobs` | `content_jobs` | **Kept** | No column changes. `status`'s *meaning* changes to computed (§2.3) |
| `content_drafts` | `content_drafts` | **Modified** | Drops `job_id`/`content_type`/`language`/`status`; adds `content_pipeline_id`/`content_language_track_id` |
| `generated_content` | `generated_content` | **Modified** | Adds `content_pipeline_id`/`content_language_track_id`/`quality_flag`; uniqueness moves from `(job_id, content_type, language)` to `content_language_track_id` |
| `social_posts` | `social_posts` | **Modified** | Adds `language`/`content_language_track_id`; uniqueness widens to include `language` |
| `social_platform_logs` | `social_platform_logs` | **Kept** | No changes |
| `job_overview` (view) | — | **Deprecated** | Superseded by backend-computed aggregate status; safe to drop once that ships |
| *(none)* | `content_pipelines` | **New** | No live table plays this role today — closest analog is the implicit "one pipeline per (job, type, language)" that `content_drafts`/`generated_content`'s old unique constraint enforced, which this replaces and generalizes |
| *(none)* | `pipeline_steps` | **New** | Replaces n8n's in-execution retry counters, which lived nowhere durable |
| *(none)* | `content_visual_assets` | **New** | |
| *(none)* | `video_scenes` | **New**, video-only | |
| *(none)* | `content_language_tracks` | **New** | Takes over the per-language identity `content_drafts`/`generated_content` used to carry alone via their `language` column |
| *(none)* | `video_scene_audio` | **New**, video-only | |
| *(none)* | `video_captions` | **New**, video-only | |
| *(none)* | `provider_credentials` | **New** | |
| *(none)* | `webhook_inbound_events` | **New** | |

---

## 7. Reasoning Behind the Important Decisions

1. **`content_pipelines` has no `language` column, for any content type** — the single biggest structural decision in this document. It's what makes video, image, and blog use the literal same table for their shared layer instead of video needing a special-cased schema. Explained fully in §18 of `ARCHITECTURE.MD`; the consequence here is that `content_drafts`/`generated_content`/`social_posts`'s old `(job_id, content_type, language)` identity had to move down one level, to `content_language_tracks`.
2. **`content_language` is a stricter enum than `content_jobs.language`, on purpose** (§2.2) — the audit found a live row proving the looser version (`text`, allowing `BOTH`) actually breaks: a `generated_content.language = 'BOTH'` row with two languages' captions concatenated into one string. The new enum makes that specific defect a type error.
3. **State machines are `text` + `CHECK`, not native enums, exactly where they vary by content type** (§2.3) — a native Postgres enum would force one shared vocabulary across video's richer process and image/blog's simpler one, making illegal state/type combinations representable. `pipeline_steps.status`, by contrast, genuinely is identical everywhere, so it stays a shared `CHECK` set.
4. **`content_drafts` drops its denormalized `job_id`/`content_type`/`language`/`status`; `generated_content` keeps them** (§3.9, §3.10) — these two tables look similar (both hold content-type-specific data keyed to a language) but serve different read patterns. `content_drafts` is an internal editing surface with no heavy direct-filter query pattern found in the audit; `generated_content` backs the Library grid's real, measured filter/sort load. Same underlying principle (avoid drift-prone denormalization) applied to two different conclusions because the actual usage differs — this is the concrete instance of "don't force identical structures."
5. **`content_visual_assets` gets a DB-level uniqueness backstop** (§3.4) in addition to the application-level idempotency key (§2.5) — belt-and-suspenders specifically here because this table is the one every language track depends on staying correct; a duplicate character-reference or photo row would be the exact class of bug (divergent shared assets) this whole redesign exists to prevent.
6. **Video's track-level `generation` (on `video_scene_audio`/`video_captions`) is separate from the pipeline's `current_generation`** (§2.6) — a visuals-only regeneration bumps the pipeline's generation but must NOT bump the track's, or a pure art-style tweak would force a full re-transcription/re-audio cycle for zero reason. Two counters, not one, is what makes that distinction enforceable rather than aspirational.
7. **`content_jobs.status` needs two new enum values it doesn't have today** (§5) — this is the one place the live schema's existing enum genuinely can't represent the target design's aggregate-status logic (`partial_draft_ready`/`partial_ready`, needed for "video ready, blog still generating" or "EN posted, FR failed" style states). Flagged explicitly rather than assumed, since it's an `ALTER TYPE` on an existing, populated enum — a real, if small, migration action.
8. **`generated_content.status = 'completed'` is untouched** (§3.10) — found via the RLS policy audit, not guessable from the application code alone. This is the clearest example in this whole document of why the live-database audit had to happen before schema design, not after.

---

## 8. Explicitly Out of Scope for This Document

- Migration SQL / DDL statements (next step, not this one).
- RLS policy rewrites — noted where a policy constrains a schema decision (§3.10, §12), not redesigned here.
- Storage bucket layout/policies beyond the path-convention note already recorded in `ARCHITECTURE.MD` §5 (`freshcan-videos/{job_id}/{language}.mp4`).
- Backfilling historical data into the new tables — a migration-phase concern (`ARCHITECTURE.MD` §13), not a target-schema concern.
- Dropping the flagged-but-unconfirmed-dead columns on `generated_content` (§3.10) — listed as candidates, not acted on, since they weren't confirmed dead across all call sites.
