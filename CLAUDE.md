# CLAUDE.md — Project Brain

---

## 🏗 PROJECT OVERVIEW

| Field | Value |
|---|---|
| **Project Name** | Fresh-CAN Content Automation Dashboard |
| **Description** | AI-powered dashboard: one form triggers Image Post, Video, Blog, and Social content generation. All four run on Inngest (`src/inngest/functions/`, calling pipeline step logic in `src/server/pipeline/`) triggered from `src/app/api/jobs/[jobId]/{blog,image,video}/` and `src/app/api/social/post/`. n8n is fully retired; the old always-on polling worker (`worker/`) was removed once every content type migrated. See `docs/IMPLEMENTATION_PLAN.md` and `ARCHITECTURE.MD`. |
| **Type** | ✅ Dashboard  ✅ Full-Stack |
| **Start Date** | 2026-06-15 |
| **Status** | ✅ In Progress |

---

## 👥 TEAM

| Name | Role | Tool | Contact |
|------|------|------|---------|
| Pri | Lead Developer / Owner | Claude Code CLI | Pri@aumatic.ai |

---

## 🛠️ TECH STACK

| Layer | Choice | Notes |
|-------|--------|-------|
| **Frontend** | Next.js 16 App Router | `/src/app` |
| **Styling** | Tailwind CSS v4 + ShadCN UI | components in `/src/components/ui` |
| **State** | React hooks + Supabase Realtime | realtime on job detail page |
| **Database** | Supabase (PostgreSQL) | project: `jbrktjnscnzmhwupojiu` |
| **API** | Next.js API Routes (REST) | |
| **Automation** | Inngest (all content types) | `src/inngest/functions/` — event-driven, no polling worker, no n8n |
| **Auth** | Fixed ID/password, HMAC-signed session cookie | `src/proxy.ts` gates all routes; login at `/login` |

---

## 📁 PROJECT STRUCTURE

```
src/
├── app/
│   ├── dashboard/             ← KPI + recent jobs grid
│   │   ├── new/               ← Input form → creates job + pipeline(s)
│   │   ├── jobs/[job_id]/     ← Draft editor (tabbed)
│   │   │   └── social/        ← Caption approval + posting
│   │   └── library/           ← Content library grid
│   └── api/
│       ├── inngest/           ← Inngest route handler (serve())
│       ├── jobs/[jobId]/{blog,image,video}/  ← generate/approve/cancel/regenerate/status
│       └── social/post/       ← creates social_posts row, fires content/social.publish
│
├── inngest/
│   ├── client.ts              ← Inngest client
│   └── functions/             ← blog.ts, image.ts, video.ts, social.ts
│
├── server/
│   └── pipeline/              ← step/adapter/db/prompts logic Inngest functions call
│       ├── steps/{blog,image,video,social}/
│       ├── adapters/          ← OpenAI, KIE, ElevenLabs, AssemblyAI, upload-post.com
│       └── db.ts              ← CAS claim/retry helpers, all Supabase writes for pipelines
│
├── components/
│   ├── layout/                ← Sidebar, DashboardLayout, TopBar
│   ├── ui/                    ← ShadCN primitives
│   ├── skeletons/             ← Loading skeleton components
│   ├── StatusBadge.tsx
│   ├── KPICard.tsx
│   ├── ContentCard.tsx
│   ├── DraftEditor.tsx
│   ├── SocialApprovalCard.tsx
│   └── PlatformSelector.tsx
│
├── services/
│   └── contentService.ts      ← ALL Supabase calls live here
│
├── lib/
│   ├── supabase.ts
│   └── dateUtils.ts
│
└── types/
    ├── content.ts
    └── database.ts
```

---

## 🔐 ENVIRONMENT VARIABLES

