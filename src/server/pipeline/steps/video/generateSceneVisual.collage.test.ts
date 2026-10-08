import { describe, it, expect } from 'vitest'
import { buildCorrectionInstruction, COLLAGE_ISSUE, isCollageIssue } from './generateSceneVisual'

describe('collage rejection helpers', () => {
  it('recognises collage-type issues from the local detector and from the vision gate', () => {
    expect(isCollageIssue(COLLAGE_ISSUE)).toBe(true)
    expect(isCollageIssue('image is a collage of three photos')).toBe(true)
    expect(isCollageIssue('split-screen layout')).toBe(true)
    expect(isCollageIssue('multi-panel layout')).toBe(true)
    expect(isCollageIssue('stacked panels')).toBe(true)
  })

  it('does not treat ordinary defects as collages', () => {
    expect(isCollageIssue('disembodied hand floating above the counter')).toBe(false)
    expect(isCollageIssue('extra person standing behind the truck')).toBe(false)
    expect(isCollageIssue('the truck panel is dented')).toBe(false)
  })

  it('regenerates a collage from scratch with a single-frame instruction, not "preserve everything else"', () => {
    const text = buildCorrectionInstruction([COLLAGE_ISSUE])
    expect(text).toContain('ONE single continuous photograph')
    expect(text).not.toContain('Preserve everything else')
  })

  it('keeps the targeted-fix wording for ordinary defects', () => {
    const text = buildCorrectionInstruction(['disembodied hand floating above the counter'])
    expect(text).toContain('Fix this specific issue: disembodied hand floating above the counter')
    expect(text).toContain('Preserve everything else')
  })
})
