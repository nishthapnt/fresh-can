import { describe, it, expect } from 'vitest'
import { normalizeHashtags, stripTrailingHashtags, hashtagsToAppend } from './hashtags'

describe('hashtags', () => {
  it('normalizes prefixes, blanks and duplicates', () => {
    expect(normalizeHashtags(['#fresh', 'Fresh', ' ##local ', '', 'a b'])).toEqual(['fresh', 'local', 'ab'])
  })
  it('strips a trailing hashtag block from a caption', () => {
    expect(stripTrailingHashtags('Fresh today!\n\n#fresh #local')).toBe('Fresh today!')
    expect(stripTrailingHashtags('Love #fresh produce')).toBe('Love #fresh produce')
  })
  it('only appends tags missing from the caption', () => {
    expect(hashtagsToAppend('Fresh #local', ['local', '#fresh'])).toEqual(['#fresh'])
  })
})
