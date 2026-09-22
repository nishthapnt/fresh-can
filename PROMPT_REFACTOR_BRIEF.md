# Fresh-CAN — Prompt Layer Refactor Brief

**Audience:** Claude Code, working in the Fresh-CAN Content Automation Dashboard repo.
**Author:** Pri (owner).
**Status:** Authoritative. Where this document and existing code comments disagree, **this document wins** — existing comments describe bugs that were patched one at a time, not the intended design.

---

## 0. How to use this brief

1. **Read first, write second.** Locate every file that builds a prompt string (brand profile, prompt composers, script/scene-plan generators, caption/copy generators, adapters that pass prompts to KIE / OpenAI / Seedance). Produce a file map and a short plan **before** editing.
2. **Do not do a blind rewrite.** Propose the plan, list the files you'll change, list what you'll delete, and flag anything in this brief that conflicts with what you actually find in the code. Ask before doing anything that needs a **DB schema migration** — the owner does not want new columns unless there is no alternative (see §6.4).
3. This brief tells you **what each prompt must achieve and how the system must be structured**. It deliberately does **not** contain the prompt text. You write the prompt text.
4. Note: there appear to be **two copies** of the image-prompt composer (a stale one under `worker/` and the live one under `src/server/pipeline/`). `CLAUDE.md` says `worker/` is retired. Verify, work on the live copy, and delete the dead one (or confirm with the owner if it is still referenced).

---

## 1. Non-negotiable ground rules

| # | Rule |
|---|---|
| G1 | **Nothing creative is hardcoded.** No fixed mood lists, no per-category scene templates, no "always show the truck," no canned story structures. The AI decides the story, scenes, mood, composition and pacing **from the admin's input**. |
| G2 | **The admin's idea/description is the brief.** Everything else (brand facts, unit branding rules, physics, safety) is a *constraint on correctness*, never a competing creative direction. |
| G3 | **Remove the keywords concept entirely.** (See §6.1.) |
| G4 | **No brand-specific literal strings outside the brand profile file.** Composer/step files must be brand-agnostic and work for the next client by swapping one brand file. Today brand text is leaking into generic fallbacks — fix it. |
| G5 | **The unit (truck) appears only when the content genuinely calls for it** — decided per scene / per image by the AI, not by keyword regex and not by a default-on flag. |
| G6 | **Prompts must fit their model's limit by construction**, not by emergency truncation of the creative brief. Truncation stays as a last-resort safety net only. |
| G7 | Existing coding standards still apply: TypeScript strict, no `console.log`, all Supabase access through the service layer, ShadCN only. |
| G8 | Update the tests. Several tests assert on exact prompt phrases; those assertions are now stale. Replace phrase-matching tests with **structural/behavioural** tests (see §13). |

---

## 2. Corrected brand truth — this is the single biggest source of current errors

The brand profile currently describes Fresh-CAN vaguely enough that the models invent wrong scenes (service windows, market stalls, cashiers, checkout counters). Rewrite the brand facts so the *business model* is unambiguous.

### 2.1 What Fresh-CAN is

- A Canadian **mobile grocery store**: fresh fruit, vegetables and everyday food staples brought directly to streets and communities across Canada.
- Each truck is **a unit** — a self-contained, walk-in grocery store built inside a converted shipping container mounted on a box truck.
- Customers find the **nearest unit** through the free Fresh-CAN mobile app.
- The store is **fully autonomous — pick and go**. There is no cashier, no checkout counter, no till, no queue.

### 2.2 The actual customer journey (get this exactly right in the prompts)

1. **First visit only:** the customer registers in the Fresh-CAN app and links their payment card. Payment is set up once, in the app, in advance.
2. **Every visit:** the customer arrives at the unit and **scans their app QR code at the door reader to enter**. The QR identifies *who* is entering — it is **not** a payment QR and **not** a per-item scan.
3. Inside, they simply **take items off the shelves** into a basket or their own bag. In-store AI, cameras and shelf/weight sensors register what was taken.
4. They **walk out**. The linked card is charged automatically. No billing, no line, no scanning at exit.

