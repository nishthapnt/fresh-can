# Prompt Architecture

Living doc for the prompt layer's design — see `PROMPT_REFACTOR_BRIEF.md` for
the full refactor brief this implements, in phases. This doc is the home for
the *reasoning* behind current rules; the code carries only short, current
comments (brief §6.6). Extended as each phase lands.

## Layer model (target)

```
Layer 0  BRAND TRUTH        prompts/brand/<brand>.ts — structured data only
Layer 1  INTENT             admin idea → structured creative brief (LLM)
Layer 2  PLAN               brief → script/scene plan / image plan / blog outline (LLM, strict JSON)
Layer 3  RENDER PROMPTS     plan + brand truth → model-specific prompt, typed blocks
Layer 4  GUARD              budget enforcement, validation, QA checks
```

Phase 1 (this doc's current content) implements Layer 0 only. Layers 1-4 land
in later phases — see `PROMPT_REFACTOR_BRIEF.md` §4 for the full target shape
of each.

## Phase 1 — Brand truth as data

`prompts/brand/fresh-can.ts` was previously long, hand-tuned prose
paragraphs assembled from module-private constants (`CONTAINER_DESCRIPTOR`,
`BACKGROUND_TRUCK_CLAUSE`), each carrying 20-90 lines of inline incident
history. Rewritten to structured, tiered data (`unit.{identity,full,interior}`,
atomic `forbiddenOnUnit`/`forbiddenInScene`/`businessModelNegatives` arrays,
structured `referenceImages` with `whatItShows`/`disregard`). The rules
themselves are unchanged in substance — only their shape and the corrected
business-model facts (see below) changed.

### Why the unit descriptor is tiered

A composer spends characters only where the unit's presence actually
warrants it: `identity` for background/incidental appearances, `full` when
the unit is a featured subject, `interior` for interior scenes only. Before
this, the full ~1180-character structural description shipped on every
prompt that mentioned the unit at all, regardless of relevance — a real
contributor to composeSceneImagePrompt repeatedly hitting KIE's ~3000-char
cap (see the "Character budgets" section below).

### Corrected business-model facts (PROMPT_REFACTOR_BRIEF.md §2)

The old brand profile described the business vaguely enough that models
invented wrong scenes: service windows, market stalls, cashiers, checkout
counters. The rewritten `missionStatement`/`neutralIdentityLine`/`journey`
now spell out the real mechanism unambiguously: Fresh-CAN is a mobile
grocery store, cashierless and autonomous ("pick and go"); the app QR code
identifies *who is entering*, it is never a payment QR and never a per-item
scan; payment is linked once, in advance, and charged automatically on exit.
`businessModelNegatives`/`forbiddenInScene` encode what it is explicitly
NOT — a market stall, food truck, freight operation, or charity handout
line — as atomic, visual rules rather than a single dense paragraph.

### Unit rule history (why each `forbiddenOnUnit` rule exists)

These rules were each added after a specific, observed bad generation —
kept here as institutional memory, condensed from the original inline
comments:

- **Side-panel-only wordmark, front/rear plain**: an early generation
  invented a side door because nothing told the model what the side
  actually looked like; a later one hallucinated a door on the front face
  for the same reason (an implied "nowhere else" wasn't reliable — every
  face needed to be named explicitly).
- **"No service window/hatch" stated explicitly**: a generation rendered an
  open service hatch on the side in a scene where a family approaches to
  shop — the earlier generic "no door/hatch/window/vent" wording apparently
  read as ruling out a delivery-style door, not a customer-service framing.
- **Exactly one wordmark, side panels only**: real reference photos show the
  physical truck's actual wrap carrying the wordmark in 2-3 places (a rear
  header-bar wordmark, a front-face wordmark, plus decorative URL text and a
  QR panel) — none of that was ever described to the model, so it had
  nothing telling it to disregard those real-but-non-canonical elements when
  editing from a reference photo. Simplified to one rule (side panels only)
  precisely because a single, simple, consistently-enforceable rule stops
  drift better than chasing each real element individually — paired with the
  `disregard` field on each reference image (below) for the same reason.
- **Plain unbranded cab**: a generation invented a garbled illegible decal
  on the cab door — the model filling an unbranded area with
  plausible-looking invented signage. All reference photos show a
  completely unbranded cab; this rule makes that explicit rather than
  implied.

### Reference photos — `whatItShows` / `disregard`

