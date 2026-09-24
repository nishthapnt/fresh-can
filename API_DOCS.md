# API_DOCS.md — API Reference

---

## Overview

| Field | Value |
|-------|-------|
| **Base URL (Local)** | `http://localhost:3000/api` |
| **Base URL (Production)** | TBD |
| **Auth Method** | Fixed ID/password login, HMAC-signed `fc_session` cookie (see below) |
| **Response Format** | JSON |

---

## Standard Response Format

**Success**
```json
{ "success": true }
```

**Error**
```json
{ "success": false, "error": "Human readable message" }
```

---

## Endpoints

---

### Auth

#### `POST /api/auth/login`
**Auth:** No (this IS the login)
**Description:** Checks credentials against `DASHBOARD_LOGIN_ID` / `DASHBOARD_LOGIN_PASSWORD` env vars. On success, sets an httpOnly `fc_session` cookie (HMAC-signed, 7-day expiry, signed with `AUTH_SECRET`).

**Request Body:**
```json
{ "id": "string", "password": "string" }
```

**Response (success):** `{ "ok": true }` — Status 200, `Set-Cookie: fc_session=...`
**Response (error):** `{ "error": "Invalid ID or password" }` — Status 401
`{ "error": "Login is not configured on the server" }` — Status 500 (missing env vars)

#### `POST /api/auth/logout`
**Auth:** Requires existing session
**Description:** Clears the `fc_session` cookie.
**Response:** `{ "ok": true }`

**Note:** All routes and pages except `/login`, `/api/auth/*`, and `/api/webhooks/*` are gated by `src/proxy.ts`, which redirects unauthenticated requests to `/login?next=<original path>`.

---

### Webhooks

#### `POST /api/webhooks/n8n-callback`
**Auth:** No (called by n8n server)
**Description:** Receives callback events from n8n after content generation or social posting.

**Request Body:**
```json
{
  "job_id": "uuid",
  "content_type": "video | image_post | blog",
  "event": "draft_ready | generation_complete | post_complete",
  "data": {
    // draft_ready:
    "draft_data": { "title": "...", "body": "..." },

    // generation_complete:
    "file_url": "https://...",
    "thumbnail_url": "https://...",
    "output_data": {},

    // post_complete:
    "platform": "instagram | facebook | twitter | x",
    "platform_post_id": "...",
    "post_url": "https://..."
  }
}
```

**Behavior by event:**
| Event | Action |
|-------|--------|
| `draft_ready` | Upserts row in `content_drafts`, sets job status → `draft_ready` |
| `generation_complete` | Upserts row in `generated_content`, sets job status → `ready` when all types done |
| `post_complete` | Upserts row in `social_platform_logs`, updates `social_posts.status` → `posted` |

**Response (success):**
```json
{ "success": true }
```

**Response (error):**
```json
{ "error": "Job not found" }
```
Status: 400 / 404 / 500

---

### Jobs — Blog

#### `POST /api/jobs/[jobId]/blog/draft`
**Auth:** Requires session (gated by `src/proxy.ts`)
**Description:** Saves an edited blog draft independently of Approve. Before this route, an edit only ever persisted bundled inside the Approve action (`PATCH /api/jobs/[jobId]/draft`) — navigating away without approving silently lost it. Only allowed while the draft's `is_approved` is `false`; once approved, edits are rejected (the hero/inline images were already generated against the approved copy).

**Request Body:**
```json
{ "language": "EN | FR", "draft_data": { "post_title": "string", "...": "..." } }
```

**Response (success):**
```json
{ "draft": { "id": "uuid", "draft_data": { "...": "..." }, "is_approved": false } }
```

**Response (error):**
```json
{ "error": "This draft is already approved and can no longer be edited" }
```
Status: 400 (invalid language/missing draft_data) / 404 (no draft for that language) / 409 (already approved) / 500

---

### Jobs — Image