> Internal note for your understanding only: the mechanism is a cashierless "just walk out" store on wheels. **Never name, reference, hint at or compare to any other retailer or product in any generated content, prompt, or comment.** No competitor names, ever.

### 2.3 What Fresh-CAN is **NOT** — these must be explicit negative constraints

- ❌ Not an open-air market, farmers' market stall, produce stand, or pop-up tent.
- ❌ Not a food truck, canteen, or service-window vendor. **Customers are never served through a window or hatch.**
- ❌ Not a freight/transport/logistics company. The unit is never shown as cargo being hauled, loaded onto another vehicle, or in a depot/warehouse yard as freight.
- ❌ Not a food bank or charity handout line.
- ❌ No cashier, staff member serving customers, checkout counter, cash register, POS terminal, card machine, receipt printer, barcode scanner, price gun, or cash/coins on screen.
- ❌ No queue or line of people waiting to pay.
- ❌ No shopping trolleys/carts (the interior aisle is narrow — baskets or reusable bags only).
- ❌ Never a specific Canadian city, town, neighbourhood or province named or visually identified (no landmarks, no provincial flags, no recognisable skylines). "Canada" is the only place name.

### 2.4 Positive visual truths to encode

- Entry: a discreet QR/scan reader at the rear entrance; the customer holds up a phone.
- Inside: narrow single aisle, realistic occupancy (typically 1–3 people), shelves and glass-door fridges, unobtrusive ceiling cameras/sensors.
- Exit: the customer simply walks out carrying their items.
- Produce and packaged goods always look clean, fresh, tidy, appetising.

### 2.5 Voice rules (keep and extend)

Keep: warm, hopeful, community-driven, never corporate; third person only (never "we/our/us"); Canadian spellings; no negative competitor mentions; no place names beyond "Canada"; banned-word list.
Add: never claim a specific store count, city, launch date, price, or statistic that is not in the brand facts; never imply charity/handout framing; never mention or imply any comparable retailer.

---

## 3. Channel specifications

| Channel | Format | Model | Hard requirements |
|---|---|---|---|
| **Video** | Instagram Reel, **vertical 9:16** | Script + scene prompts: GPT-4o · Image frames: KIE image model · Video: **Seedance 1.5 Pro** (image-to-video) | Photoreal, natural, physically plausible. Strong continuity across every scene. Scene-prompt budget: **3,500 characters** (see §7 — confirm per-endpoint). |
| **Image post** | Instagram, **4:5 vertical** (confirm with owner if 1:1 is also wanted) | Text-capable image model for designed posts; edit-model for photo posts | Must look like **professionally designed brand content**, not a random snapshot. **Top-right corner must stay clear** — the Fresh-CAN logo watermark is composited there after generation (see §10). |
| **Blog** | Website article + hero/inline images | GPT-4o for copy; image model for visuals | **Copy is generated first; the generated copy is the context for the images** (see §9.3). |
| **Social caption** | Instagram | GPT-4o | Derived from the same brief that produced the asset — one brief, not a second independent guess. |

---

## 4. Target architecture

Replace the current "one giant string of stacked guardrail sentences" with a layered pipeline. Each layer has one job.

```
Layer 0  BRAND TRUTH        brand/<brand>.ts — structured data only, no assembled prose
Layer 1  INTENT             admin idea → structured creative brief (LLM, GPT-4o)
Layer 2  PLAN               brief → script + scene plan / image plan / blog outline (LLM, strict JSON)
Layer 3  RENDER PROMPTS     plan + brand truth → model-specific prompt, composed from typed blocks
Layer 4  GUARD              budget enforcement, validation, and QA checks
```

### 4.1 Layer 0 — Brand truth as data

Refactor the brand profile from "paragraphs of prose that get concatenated" into **structured, granular fields** the composer selects from. Requirements:

