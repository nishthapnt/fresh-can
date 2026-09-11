// Legal status transitions for content_language_tracks.status.
//
// Same reasoning as pipelineStateMachine.ts: the DB CHECK vocabulary also
// carries 'awaiting_shared'/'rendering', which are Video-only (a track
// waiting on shared visuals before it can render — ARCHITECTURE.MD §6.5).
// Blog has no render step; a track's "final output" is just text next to
// the pipeline's already-shared images. Blog's legal subset:
// waiting_on_shared -> generating -> draft_ready -> ready, plus stale/failed.
//
// 'awaiting_approval'/'approved' are in the DB vocabulary too, but Blog's
// approved design (docs/IMPLEMENTATION_PLAN.md Phase 2) treats draft_ready
// itself as "awaiting the user's approval" — there is no separate
// awaiting_approval state to enter/leave, approval is a single user action
// that takes draft_ready straight to ready. Simplification made at this
// implementation layer, not a change to the architecture doc.

export const BLOG_TRACK_STATUSES = [
  'waiting_on_shared', // generate_outline hasn't succeeded yet
  'generating', // generate_copy in progress
  'draft_ready', // finalize_draft succeeded — copy done AND shared visuals ready
  'ready', // user approved
  'stale', // shared visuals regenerated out from under a ready track
  'failed',
] as const

export type BlogTrackStatus = (typeof BLOG_TRACK_STATUSES)[number]

const TRANSITIONS: Record<BlogTrackStatus, BlogTrackStatus[]> = {
  waiting_on_shared: ['generating', 'failed'],
  generating: ['draft_ready', 'failed'],
  draft_ready: ['ready', 'failed'],
  ready: ['stale', 'failed'],
  stale: ['ready', 'failed'], // re-approval against the new shared visual, no re-render needed
  failed: ['waiting_on_shared', 'generating'], // retry re-enters at whichever step failed
}

export class IllegalTrackTransitionError extends Error {
  constructor(from: BlogTrackStatus, to: BlogTrackStatus) {
    super(`Illegal content_language_tracks transition: ${from} -> ${to}`)
    this.name = 'IllegalTrackTransitionError'
  }
}

export function assertTrackTransition(from: BlogTrackStatus, to: BlogTrackStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new IllegalTrackTransitionError(from, to)
  }
}

export function canTransitionTrack(from: BlogTrackStatus, to: BlogTrackStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}
