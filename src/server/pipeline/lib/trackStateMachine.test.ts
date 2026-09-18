import { describe, it, expect } from 'vitest'
import {
  assertTrackTransition,
  canTransitionTrack,
  IllegalTrackTransitionError,
} from './trackStateMachine'

describe('language track state machine (Blog subset)', () => {
  it('allows the happy path: waiting_on_shared -> generating -> draft_ready -> ready', () => {
    expect(canTransitionTrack('waiting_on_shared', 'generating')).toBe(true)
    expect(canTransitionTrack('generating', 'draft_ready')).toBe(true)
    expect(canTransitionTrack('draft_ready', 'ready')).toBe(true)
  })

  it('allows a stale track to be re-approved straight to ready (no re-render step)', () => {
    expect(canTransitionTrack('ready', 'stale')).toBe(true)
    expect(canTransitionTrack('stale', 'ready')).toBe(true)
  })

  it('allows any state to fail', () => {
    for (const from of [
      'waiting_on_shared',
      'generating',
      'draft_ready',
      'ready',
      'stale',
    ] as const) {
      expect(canTransitionTrack(from, 'failed')).toBe(true)
    }
  })

  it('rejects skipping straight to ready from waiting_on_shared', () => {
    expect(canTransitionTrack('waiting_on_shared', 'ready')).toBe(false)
  })

  it('rejects one track transition affecting a different track (caller responsibility, sanity check on shape)', () => {
    // draft_ready never transitions directly back to generating without going through failed
    expect(canTransitionTrack('draft_ready', 'generating')).toBe(false)
  })

  it('assertTrackTransition throws IllegalTrackTransitionError on an illegal move', () => {
    expect(() => assertTrackTransition('waiting_on_shared', 'ready')).toThrow(
      IllegalTrackTransitionError,
    )
  })

  it('assertTrackTransition does not throw on a legal move', () => {
    expect(() => assertTrackTransition('generating', 'draft_ready')).not.toThrow()
  })
})