- Split the unit description into **tiers**, so the composer spends characters only where needed:
  - `identity` — the minimum that makes the vehicle recognisably Fresh-CAN (form factor, colour, wordmark placement). Used for background/incidental appearances.
  - `full` — the complete structural rule set (faces, openings, what must never appear). Used when the unit is a featured subject.
  - `interior` — interior layout rules, used only for interior scenes.
- Express prohibitions as **arrays of short, atomic rules** (`forbiddenOnUnit`, `forbiddenInScene`, `businessModelNegatives`) rather than long sentences, so the composer can join only what's relevant and so the same rule is never duplicated across three constants.
- Reference photos become structured: `{ url, whatItShows, disregard: string[] }`. The "this photo also shows X, ignore it" corrections currently baked into prose belong in `disregard`.
  - **Better still:** flag to the owner that pre-correcting the reference assets (crop/retouch out the extra wordmarks, URL text, QR panel, graphic wave) removes this whole class of problem permanently. Recommend it; don't do it unilaterally.
- Keep: mission, neutral identity line, voice guidelines, banned words, statistics, typography, CTA bar colour, watermark spec, voice IDs.
- **Delete from the brand profile:** `categoryVisualHints`, `categoryBriefs`, `adAngleBriefs`, `moods`, and any other per-category or per-angle canned creative direction (see §6.2/§6.3).

### 4.2 Layer 1 — Intent interpretation (new step)

Today the admin's free text is dropped raw into the render prompt. Add an explicit interpretation step (GPT-4o, strict JSON out) that reads the admin's idea/description plus the content type and produces a **creative brief**:

- `intent`: what the admin is actually trying to do — e.g. marketing, promotion, awareness, food/nutrition education, community story, product/how-it-works explainer. **Inferred, not picked from a dropdown.**
- `coreMessage`: the single idea the viewer must leave with.
- `audience`, `emotionalTone`, `desiredResponse`.
- `unitRelevance`: `none` | `incidental` | `central`, with a one-line rationale (see §8).
- `improvements`: where the admin's idea was thin, what the AI is adding to make it stronger — this is the "understand the intent and improve it" requirement. It must **elevate, never override**: if the admin specified something explicitly, it is binding.
- `constraintsFromAdmin`: anything the admin stated that is non-negotiable.

This brief is then the single input to Layer 2 for every content type. One brief → script, visuals, captions, blog images all stay aligned.

### 4.3 Layer 2 — Planning (strict JSON contracts)

All planning LLM calls must use **structured output / JSON schema mode**, validated on receipt, with a typed fallback path. No free-form prose parsing.

**Video plan** (one per job, shared by EN/FR — do not regenerate per language):

- `story`: `{ intent, coreMessage, hook, arc, resolution, cta | null, totalDurationSec }`
- `look`: `{ timeOfDay, lighting, palette, styleDirection, cameraLanguage }` — **AI-authored**, this replaces the hardcoded mood list.
- `castBible[]`: `{ id, role, ageRange, appearance, wardrobe, distinguishingDetails }` — locked physical descriptions reused verbatim in every scene that contains that person. This is the backbone of continuity.
- `locations[]`: `{ id, description, continuityDetails }`
- `scenes[]`, each with:
  - `sceneNumber`, `beat` (its narrative job: hook / build / turn / payoff / close)
  - `narration` per language, `durationTargetSec`
  - `visualDescription` — the creative brief for the frame
  - `shotNotes` — camera/lens/framing
  - `motionNotes` — what moves, and why (feeds the video prompt)
  - `castPresent: string[]` (ids from `castBible`), `propsPresent: string[]`
  - `unitPresence`: `none` | `background` | `featured`
  - `setting`: `exterior` | `interior` | `unrelated`
  - `containsFood`: boolean
  - `continuityFromPrevious`: what carries over (people, objects, position, light)
  - `endState` / `visualState`: what the next scene inherits
  - `isFinalScene`

**Image-post plan:** `{ designIntent, subject, composition, unitPresence, setting, containsFood, castDescription?, textPlan: { headline, subtitle } | null, safeZone: 'top-right' }`.

