// Layer 4 (PROMPT_REFACTOR_BRIEF.md §4.5/§12) — structural contradiction
// prevention. Phase 4's unitBrandingBlock/noTextVariantFor already make the
// brief's own historical bug class ("no logos anywhere" sent alongside "the
// branded unit may appear") impossible to construct within a single,
// correctly-wired composer call — this is defense-in-depth: a loud failure
// if a future edit reintroduces the pairing (exactly what the Phase 5 fix
// to composeCharacterRefPrompt's empty-reference-pool branch would have
// caught), not a patch for a live bug.
import type { BrandProfile } from '../types'

export class PromptContradictionError extends Error {
  constructor(message: string) {
    super(`Prompt contradiction: ${message}`)
    this.name = 'PromptContradictionError'
  }
}

/**
 * Throws if the final prompt asserts both "no unit/text/logos at all" and
 * "the unit must look like X" in the same breath — brief §12's own
 * example. Called by every image composer right before it returns (never
 * composeSceneVideoPrompt, which is motion-only and never references the
 * brand's unit descriptors or noTextInstruction at all).
 */
export function assertNoContradiction(prompt: string, brand: BrandProfile): void {
  const saysNoTextAtAll = prompt.includes(brand.noTextInstruction)
  const assertsUnitStructure = prompt.includes(brand.unit.full) || prompt.includes(brand.unit.identity)
  if (saysNoTextAtAll && assertsUnitStructure) {
    throw new PromptContradictionError(
      'prompt contains both the blanket "no text, no logos, no watermarks" instruction and a "the unit must ' +
        'be built to this structure" instruction — these directly contradict each other (PROMPT_REFACTOR_BRIEF.md §12).',
    )
  }
}
