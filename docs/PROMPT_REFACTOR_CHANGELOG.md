# Prompt Refactor Changelog

Short reference for `PROMPT_REFACTOR_BRIEF.md` §14.4 — every concept
removed by the 8-phase prompt architecture refactor (Sessions 12-19,
2026-09-22) and where its responsibility moved. See
`docs/PROMPT_ARCHITECTURE.md` for the full design and reasoning; this file
only maps old → new.

| Removed | Replaced by |
|---|---|
| `keywords` form field read anywhere in a prompt path (form validation, `newContentStore`, `contentService`, every composer/step) | Layer 1's `CreativeBrief` (`steps/shared/interpretIntent.ts`) — an LLM-derived creative interpretation of the actual submission, not a raw keyword list. The DB column and form field still exist (dropping them needs a migration, out of scope without separate owner sign-off) but nothing reads them for generation anymore. |
| Long hand-tuned prose constants in `prompts/brand/fresh-can.ts` (`CONTAINER_DESCRIPTOR`, `BACKGROUND_TRUCK_CLAUSE`, etc.), each carrying inline incident-history comments | Structured `BrandProfile` data (Layer 0) — tiered `unit.{identity,full,interior,wordmarkText}`, atomic `forbiddenOnUnit`/`forbiddenInScene`/`businessModelNegatives` arrays, structured `referenceImages` with `whatItShows`/`disregard`. The incident history moved to `docs/PROMPT_ARCHITECTURE.md`'s Phase 1 section. |
| Keyword-regex unit-presence gating (`isContainerRelevant`, `isVideoSceneAboutUnit`) | LLM-decided `UnitPresence` (`'none'|'background'|'featured'`) per scene/image, with a required-or-optional rationale field depending on content type — see `docs/PROMPT_ARCHITECTURE.md`'s "Unit-presence rubric." |
| `prompts/core/scene.ts` (deleted, Phase 4) | Its responsibility split into `compose.ts`'s block system — `unitBrandingBlock`, `noTextVariantFor`/`noTextExceptUnitBranding`, `watermarkSafeZoneBlock`. |
| Hardcoded moods, category visual hints, category briefs, ad-angle briefs | Layer 1's `CreativeBrief` (LLM-derived per submission) feeding Layer 2's plans — no hardcoded creative direction remains in any composer. |
| Blog hero/inline images grounded only in the outline headline | A shared `ReferenceCopy` pass (`steps/blog/generateReferenceCopy.ts`, Phase 6) run once against the *finished* blog copy — hero gets the whole article's core message, inline gets its own section's visual moment. |
| Loose, ungrouped character-budget constants (`SCENE_IMAGE_PROMPT_CHAR_LIMIT`, `SCENE_VIDEO_PROMPT_CHAR_LIMIT`) | `prompts/core/limits.ts`'s `PROMPT_LIMITS`, verified against real provider behavior (not guessed), with `composeCharacterRefPrompt` budget-enforced by construction rather than truncated after the fact. |
| Untested/implicit contradiction risk (e.g. a no-branding scene and a unit-description block landing in the same prompt) | `prompts/core/contradictions.ts`'s `assertNoContradiction` — a structural runtime check, wired into all 4 image composers, not just a test assertion. |
| e2e test fakes dispatching on prompt-prose substrings (broke silently whenever a prompt got reworded) | A typed `stepName` field on `ScriptGenerationInput`, threaded through every real call site; the three `*Pipeline.e2e.test.ts` fakes dispatch on it directly. |
| Hardcoded `"Fresh CAN"`/`"Fresh-CAN"` literals outside the brand file — `ONE_WORDMARK_ONLY`, and `composeVideoScriptSystemPrompt`'s five clause constants (`CAMPAIGN_FIT`, `STORY_PLANNING_CLAUSE`, `FRESHCAN_ROLE_ADAPTIVITY`, `BRAND_ASSET_FIDELITY`, `FINAL_SELF_CHECK_CLAUSE`), plus two smaller instances in `composeLocalizeScriptSystemPrompt`/`composeCopySystemPrompt` | Every one parameterized on `brand.name`/`brand.unit.wordmarkText` (Phase 8) — verified with a dedicated "Acme Fresh Mart" brand-agnosticism test suite so a future reintroduction of this bug fails a test instead of shipping silently. |
