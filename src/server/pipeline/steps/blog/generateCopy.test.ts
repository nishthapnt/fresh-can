import { describe, it, expect } from 'vitest'
import { ensureExactlyOneInlineImageSection } from './generateCopy'

function draftWith(sections: Array<{ has_inline_image?: boolean }>) {
  return { content: { sections: sections.map((s, i) => ({ heading: `s${i}`, ...s })) } }
}

describe('ensureExactlyOneInlineImageSection', () => {
  it('leaves the output untouched when exactly one section is already flagged', () => {
    const parsed = draftWith([{ has_inline_image: false }, { has_inline_image: true }, { has_inline_image: false }])
    const result = ensureExactlyOneInlineImageSection(parsed) as typeof parsed
    expect(result.content.sections.map((s) => s.has_inline_image)).toEqual([false, true, false])
  })

  it('forces the middle section true when the model flags none (confirmed live 2026-09-17)', () => {
    const parsed = draftWith([{ has_inline_image: false }, {}, { has_inline_image: false }, {}, {}])
    const result = ensureExactlyOneInlineImageSection(parsed) as typeof parsed
    expect(result.content.sections.map((s) => s.has_inline_image)).toEqual([false, false, true, false, false])
  })

  it('collapses to the middle section when the model flags more than one', () => {
    const parsed = draftWith([{ has_inline_image: true }, {}, { has_inline_image: true }])
    const result = ensureExactlyOneInlineImageSection(parsed) as typeof parsed
    expect(result.content.sections.map((s) => s.has_inline_image)).toEqual([false, true, false])
  })

  it('preserves every other field on each section untouched', () => {
    const parsed = { content: { sections: [{ heading: 'Intro', paragraphs: ['a'] }] } }
    const result = ensureExactlyOneInlineImageSection(parsed) as { content: { sections: Array<Record<string, unknown>> } }
    expect(result.content.sections[0]).toEqual({ heading: 'Intro', paragraphs: ['a'], has_inline_image: true })
  })

  it('passes through non-object input unchanged', () => {
    expect(ensureExactlyOneInlineImageSection(null)).toBeNull()
    expect(ensureExactlyOneInlineImageSection('raw text')).toBe('raw text')
  })

  it('passes through an object missing content/sections unchanged', () => {
    const parsed = { post_title: 'x' }
    expect(ensureExactlyOneInlineImageSection(parsed)).toBe(parsed)
  })
})