**Blog plan:** outline → copy → **image briefs derived from the finished copy** (see §9.3).

### 4.4 Layer 3 — Render prompt composition

Replace string concatenation of always-on constants with a **typed prompt-block system**:

```ts
type PromptBlock = {
  id: string
  priority: 'required' | 'high' | 'medium' | 'optional'
  text: string
}
```

Rules:
- Blocks are **conditionally included** based on the plan's structured flags. If `unitPresence === 'none'`, the unit descriptor and reference image are not included at all — and an explicit "no unit / no branding in this frame" block is. If `containsFood === false`, the food-quality block is omitted. If `castPresent` is empty, the human-realism block is omitted. If `setting !== 'interior'`, the interior descriptor is omitted.
- Ordering is deterministic and documented: **scene content first, constraints after**, with the text/no-text instruction last.
- The composer returns both the final string **and** the block list, so tests and debugging can inspect what was included and why.
- **This conditional inclusion is what solves the character-budget crisis.** Today ~2,800 characters of fixed overhead ships on every single scene regardless of relevance. Most of it is irrelevant to most scenes.

### 4.5 Layer 4 — Guard

- Per-model character budgets from a single config (§7).
- Validation before send: required blocks present; no contradictory pairs (e.g. "no logos anywhere" alongside "show the wordmark") — the current code has exactly this bug class; make it structurally impossible rather than patched case by case.
- If a prompt still exceeds budget after conditional inclusion, drop `optional`, then `medium`, then truncate free-text fields at word boundaries — creative brief (`visualDescription`) truncated **last**, and log a warning when it happens.

---

## 5. Prompt-by-prompt requirements

For each prompt below, the brief states **what it must accomplish**. You write the wording.

### 5.1 Intent/brief system prompt (new)
Must: interpret the admin's input charitably and specifically; identify the real goal; strengthen a thin idea without replacing a specific one; decide unit relevance using §8's rubric; refuse to invent facts, statistics, prices, locations or claims not present in brand truth or admin input; output valid JSON only.

### 5.2 Video script + scene-plan system prompt (GPT-4o)
Must:
- Build the story **from the brief**, not from a template. Scene count, pacing and structure follow the content's needs.
- Apply **attention/retention craft** (this is the "psychology of attraction" requirement) as principles, not as a fixed formula:
  - the opening frame and first ~1.5 seconds must earn the scroll-stop on their own — visual interest before any explanation;
  - every scene must give the viewer a reason to watch the next one;
  - one clear emotional throughline; escalation, then payoff;
  - the ending resolves rather than stops; CTA only when the intent warrants it;
  - vertical 9:16 framing discipline — subject weight in the centre-safe area, nothing important near top/bottom UI overlays.
- Enforce **physical and narrative plausibility**: real-world physics, gravity, scale, lighting direction, weather/time consistency, and settings where the depicted action actually makes sense. Actions must have visible causes.
- Enforce **continuity by construction**: every scene lists which cast members and objects it inherits; appearance descriptions come verbatim from `castBible`; lighting/time-of-day may only change if the story explicitly moves.
- Decide `unitPresence` per scene using §8.
- Keep narration natural, spoken, third-person, within the duration target; no banned words; no place names.
- Output strict JSON matching the schema.

### 5.3 Scene image prompt composer (KIE image model)
Must: render the plan's `visualDescription` faithfully as the subject of the frame; include only the relevant constraint blocks (§4.4); pass cast/continuity descriptions so faces, clothing and objects hold across scenes; require photorealism and correct anatomy; forbid invented text/signage; include unit rules only when the unit appears; state vertical 9:16 framing.

### 5.4 Scene video prompt composer (Seedance 1.5 Pro, image-to-video)
Must: describe **motion only** — the frame's appearance is already locked by the input image; layer subject motion, justified ambient motion, and camera motion; forbid motion without a physical cause (static produce must not drift); forbid jump cuts, morphing, and staged product-reveal orbits/push-ins; require the approved input frame to be treated as the source of truth for every person, limb and object; settle motion into a held beat on the final scene. Keep the existing per-scene duration/trim coordination.

