import { describe, it, expect } from 'vitest'
import { validateBlogDraftSaveRequest } from './saveDraft'

describe('validateBlogDraftSaveRequest', () => {
  it('accepts a well-formed request', () => {
    const result = validateBlogDraftSaveRequest({ language: 'EN', draft_data: { post_title: 'x' } })
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.request).toEqual({ language: 'EN', draftData: { post_title: 'x' } })
  })

  it('accepts FR', () => {
    expect('error' in validateBlogDraftSaveRequest({ language: 'FR', draft_data: {} })).toBe(false)
  })

  it('rejects a missing/invalid language', () => {
    expect('error' in validateBlogDraftSaveRequest({ language: 'DE', draft_data: {} })).toBe(true)
    expect('error' in validateBlogDraftSaveRequest({ draft_data: {} })).toBe(true)
  })

  it('rejects missing draft_data', () => {
    expect('error' in validateBlogDraftSaveRequest({ language: 'EN' })).toBe(true)
  })

  it('rejects a non-object draft_data', () => {
    expect('error' in validateBlogDraftSaveRequest({ language: 'EN', draft_data: 'nope' })).toBe(true)
    expect('error' in validateBlogDraftSaveRequest({ language: 'EN', draft_data: [] })).toBe(true)
  })

  it('rejects a non-object body', () => {
    expect('error' in validateBlogDraftSaveRequest(null)).toBe(true)
    expect('error' in validateBlogDraftSaveRequest('nope')).toBe(true)
  })
})
