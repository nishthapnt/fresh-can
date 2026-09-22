// Single source of truth for the logo watermark's geometry — imported by
// both watermark.ts (the actual compositing math) and prompts/core/
// compose.ts (the safe-zone prompt description, PROMPT_REFACTOR_BRIEF.md
// §10), so the prompt's description of the reserved corner can never drift
// from where the logo is really placed.
export const LOGO_WIDTH_FRACTION = 0.16
export const MARGIN_FRACTION = 0.035
// The corner vignette that keeps the logo legible on any background extends
// well beyond the logo's own footprint (see watermark.ts's own header) —
// this is the real "keep this area clean" radius for prompt purposes, not
// just the logo box itself.
export const SAFE_ZONE_RADIUS_FRACTION = 0.42