### 5.5 Image-post composer
Must produce **a designed Instagram asset**, not a snapshot: deliberate composition, clear focal hierarchy, intentional negative space, balanced colour, editorial-grade lighting, 4:5 vertical. For text-bearing designs, headline/subtitle placement and typography come from brand truth; spelling must be exact; **nothing may occupy the top-right logo safe zone** (§10). For photo-style posts, the same compositional discipline applies with no on-image text at all.

### 5.6 Blog prompts
- **Outline/copy:** driven by the admin's idea and the interpreted intent; brand voice; third person; Canadian spelling; no city names; statistics only from brand truth and only where they genuinely support the point; never forced.
- **Image briefs:** generated **after** the copy, taking the finished copy (and, for inline images, the specific section) as context. Each brief then goes through the same Layer 3 composer with the same unit-presence decision.

### 5.7 Caption / ad copy
Must derive from the same interpreted brief as the asset it accompanies. Instagram-native, brand voice, no banned words, no place names, no competitor references, CTA appropriate to the intent.

---

## 6. Explicit removals and replacements

### 6.1 Keywords — remove entirely
Delete `keywordsClause` and every read of a keywords field from **all** prompt paths (image, blog outline/copy, video script, captions). Remove the dashboard input if it exists. Leave the DB column in place unless the owner approves a migration; just stop reading it. Generation is driven by the idea/description only.

### 6.2 Category-driven creative direction — remove
Delete `categoryVisualHints`, `categoryBriefs`, `adAngleBriefs` and the generic non-container hint fallback. These hardcode what a scene should look like before anyone has read the admin's idea. Category may remain as **light metadata** on the job, but it must not dictate subject, setting, composition or style.

### 6.3 Hardcoded mood rotation — remove
Delete the fixed `moods` array and the deterministic per-pipeline mood pick. Mood, lighting and palette come from the plan's `look` object. If (and only if) a legacy job has no plan, fall back to a neutral, minimal default — not a rotating list of three canned moods.

### 6.4 Keyword-heuristic truck gating — replace
Delete `isContainerRelevant` and `isVideoSceneAboutUnit`. Unit presence becomes an **LLM-authored field on the plan** (§8).

> Code comments say a previous attempt at this was reverted because it needed a schema migration the owner didn't want. **Avoid the migration:** the plan is already produced and consumed within the pipeline, and scene plans are stored as JSON. Carry `unitPresence` (and the rest of §4.3's fields) inside that existing JSON payload. If you find that genuinely impossible, stop and ask before proposing a migration.

### 6.5 Duplicated/drifting constants — consolidate
`BACKGROUND_TRUCK_CLAUSE`, the default non-container hint, `backgroundBrandingInstruction` and `ONE_WORDMARK_ONLY` are three or four paraphrases of the same rules, plus brand-specific text sitting in supposedly brand-agnostic files. Collapse them into brand-profile data + one composer that emits the right tier (§4.1).

### 6.6 Stale comments
The composer files carry a long archaeology of dated incident notes. Keep the *rules* they encode; move the reasoning into `docs/PROMPT_ARCHITECTURE.md` (§14) and leave short, current comments in the code. Remove references to the retired `worker/` process.

---

## 7. Character budgets

- Move every limit into **one config**, keyed by model/endpoint (e.g. `PROMPT_LIMITS = { sceneImage: …, sceneVideo: …, designImage: … }`), with a short comment stating the source of each number.
- Owner's stated limit for the scene-generation prompt: **3,500 characters**. Current code uses 2,995 (image) and 2,450 (video) based on earlier API errors and Seedance docs.
  **Action:** verify each endpoint's real limit against the current provider docs and the adapter's error text. If they disagree with 3,500, **report the conflict to the owner rather than silently choosing**. Apply a small safety margin (tens of characters, not hundreds).
