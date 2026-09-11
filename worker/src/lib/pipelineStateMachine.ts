// Legal status transitions for content_pipelines.status.
//
// The live CHECK constraint's full vocabulary (see the Phase 1 migration)
// is a superset shared with Video's future, richer flow — 'draft_ready',
// 'awaiting_approval', 'approved' exist there for Video's project-level
// script-approval gate (ARCHITECTURE.MD §6.4), which Blog does not have.
// Blog/Image generate their shared visual immediately, no pre-generation
// approval step — so Blog's LEGAL SUBSET of that vocabulary is only:
// created, drafting, generating, ready, stale, failed. Attempting a
// transition through 'draft_ready'/'awaiting_approval'/'approved' is a
// programming error for Blog and rejected here, even though the DB CHECK
// constraint itself would allow the raw value (docs/DATABASE_DESIGN.md §2.3).

export const BLOG_PIPELINE_STATUSES = [
  'created',
  'drafting', // generating the outline
  'generating', // generating shared hero+inline visuals
  'ready', // shared_visual_ready — both hero and inline succeeded
  'stale', // a regenerate bumped current_generation; tracks that were ready flip to stale too
  'failed',
] as const

export type BlogPipelineStatus = (typeof BLOG_PIPELINE_STATUSES)[number]

const TRANSITIONS: Record<BlogPipelineStatus, BlogPipelineStatus[]> = {
  created: ['drafting', 'failed'],
  drafting: ['generating', 'failed'],
  generating: ['ready', 'failed'],
  ready: ['stale', 'failed'],
  stale: ['generating', 'failed'],
  failed: ['drafting', 'generating'], // retry re-enters at whichever step failed
}

export class IllegalPipelineTransitionError extends Error {
  constructor(from: BlogPipelineStatus, to: BlogPipelineStatus) {
    super(`Illegal content_pipelines transition: ${from} -> ${to}`)
    this.name = 'IllegalPipelineTransitionError'
  }
}

export function assertPipelineTransition(
  from: BlogPipelineStatus,
  to: BlogPipelineStatus,
): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new IllegalPipelineTransitionError(from, to)
  }
}

export function canTransitionPipeline(
  from: BlogPipelineStatus,
  to: BlogPipelineStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}
