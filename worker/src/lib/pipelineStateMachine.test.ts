import { describe, it, expect } from 'vitest'
import {
  assertPipelineTransition,
  canTransitionPipeline,
  IllegalPipelineTransitionError,
} from './pipelineStateMachine.js'

describe('pipeline state machine (Blog subset)', () => {
  it('allows the happy path: created -> drafting -> generating -> ready', () => {
    expect(canTransitionPipeline('created', 'drafting')).toBe(true)
    expect(canTransitionPipeline('drafting', 'generating')).toBe(true)
    expect(canTransitionPipeline('generating', 'ready')).toBe(true)
  })

  it('allows any state to fail', () => {
    for (const from of ['created', 'drafting', 'generating', 'ready', 'stale'] as const) {
      expect(canTransitionPipeline(from, 'failed')).toBe(true)
    }
  })

  it('allows ready -> stale -> generating for a visual regenerate', () => {
    expect(canTransitionPipeline('ready', 'stale')).toBe(true)
    expect(canTransitionPipeline('stale', 'generating')).toBe(true)
  })

  it('allows failed to re-enter at drafting or generating (retry)', () => {
    expect(canTransitionPipeline('failed', 'drafting')).toBe(true)
    expect(canTransitionPipeline('failed', 'generating')).toBe(true)
  })

  it('rejects skipping a stage', () => {
    expect(canTransitionPipeline('created', 'ready')).toBe(false)
    expect(canTransitionPipeline('created', 'generating')).toBe(false)
  })

  it('rejects going backwards', () => {
    expect(canTransitionPipeline('generating', 'drafting')).toBe(false)
    expect(canTransitionPipeline('ready', 'drafting')).toBe(false)
  })

  it('rejects a no-op transition to the same state', () => {
    expect(canTransitionPipeline('generating', 'generating')).toBe(false)
  })

  it('assertPipelineTransition throws IllegalPipelineTransitionError on an illegal move', () => {
    expect(() => assertPipelineTransition('created', 'ready')).toThrow(
      IllegalPipelineTransitionError,
    )
  })

  it('assertPipelineTransition does not throw on a legal move', () => {
    expect(() => assertPipelineTransition('created', 'drafting')).not.toThrow()
  })
})
