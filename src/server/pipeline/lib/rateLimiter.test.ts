import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SlidingWindowRateLimiter } from './rateLimiter'

describe('SlidingWindowRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows up to `max` acquisitions within the window with no delay', async () => {
    const limiter = new SlidingWindowRateLimiter(3, 1000)
    const start = Date.now()
    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()
    expect(Date.now() - start).toBe(0)
  })

  it('blocks the (max+1)th acquisition until the oldest timestamp falls outside the window', async () => {
    const limiter = new SlidingWindowRateLimiter(2, 1000)
    await limiter.acquire()
    await limiter.acquire()

    const third = limiter.acquire()
    let resolved = false
    third.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(resolved).toBe(false) // window hasn't elapsed yet

    await vi.advanceTimersByTimeAsync(600) // now past the 1000ms window
    await third
    expect(resolved).toBe(true)
  })

  it('tracks each provider instance independently (this codebase\'s own reasoning for one instance per account, not one shared limiter)', async () => {
    const kie = new SlidingWindowRateLimiter(1, 1000)
    const uploadPost = new SlidingWindowRateLimiter(1, 1000)
    await kie.acquire() // fills kie's own window
    // uploadPost's window is untouched by kie's usage — must not block.
    const start = Date.now()
    await uploadPost.acquire()
    expect(Date.now() - start).toBe(0)
  })
})