```env
NEXT_PUBLIC_SUPABASE_URL=https://jbrktjnscnzmhwupojiu.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from Supabase → Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<from Supabase → Settings → API>
INNGEST_EVENT_KEY=<from Inngest dashboard>
INNGEST_SIGNING_KEY=<from Inngest dashboard>
# Blog + image_post + video generation, and the image_post clarifying-questions
# step — all run on Inngest (src/inngest/functions/) or OpenAI direct
OPENAI_API_KEY=<from platform.openai.com>
KIE_API_KEY=<from kie.ai>
ELEVENLABS_API_KEY=<from elevenlabs.io — video narration>
ASSEMBLYAI_API_KEY=<from assemblyai.com — video caption timing>
UPLOAD_POST_API_KEY=<from upload-post.com — video FFmpeg render + social posting>
```

---

## 🗄️ SUPABASE TABLES

| Table | Purpose |
|-------|---------|
| `content_jobs` | Parent record per submission |
| `content_drafts` | 3 rows per job — editable AI drafts |
| `generated_content` | Final file URLs |
| `social_posts` | Caption + hashtags + platforms |
| `social_platform_logs` | Per-platform post results |

### Status Colors (NEVER deviate)
| Status | Color |
|--------|-------|
| `pending` | Gray |
| `draft_ready` | Amber |
| `approved` / `generating` | Blue |
| `ready` | Green |
| `failed` | Red |
| `posted` | Purple |

---

## 🌐 N8N — FULLY RETIRED

n8n is no longer used anywhere in this app. Every content type (blog,
image_post, video, social) runs on Inngest. `N8N_SOCIAL_WEBHOOK`,
`N8N_WEBHOOK_SECRET`, and `/api/webhooks/n8n-callback` have all been removed.
Image clarifying questions (`image_questions`) run at
`POST /api/jobs/[jobId]/image/questions` (OpenAI direct).

## 🤖 BLOG + IMAGE_POST + VIDEO + SOCIAL PIPELINE (Inngest)

All four content types run on Inngest (`src/inngest/functions/{blog,image,video,social}.ts`,
served from `src/app/api/inngest/route.ts`), calling pipeline step/adapter/db
logic in `src/server/pipeline/`. API routes under
`src/app/api/jobs/[jobId]/{blog,image,video}/` and `src/app/api/social/post/`
create/update Supabase rows and send the corresponding Inngest event — there
is no polling loop or queue. Video is the newest and most complex of the
four: a shared script+scene plan and per-scene visuals (character-ref +
KIE.ai image/video generation) are generated ONCE per job regardless of
language, then localization/narration audio (ElevenLabs)/caption timing
(AssemblyAI)/final render (upload-post.com FFmpeg) run once per requested
language — see `ARCHITECTURE.MD` §4.2/§6/§10.1 for why that split matters
(it's what stops EN/FR from ever getting different visuals). Social has no
per-post claim/CAS of its own (see `src/inngest/functions/social.ts`'s own
header) — a function-level concurrency limit of 1 preserves the same
single-process safety the old worker's tick loop relied on. See
`docs/IMPLEMENTATION_PLAN.md` and `ARCHITECTURE.MD` for the full design.

There is no standalone worker process anymore — `npm run dev` at the repo
root is the only thing to start.

---

## 📐 CODING STANDARDS

1. TypeScript strictly — `any` only for Supabase client generic (documented exception)
2. All DB calls inside `/src/services/contentService.ts` — never fetch in components
3. Every component must have: **loading skeleton**, **error state**, **empty state**
4. ShadCN components only — no new UI libraries without asking
5. Status colors must match the table above exactly
6. No `console.log` in production code

---

## ⚡ COMMANDS

```bash
npm run dev          # http://localhost:3000 → redirects to /dashboard
npm run build        # Production build
npx tsc --noEmit     # TypeScript check
```

---

## 🤖 CLAUDE SESSION RULES

1. Start every session: read `CLAUDE.md` + `PROGRESS.md` + `TASKS.md`
2. After every prompt: update `PROGRESS.md`
3. Task done: mark complete in `TASKS.md`
4. New endpoint: add to `API_DOCS.md`
5. Never change tech stack without asking
6. End of session: ✅ done · 🔄 in progress · ⭐ next steps