#### `POST /api/jobs/[jobId]/image/questions`
**Auth:** Requires session (gated by `src/proxy.ts`)
**Description:** Generates 2-3 clarifying questions (topic/scene detail gaps) to show before image_post generation. Reads job inputs directly from `content_jobs` and calls OpenAI (`gpt-4o-mini`) directly — replaces the old n8n `image_questions` webhook, which no longer exists.

**Request Body:** none

**Response (success):**
```json
{ "questions": [{ "id": 1, "question": "string", "options": ["string"], "placeholder": "string?" }] }
```

**Response (error):**
```json
{ "error": "Job not found" }
```
Status: 404 / 500 / 502

---

### Jobs — Video

#### `POST /api/jobs/[jobId]/video/script`
**Auth:** Requires session (gated by `src/proxy.ts`)
**Description:** Edits per-scene narration text before approval. Writes `video_scenes.narration_intent.text` (preserving every other field already on that scene's `narration_intent`) — the field `localize_script`/`synthesize_voice` actually read, not the `content_drafts.draft_data.script` summary blob. Also recomputes that summary blob from the edited scenes so the pre-approval "Script" card stays consistent. Only allowed while the video pipeline's status is `draft_ready`; once approved, the scene plan is locked and edits are rejected.

Each scene's narration is capped at a word budget derived from its own `target_duration_ms` (`src/lib/videoNarrationBudget.ts`'s `maxNarrationWords` — the same ~3.1 words/sec rate `localize_script`'s per-language rewrite targets, plus ~15% tolerance for the render step's own slack). An edit that would exceed a scene's budget is rejected with a 400, naming the scene and its limit.

**Request Body:**
```json
{ "scenes": [{ "id": "uuid", "narration": "string" }] }
```

**Response (success):**
```json
{
  "scenes": [ /* full current scene list, with edits applied */ ],
  "draft": { "id": "uuid", "draft_data": { "script": "string", "...": "..." } }
}
```

**Response (error):**
```json
{ "error": "Script can only be edited while the pipeline is draft_ready (current: approved)" }
```
```json
{ "error": "Scene 2's narration is too long for its 8s budget (35 words, max 29)" }
```
Status: 400 (invalid/unknown scene id, empty narration, over word budget) / 404 (no pipeline or no scenes) / 409 (not `draft_ready`) / 500

---

## n8n Outbound Webhooks (called by this app, not routes)

These are fired from the frontend — documented here for reference.

### New Content Submission
**URL:** Depends on content type (see CLAUDE.md)
**Method:** POST
**Payload:**
```json
{
  "job_id": "uuid",
  "topic": "string",
  "keywords": "string",
  "category": "string",
  "target_audience": "string",
  "language": "EN | FR | BOTH",
  "brand": "Fresh-CAN",
  "content_type": "video | image_post | blog"
}
```

### Draft Approved → Re-generate
**URL:** Same webhook URLs as above
**Method:** POST
**Payload:**
```json
{
  "job_id": "uuid",
  "content_type": "video | image_post | blog",
  "draft_data": {},
  "brand": "Fresh-CAN"
}
```

### Social Post Approved
**URL:** `N8N_SOCIAL_WEBHOOK` (see `.env.example` — not hardcoded here)
**Method:** POST
**Payload:**
```json
{
  "job_id": "uuid",
  "social_post_id": "uuid",
  "content_type": "video | image_post | blog",
  "caption": "string",
  "hashtags": ["tag1", "tag2"],
  "platforms": ["instagram", "facebook"],
  "brand": "Fresh-CAN"
}
```

---

## Changelog

| Date | Change | Endpoint |
|------|--------|----------|
| 2026-06-15 | Created | POST /api/webhooks/n8n-callback |
| 2026-07-17 | Created | POST /api/auth/login |
| 2026-07-17 | Created | POST /api/auth/logout |
| 2026-09-14 | Created (replaces n8n `image_questions` webhook) | POST /api/jobs/[jobId]/image/questions |
| 2026-09-24 | Created | POST /api/jobs/[jobId]/video/script |
| 2026-09-24 | Created | POST /api/jobs/[jobId]/blog/draft |
