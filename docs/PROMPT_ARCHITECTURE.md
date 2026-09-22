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

## Phase 3 — Planning contracts (Layer 2)

The `CreativeBrief` (Phase 2) now feeds real generation for the first time —
`composeVideoScriptSystemPrompt`, `composeOutlineSystemPrompt`, and the new
`composeImagePlanSystemPrompt` all take it as an optional parameter, folded
in via `creativeBriefContext()` (`composeText.ts`) as grounding ("treat as
your own prior thinking"), never a second, competing instruction. None of
this phase's richer plan output is read by `compose.ts`'s image/video prompt
builders yet — that's Phase 4.

### Video — extends the existing Layer 2 step, doesn't add a new one

`generateScript.ts` already plans the whole script+scene set in one call, so
Phase 3 extends its schema rather than adding a step: top-level `story`
(`hook`/`arc`/`resolution`/`cta`), `look` (AI-authored mood/lighting/
palette/style/camera-language — the eventual replacement for Phase 1's fixed
`NEUTRAL_MOOD_DEFAULT` fallback, once Phase 4 wires it in), `cast_bible[]`
(locked physical descriptions, reused verbatim — the continuity backbone
brief §9.2 calls for), `locations[]`; per-scene `beat`, `cast_present[]`,
`props_present[]`, `unit_presence`, `setting`, `contains_food`,
`is_final_scene`. All optional/lenient (`normalizeScriptOutput`'s existing
pattern, extended) — Phase 5 is where a strict contract with real validation
lands, not Phase 3. Storage: `story`/`look`/`cast_bible`/`locations` go in
`content_drafts.draft_data` (video's one shared, pipeline-level JSON blob);
the per-scene fields ride inside `video_scenes.narration_intent` alongside
`visual_state`. No migration either way.

**Deliberately conservative choice:** `STORY_PLANNING_CLAUSE`'s internal
"classify Fresh-CAN's role in this story" step (point 4) is the product of
several real, documented production incidents (Sessions 8–9) tuning exactly
how hard the brand gets pulled into a script. The brief's `unitRelevance`
now gives the model a pre-computed starting judgment for that same question.
Phase 3 passes it in as **grounding the model can confirm or refine with the
full scene context it's about to plan**, not a value that replaces the
model's own in-context classification — trusting a less-contextual upstream
judgment over a call already tuned against real failures was judged too
risky to do silently. Revisit if production data says otherwise.

### Image post — a genuinely new Layer 2 step

image_post had no planning step at all before Phase 3 (only `infographic`-
style jobs got any planning pass, via `generate_ad_copy`'s headline/
subtitle). New `steps/image/planImage.ts` runs for **both** `photo` and
`infographic` styles, producing `ImagePostPlan` (`designIntent`, `subject`,
`composition`, `unitPresence`, `setting`, `containsFood`, `castDescription?`,
`textPlan` — `null` for `photo`, required for `infographic`, enforced by the
system prompt itself — `safeZone: 'top-right'`). Grounded in Phase 1's
`businessModelNegatives`/`forbiddenInScene` arrays — their first real use in
any prompt — so the plan itself never proposes a composition Layer 3 would
have to reject. Same lightweight idempotency pattern as `interpretIntent`
(`hasSucceededStep`/`recordStepAttempt`, no claim/backoff loop), storage via
`pipeline_steps.output_snapshot` (image_post has no per-item plan table the
way video has `video_scenes`).

### Blog — outline generation is brief-grounded; image-brief ordering is still Phase 6

`composeOutlineSystemPrompt` takes the brief as a 4th optional parameter,
folded in alongside `sceneNotes`. Deliberately **not** touching image-brief
timing this phase — brief §4.3's "image briefs derived from the finished
copy" genuinely needs the ordering change already scoped as Phase 6; wiring
a "reference copy" pass in here would have been the kind of piecemeal,
partly-thrown-away work this refactor has been avoiding since Phase 1.

## Phase 4 — Render prompt composition (Layer 3)

The phase where Phase 3's plan data finally changes what gets rendered, and
where the keyword-regex unit gates are retired for good. `prompts/core/
scene.ts` (`isContainerRelevant`, `isVideoSceneAboutUnit`) is **deleted**.

### Unit presence is now LLM-authored everywhere

`UnitPresence` (`'none' | 'background' | 'featured'`, `compose.ts`) is the
single scale every composer branches on. Where each content type's value
comes from:

| Content type | Source |
|---|---|
| Video scene image | the scene's own `unit_presence` plan field, read back via `generateScript.ts`'s `extractSceneLayer2Fields` |
| Image post | `planImage.ts`'s `ImagePostPlan.unitPresence` |
| Blog hero/inline | the `CreativeBrief`'s brief-level `unitRelevance`, mapped `central→featured` / `incidental→background` / `none→none` by `blog.ts` |

Blog's mapping is a deliberate stopgap: it has no real per-image plan until
Phase 6 (image briefs from finished copy). It's still a strict improvement
over the deleted regex — that heuristic was *also* topic+category-level
rather than per-image, so this is like-for-like in granularity and
LLM-judged instead of keyword-matched.

**Undefined-field defaults differ on purpose.** `unitPresence` defaults to
`'none'` (never force the unit in without a positive signal — a wrong unit
is a hallucinated element), while `containsFood` defaults to `true`
(unknown → keep the harmless quality guard; omitting it when food *is* in
frame is a real regression). Both are documented on the job interfaces.

### `unitBrandingBlock` — the §6.5 consolidation

`BACKGROUND_TRUCK_CLAUSE`, `backgroundBrandingInstruction`,
`nonContainerSceneHint`'s branding tail and `NO_SUBJECT_IN_SCENE` collapse
into one presence-driven emitter: `featured` → `brand.unit.full`,
`background` → `brand.unit.identity` plus an explicit "never the
compositional focus", `none` → an explicit no-unit instruction. The
`noTextExceptUnitBranding` carve-out now applies to `featured` too (not
just `background`), since a blanket "no logos anywhere" contradicts
`unit.full`'s own structural claims exactly the same way — brief §12's
contradiction class, closed for both tiers instead of one.

**Interior framing is gated on `featured`.** A background/incidental
appearance is necessarily an exterior view (a unit parked on a street), so
`background` never selects the interior descriptor or reference pool.

### Watermark safe zone (§10)

`watermarkGeometry.ts` is the new single source of truth for the logo's
placement, imported by both `lib/watermark.ts` (the real `sharp`
compositing math) and `compose.ts`'s `watermarkSafeZoneBlock()`, so the
prompt's description of the reserved corner can't drift from where the logo
actually lands. The block describes the *vignette* radius
(`SAFE_ZONE_RADIUS_FRACTION`, 42% of width), not the narrower logo box,
since the vignette is what actually darkens/obscures content. Image
composers only — video has no watermark step.

### Two deliberate deviations from the phase plan

1. **No typed `PromptBlock` system.** The brief (§4.4) asks composers to
   return a block list alongside the string. I built it, found every
   composer still worked cleanly on plain arrays, and that threading it
   through `composeSceneImagePrompt` meant touching the hand-tuned
   truncation cascade that belongs to Phase 5 — so I removed it rather than
   ship unused scaffolding. It lands in Phase 5, where the guard layer
   (priority-based dropping, contradiction validation) is the real consumer.
2. **The budget cascade is untouched.** `SCENE_IMAGE_PROMPT_CHAR_LIMIT`'s
   drop order and arithmetic are exactly as before; only the *inputs* to its
   conditionals changed. Phase 4 decides WHAT goes in the prompt, Phase 5
   decides HOW MUCH fits.

**Known cost:** the consolidated branding block adds ~85 characters to the
featured scene-image path versus the bare descriptor the old code pushed
(the "never on any other vehicle" rule now ships there too). Measured
headroom for the realism guardrail on that path is ~150 characters of scene
content. Conditional inclusion buys far more back on `none` scenes (~900
characters saved), which is the payoff §4.4 predicted — but the featured
path is tighter than after Phase 1, and Phase 5's real per-endpoint limits
are what should resolve it properly.

## Phase 5 — Guard (Layer 4)

### Character limits, verified not guessed (§16.1, resolved)

The original brief flagged a conflict: the owner's stated 3,500-character
limit versus whatever the real provider caps turn out to be. Verification
(checking which adapter is actually wired in production today, not just
what's defined) found the conflict was real, but not ambiguous:

| Path | Adapter | Real limit | Source |
|---|---|---|---|
| Video scene images + character-ref | `KieImageGenerator` (Flux Kontext dedicated endpoint) | **3000 chars** | Confirmed live error text: "The prompt word cannot exceed 3000 characters." |
| Scene video clips | `KieVideoGenerator` (Seedance 1.5 Pro) | **2500 chars** | Documented at docs.kie.ai/market/bytedance/seedance-1-5-pro (`input.prompt: 3-2500`). |
| Blog hero/inline + image_post photo | `NanoBananaImageGenerator` (nano-banana-2) | unconfirmed | No documented limit found; currently unbounded, never failed in production. Owner-confirmed to leave unbounded rather than budget against a limit that may not apply to this model. |

Neither confirmed number is 3,500 — the owner confirmed the real numbers
(3000/2500) should be used instead. `prompts/core/limits.ts`'s
`PROMPT_LIMITS` is the single config both scene composers now read from
(`SCENE_IMAGE_PROMPT_CHAR_LIMIT`/`SCENE_VIDEO_PROMPT_CHAR_LIMIT` local
constants are gone). One more finding folded in: `KieSceneImageGenerator`
(the Market/jobs endpoint with the tighter, never-fully-confirmed
~1300-char-observed cap the original brief worried about) is **dead
code** — `video.ts`'s own comment confirms production moved off it on
2026-09-19 because that cap kept failing ordinary scenes. It has no entry
in `PROMPT_LIMITS`.

### `composeCharacterRefPrompt` — a real bug the validator work surfaced

This composer had **no budget enforcement at all** before Phase 5, despite
sharing `KieImageGenerator`'s 3000-char cap with scene images. Fixed with a
single-field truncation (`regenInstructions` is its only variable-length
input — no multi-clause cascade needed).

While wiring it up, a second, independent bug surfaced: its empty-reference-
pool branch fell straight to the blanket `brand.noTextInstruction` ("no
logos anywhere") instead of Phase 4's `noTextVariantFor` carve-out — a real
instance of brief §12's contradiction class (this text sits right next to
`unitBrandingBlock('featured')`'s "must be built to this structure" text).
Every other composer already routed through `noTextVariantFor`; this one
hadn't. Fixed as part of this phase, not left for the validator to merely
detect.

### Contradiction validator (§12)

`prompts/core/contradictions.ts`'s `assertNoContradiction(prompt, brand)`
throws `PromptContradictionError` if a prompt contains both
`brand.noTextInstruction` (the blanket "no text/logos at all") and either
`brand.unit.full` or `brand.unit.identity` (a "must be built to this
structure" claim) — brief §12's own named bug class. Called by every image
composer right before it returns (not `composeSceneVideoPrompt`, which is
motion-only and never references the brand's unit descriptors at all).

**This is defense-in-depth, not a fix for a live bug** — Phase 4's
`unitBrandingBlock`/`noTextVariantFor` already made the contradiction
structurally hard to construct in a *correctly-wired* composer. The value
is catching a *regression*: exactly the class of bug the character-ref fix
above turned out to be, if a future edit reintroduces it. It found a real
bug once already, in this same phase.

### Deliberate deviation: no generic `PromptBlock`-with-template-reassembly engine

The Phase 4 brief (and the original phase plan) called for a typed
`PromptBlock` system that composers reorganize around. Built, then set
aside for the same reason Phase 4 set it aside: the free-text fields in
`composeSceneImagePrompt`/`composeSceneVideoPrompt` are interpolated into
larger label+value template strings ("Shot notes: X.", not just "X") —
a generic block-truncation engine would either need to break that
templating or add real complexity (partial-block truncation with prefix/
suffix preservation) for uncertain benefit over the existing, working,
hand-tuned cascade. Phase 5 re-parameters that cascade from the shared
`PROMPT_LIMITS` config instead of rebuilding its mechanics — the actual
brief asks (§7's "one config", §12's contradiction prevention) are met
without it.

## Not yet done (later phases)

- Blog's image-brief-from-finished-copy ordering change — Phase 6.
- `cast_bible` verbatim injection into per-scene image prompts (brief §9.2)
  — the plan data exists (Phase 3) but nothing reads it yet; deferred as
  its own piece of work rather than squeezed into Phase 4.
- Structural test rewrite for `compose.test.ts`/`composeText.test.ts`'s
  remaining phrase-pinning assertions, and the e2e substring-dispatch
  coupling in the three `*Pipeline.e2e.test.ts` files — Phase 8 (§13).