- Budget enforcement lives in one shared helper used by every composer. No per-file ad-hoc truncation.
- Add a test that composes a realistic worst-case prompt for each endpoint and asserts it lands under budget **without** truncating the creative brief.

---

## 8. Unit-presence decision rubric

The admin will **not** say whether to include the truck. The AI decides, per scene and per image, and records `unitPresence` + a one-line rationale.

Guidance to encode in the planning prompt:

- `featured` — the content is about visiting, entering, shopping in, finding, or the existence/arrival of a unit; the "how it works" journey; a promotion tied to a location or opening.
- `background` — the unit plausibly belongs in the setting and reinforces context without being the subject (e.g. a community moment on a street where a unit is parked). Never forced in; never the compositional focus.
- `none` — pure food/nutrition education, recipes, produce close-ups, farm/supplier stories, awareness and emotional/community pieces where the unit has no natural place, and **any interior domestic setting** (kitchens, dining rooms, living rooms).

Hard rules:
- Never place the Fresh-CAN wordmark or logo on any other vehicle, sign, storefront, building or object.
- A scene marked `none` gets **no reference image attached at all** and an explicit no-branding instruction — edit-mode bias must never be able to pull the unit into a frame that was never about it.
- Brand connection in unit-free content comes from voice, subject matter and the closing beat/CTA — not from forcing the vehicle into frame.
- When the unit does appear, **all branding rules apply in full** (§9.1).

---

## 9. Per-pipeline notes

### 9.1 Unit branding rules (keep, restructure)
Preserve the substance of the existing rules — they were learned from real defects:
- Plain unbranded white cab; all branding on the container.
- One wordmark instance, on the side panels, correctly rendered, never distorted.
- Front and rear faces plain; the rear glass double door is the **only** entrance and the **only** opening on any face.
- Never a door, hatch, service window, vent or fixture on the front face or either side. Customers are served only through the rear entrance.
- Colour and structure identical in every appearance.
- No other text, graphics, decals, stripes, URLs or QR panels on the unit.

Restructure these as atomic data rules (§4.1) emitted at the right tier, not as one 1,200-character paragraph glued to every prompt.

### 9.2 Continuity system (video)
- `castBible` descriptions are injected **verbatim** into every scene that includes that person. Consistency is achieved by repeating a locked description, not by hoping.
- Carry-forward continuity (people count, key objects, position, light) becomes a **first-class block**, not the first thing dropped when space runs short. Conditional inclusion (§4.4) frees the characters needed for this.
- Keep the single shared character-reference image for the unit. Evaluate whether an equivalent locked reference frame for recurring people is feasible with the current image model; if the adapter supports chaining a previous scene's output/last frame as the next scene's reference, evaluate it and report back — **investigate and recommend, don't implement unilaterally.**
- Scene images and narration are generated **once per job** and shared across languages. Do not break that.