Each real reference photo shows genuine elements beyond the brand's
canonical design (a decorative graphic wave, URL text, a second wordmark, a
QR panel). Previously this correction ("this photo also shows X, disregard
it") was baked into the same prose string as the factual camera-angle
description, making the two hard to tell apart. Now split: `whatItShows` is
purely factual (what the camera captured), `disregard` is an explicit array
of real-but-non-canonical elements to ignore. `standing` is ordered first in
`referenceImages.exterior` because `composeCharacterRefPrompt` always uses
index 0 — it's the photo with the least competing real content in frame.

**Recommendation (not yet actioned — brief §16.3):** pre-correcting the
reference asset files themselves (cropping/retouching out the extra
wordmarks, URL text, QR panel, graphic wave) would remove this whole class
of problem permanently, rather than instructing around it on every prompt.
Flagged to the owner; not done unilaterally per the brief.

### Interior counter/sink (brief §16.6)

The interior descriptor's "stainless steel prep counter and sink" is kept
per the brief's stated default, with an explicit "never a checkout or
point-of-sale" clarification added directly in the descriptor text, since a
counter/sink near the exit could otherwise read as a checkout fixture.

### Character budgets (context for Layer 4, not yet built)

KIE's Flux Kontext endpoint has a real, confirmed ~3000-character prompt
cap ("The prompt word cannot exceed 3000 characters", live error text). The
Market/jobs endpoint (`KieSceneImageGenerator`) fails at a much lower,
never-precisely-confirmed threshold (observed failures around ~1300 chars).
Seedance's video endpoint has its own separate, tighter, documented cap.
Current code (`SCENE_IMAGE_PROMPT_CHAR_LIMIT = 2995`,
`SCENE_VIDEO_PROMPT_CHAR_LIMIT = 2450`) hand-derives headroom under these
per composer, independently — Layer 4 (Phase 5) consolidates this into one
`PROMPT_LIMITS` config once the owner confirms real per-endpoint numbers
against their stated 3500 limit (brief §16.1 — unresolved, do not guess).

## Removed in Phase 1

- `categoryVisualHints`, `categoryBriefs`, `adAngleBriefs` — per-category/
  per-angle canned creative direction (brief §6.2). Category/angle may
  remain as light metadata on the job but must not dictate subject, setting,
  composition, or style going forward.
- `moods` (hardcoded 3-entry rotation) — brief §6.3. Until Layer 2's `look`
  object exists (Phase 3), composers fall back to a single neutral default,
  not a rotating list.
- `content_jobs.keywords` — removed from the dashboard form, the required
  validation, and every prompt read (blog outline, video script, image
  prompts, image clarifying-questions). The DB column is left in place,
  unread — dropping it is a schema migration, out of scope without separate
  sign-off. Confirmed via `git log -S"keywords"`: this field was never used
  for anything beyond being piped into a prompt/webhook payload, even in the
  original pre-Inngest n8n version of the app — no hidden dependency
  elsewhere.
- A stale, hand-duplicated brand blurb in
  `api/jobs/[jobId]/image/questions/route.ts` (a second, independent copy of
  the mission statement, never imported from the brand file) — replaced
  with `BRAND_PROFILE.missionStatement`, per brief G4 (no brand-specific
  strings outside the brand profile file).

## Phase 2 — Intent interpretation (Layer 1)

`steps/shared/interpretIntent.ts` (new — the first step shared identically
across blog/image/video, rather than living under one content type's
folder) turns the admin's raw idea into a structured `CreativeBrief`
(`prompts/types.ts`) before any script/outline/photo prompt gets written:
`intent`, `coreMessage`, `audience`, `emotionalTone`, `desiredResponse`, a
brief-level `unitRelevance` (`central`/`incidental`/`none` + a one-sentence
rationale), `improvements` (must elevate the admin's idea, never override an
explicit one), and `constraintsFromAdmin`.

### `unitRelevance` is brief-level, not scene-level

Don't confuse `CreativeBrief.unitRelevance` with the per-scene/per-image
`unitPresence` rubric a Layer 2 plan will carry later (brief §8's
`featured`/`background`/`none` naming). A `central` brief can still have
individual scenes where the unit doesn't belong (a close-up on produce,
say), and an `incidental`/`none` brief could still have one scene that
genuinely calls for it. The brief-level judgment grounds the *overall*
creative direction; the scene-level one (Phase 3/4) decides frame by frame.

### Not yet consumed by generation

This phase generates and logs the brief (`pipeline_steps.output_snapshot`,
step name `interpret_intent`) but deliberately does **not** wire it into
`composeOutlineSystemPrompt`/`composeVideoScriptSystemPrompt`/
`composePhotoPrompt` yet — the brief is Layer 2's *input*, and Layer 2
(`story`/`look`/`castBible`/scene plan for video; an image-post plan; a blog
plan) doesn't exist yet. Wiring it in is Phase 3's job. Current generation
output is unaffected by Phase 2.

### Idempotency: lighter than `generate_outline`/`generate_script`

`interpretIntent` uses the same `hasSucceededStep`/`recordStepAttempt`
ledger every step writes to, but skips `claimPipeline`'s CAS-claim and
backoff-sleep retry loop — that machinery exists specifically to gate
`content_pipelines.status` across multiple retry attempts (image/video
generation polls an external provider and can legitimately need several
passes). Intent interpretation is a single, non-polling OpenAI call already
wrapped in Inngest's own `step.run()` durability, so the heavier pattern
would be unused ceremony. A malformed/failed response falls back to a
neutral `CreativeBrief` (`unitRelevance: 'none'`) rather than failing the
pipeline — this step exists to *improve* generation, not become a new
single point of failure for one that worked without it before.

## Not yet done (later phases)

- `isContainerRelevant`/`isVideoSceneAboutUnit` keyword-regex unit gating
  (`prompts/core/scene.ts`) — still in use; replaced by an LLM-authored
  `unitPresence` field once Layer 2 plans exist (Phase 3/4, brief §6.4/§8).
- The `CreativeBrief` from Phase 2 is not yet read by any composer — Phase 3
  wires it into the planning steps.
- The full `PromptBlock` conditional-inclusion composer rewrite (Phase 4).
- Per-endpoint budget config and contradiction validation (Phase 5).
