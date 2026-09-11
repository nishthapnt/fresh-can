# Blog Feature Specification

Legend: [CURRENT] verified existing behavior · [BUG] confirmed defect, not a requirement · [TARGET] corrected/intended behavior once Blog runs on the new architecture.

## 1. Purpose
A Blog job takes one topic and its metadata and produces a fully drafted, editable blog post — title, structured sections, SEO fields, hero + inline images — per requested language, ready for human review and approval before it appears in the Library.

## 2. Inputs
[CURRENT] Created from the same intake form as Video/Image: topic, keywords, category, target_audience, language (EN|FR|BOTH). Unlike Image, Blog has no clarifying-questions step — generation starts immediately on submit.

## 3. EN behavior
[TARGET] language=EN creates exactly one language track. Outline + copy generation runs once, in English, against the shared visual assets (§6). The user reviews, edits, and approves a single EN draft; final output is one blog post in English.

## 4. FR behavior
[TARGET] Symmetric to EN — one language track, French outline+copy, reusing the same shared visuals. No separate visual generation for French.

## 5. BOTH behavior
[BUG — current] A BOTH job fires blog generation exactly once, forwarding the literal string `"BOTH"` as the language. The trigger route writes that value directly onto the resulting `content_drafts` row's `language` column — one row literally tagged `language='BOTH'`, not two independent outputs. Confirmed by tracing `dashboard/new/page.tsx`'s single-call `triggerNonImageTypes` and the trigger route's unmodified `payload.language` pass-through.

[TARGET] BOTH is a request-level concept only. It always produces exactly two independent, separately-editable, separately-approvable outputs: one EN track and one FR track. The literal value `'BOTH'` never appears below the job level. Each track can be approved, fail, or retry independently of the other.

## 6. Shared visual assets
[BUG — current] Hero/inline images are generated inside whatever single generation call fires for the job, with no guarantee two separate generations (if they ever occur) would produce the same images. Image URLs currently point to a third-party ephemeral host (confirmed via live sample data: `tempfile.aiquickdraw.com`), not permanent storage — they may expire.

[TARGET] Hero and inline images are generated exactly once per job, before language-specific generation happens, and stored permanently. Every requested language's output references the same images. Regenerating the visual never requires regenerating any language's text.

## 7. Outline / copy generation
[CURRENT, preserved] Two-stage generation — outline/structure, then full copy — producing a structured document: title, intro, sections (heading, sub-headings, paragraphs, list items, optional blockquote, optional inline-image placement), conclusion, CTA, SEO fields (meta description, focus keyword, secondary keywords, OG title/description, read time estimate, slug).

[TARGET] Same structure, generated per language track, always against the one shared set of visuals — never regenerating them.

## 8. Image generation
[BUG — current, see §6] Generated per-generation-call, embedded directly in that call's draft payload.

[TARGET] Generated once per job as a shared asset, referenced (not duplicated) by every language track's draft and final output.

## 9. Draft lifecycle
[BUG — current] Blog is the only content type where the draft is written synchronously, inside the HTTP response of the very request that starts generation (`api/n8n/trigger/route.ts`, blog branch) — instead of asynchronously via the callback every other type uses. The initiating request must stay open for the full outline+copy+image duration, risking a timeout on longer posts.

[TARGET] Draft creation is asynchronous: the job is created and the user can navigate away immediately; the draft becomes available once generation completes, reported the same way every other pipeline step reports completion.

## 10. Editing
[CURRENT, preserved as-is] Every field is editable — title, slug, status, each section's contents, conclusion, CTA, SEO fields — before approval. Edits persist to the draft only when Approve is clicked (no autosave today). Final HTML is derived from the structured content, never authored directly.

[TARGET] Same editing model; only the plumbing (fetch/save target) moves to the new pipeline/track-scoped backend API.

## 11. Approval
[BUG — current] DB-only, no webhook. The client also writes directly to `generated_content` on approval — duplicating logic that, for every other content type, lives only in the callback route.

[TARGET] Approval is per language track; one track's approval never affects the other. The client no longer writes `generated_content` directly — that stays backend-owned.

## 12. Final output
[CURRENT, shape preserved] An approved blog produces a Library entry — hero image as thumbnail, structured content + SEO fields in `output_data`, with both new-format and legacy-format keys for the existing Library grid.

[TARGET] Same shape; a BOTH job produces two independent Library entries (EN and FR) instead of one ambiguous row.

## 13. Regeneration
[BUG — current] Regenerate resets the whole draft to pending and re-fires the entire generation call; there's no way to regenerate only the images or only the copy — any edit forces full re-generation, including images that were fine.

[TARGET] Two independent scopes: "regenerate visuals" (re-runs only hero/inline generation; every track's text is untouched) and "regenerate copy" (re-runs only that language's text; shared visuals untouched). Full regenerate remains available but isn't the only option.

## 14. Failure behavior
[BUG — current] `status: 'failed'` exists in the `job_status` enum but is never written anywhere in the app (confirmed by search). A failed generation or exhausted retry leaves the job/draft silently stuck; the only user-visible signal is a client-side polling timeout that changes no stored record.

[TARGET] Failure is written and surfaced at the language-track level (rolled up to the job level): a step that exhausts retries marks its owning track (or the shared pipeline, for a shared-visual failure) failed, with a stored error message. One track failing never marks the other failed.

## 15. Retry behavior
[BUG — current] No app-level retry exists beyond n8n's own internal, undocumented in-memory counters. The only recourse today is a full regenerate.

[TARGET] A failed language track (or failed shared-visual generation) can be retried independently, resuming from the failed step. Retrying one track never touches the other track or the shared assets.

## 16. Duplicate / idempotency behavior
[BUG — current] Nothing prevents a double-click, a retried fetch, or two open tabs from firing blog generation twice for the same job — no idempotency key exists anywhere in the trigger path.

[TARGET] Every state-mutating action (start generation, approve, regenerate, retry) is idempotent — a duplicate call for the same job/track/action either no-ops or returns the existing result.

## Out of scope
Scheduling, multi-variant posts, publishing integrations beyond the existing Library flow. Video and Image behavior — unaffected, documented separately.