### 9.3 Blog ordering change
Current order composes blog images from topic/category/scene notes. New order:
1. Interpret intent → brief.
2. Generate outline → copy.
3. Generate **image briefs from the finished copy** (hero from the whole article's core message; each inline image from its own section).
4. Compose image prompts through the shared Layer 3 composer.

Check the Inngest blog function's step ordering and adjust so image generation depends on copy completion. Preserve step idempotency/retry semantics.

---

## 10. Logo watermark safe zone (images)

The Fresh-CAN logo is composited onto the **top-right corner** after generation.

- Every image prompt must reserve that corner: no text, no headline, no subject's face, no high-detail or high-contrast clutter there — clean, low-detail area suitable for an overlaid logo.
- Designed/text-bearing layouts must position headline/subtitle to respect it.
- Confirm the watermark's real pixel box in the compositing code and derive the safe-zone description from it rather than guessing.
- The model must never attempt to draw the logo itself.

---

## 11. Physical realism (images and video)

Encode as a constraint block, applied whenever people/objects/motion are present:
- Correct anatomy; hands with correct finger counts; every visible hand or limb belongs to an established person.
- No duplicate people, no floating or unexplained objects, no impossible scale or perspective.
- Realistic skin, fabric, food texture; natural light with consistent direction and colour temperature.
- Gravity, weight, contact and support must read correctly; objects move only with a visible cause.
- Only the people and props the scene establishes — no extra staff, workers or bystanders.
- Settings must be physically plausible and safe.

---

## 12. Contradiction prevention

Several current defects came from sending contradictory instructions in one prompt ("no logos anywhere" + "the branded truck may appear"). Make this structurally impossible:
- The text/no-text instruction is **derived from** the composition decision, never chosen independently.
- Add a validation step that fails loudly (or logs) if mutually exclusive blocks are both present.
- Add tests covering: unit-present vs unit-absent, text vs no-text, interior vs exterior, food vs no-food.

---

## 13. Tests

- Existing tests assert on exact prompt sentences. Delete those assertions — they pin the system to wording this refactor is deliberately replacing.
- Replace with tests on **structure and behaviour**:
  - the right blocks are present/absent for each plan permutation;
  - no reference image is attached when `unitPresence === 'none'`;
  - budget compliance for worst-case inputs per endpoint;
  - no contradictory block pairs;
  - plan JSON schema validation, including malformed-LLM-output fallback;
  - brand-agnosticism: swapping the brand profile changes the output with no code edits (a test brand fixture is a good way to prove G4).
- `npx tsc --noEmit` and the build must pass.

---

## 14. Documentation deliverables

1. `docs/PROMPT_ARCHITECTURE.md` — the layer model, the block system, the JSON contracts, the budget config, the unit-presence rubric, and where to change what. This replaces the incident-archaeology comments.
2. Update `CLAUDE.md` and `ARCHITECTURE.MD` for the new flow (intent step, plan contracts, keywords removal, blog ordering change).
3. Update `PROGRESS.md` / `TASKS.md` per session rules.
4. A short changelog listing every removed concept and where its responsibility moved.

---

## 15. Acceptance criteria

- [ ] No keywords concept anywhere in any prompt path.
- [ ] No hardcoded moods, category visual hints, category briefs, or ad-angle briefs influencing generation.
- [ ] Unit presence is LLM-decided per scene/image, with rationale, and no keyword heuristics remain.
- [ ] A scene with no unit relevance ships with no reference image and an explicit no-branding block.
- [ ] Brand-specific strings exist only in the brand profile.
- [ ] Business-model truths (§2) are encoded and the negatives (§2.3) are enforced in every visual prompt path.
- [ ] Video plan carries a cast bible, look, per-scene continuity and beats; continuity is no longer the first thing dropped.
- [ ] Every prompt fits its endpoint budget through conditional inclusion; truncation is a logged last resort.
- [ ] Blog images are generated from the finished blog copy.
- [ ] Image prompts reserve the top-right watermark safe zone.
- [ ] Reel prompts specify vertical 9:16; image prompts specify 4:5.
- [ ] Tests rewritten to structural assertions; `tsc` and build pass.
- [ ] Docs updated; duplicate/stale composer copy removed.

---

## 16. Confirm with the owner before implementing

1. **Character limits:** is 3,500 the image-scene prompt limit, the Seedance video prompt limit, or both? What the provider docs say vs. what the owner stated.
2. **Image aspect ratio:** 4:5 only, or also 1:1 / 9:16 story assets?
3. **Reference photos:** approve pre-correcting the asset files (removing the extra wordmarks, URL text, QR panel, graphic wave) so prompts no longer need "ignore this" instructions?
4. **Keywords column:** stop reading it only, or also remove the column and dashboard field?
5. **Scene plan storage:** confirm the plan is stored as JSON so the new fields need no migration.
6. **Interior counter/sink:** confirm it stays in the interior description, given it must never read as a checkout counter.
7. **Statistics:** the current set includes a 2018 figure — keep, refresh, or restrict to education/awareness intents only?

Do not guess on any of these. Ask, then implement.
