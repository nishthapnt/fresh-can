// Real progress estimate for an in-flight video job, derived from the same
// content_pipelines/content_language_tracks state the job detail page's
// "Shared production"/per-language cards already show — NOT a wall-clock
// timer. Used by GlobalProgressBar.tsx so the top progress bar can't say
// "90%, almost ready" while a pipeline is actually stuck or has failed.
//
// Two independent stages are combined:
//  - "shared" (0-50): script -> approval -> character ref + scene visuals,
//    the part every language track waits on before it can render.
//  - "track" (0-50): each language's own localize/voice/caption/render work,
//    which can start in parallel with shared visuals still generating (a
//    track can reach 'awaiting_shared' before scenes_visuals_ready_count
//    catches up) — averaged across every requested language.
// The two are summed, not weighted against each other, since a track's own
// progress is real work done independently of the shared stage finishing.

export interface VideoProgressPipeline {
  status: string
  scenes_visuals_ready_count: number | null
  scenes_total: number | null
}

export interface VideoProgressTrack {
  status: string
}

function sharedStageProgress(pipeline: VideoProgressPipeline): number {
  switch (pipeline.status) {
    case 'created':
      return 0
    case 'drafting':
      return 5
    case 'draft_ready':
      return 10
    case 'approved':
      return 15
    case 'generating': {
      const total = pipeline.scenes_total ?? 0
      const ready = pipeline.scenes_visuals_ready_count ?? 0
      const fraction = total > 0 ? ready / total : 0
      return 15 + Math.round(fraction * 35) // 15-50
    }
    case 'ready':
      return 50
    default: // 'failed' — caller should already treat this as terminal
      return 0
  }
}

function trackStageProgress(track: VideoProgressTrack): number {
  switch (track.status) {
    case 'waiting_on_shared':
      return 0
    // 'generating' spans localize_script -> synthesize_voice ->
    // transcribe_captions with no finer-grained status field to distinguish
    // them (current_step only flips once, at localize_script's own claim) —
    // a flat mid-value rather than a false sense of precision.
    case 'generating':
      return 20
    case 'awaiting_shared':
      return 35
    case 'rendering':
      return 45
    case 'ready':
      return 50
    default: // 'failed'
      return 0
  }
}

/** 0-100, or null if there's nothing real to compute yet (no tracks and no
 *  pipeline row) — caller decides what to show in that case. */
export function computeVideoProgress(
  pipeline: VideoProgressPipeline,
  tracks: VideoProgressTrack[],
): number {
  const shared = sharedStageProgress(pipeline)
  if (tracks.length === 0) return Math.min(99, shared)

  const trackAvg = tracks.reduce((sum, t) => sum + trackStageProgress(t), 0) / tracks.length
  const allReady = tracks.every((t) => t.status === 'ready')
  if (pipeline.status === 'ready' && allReady) return 100
  return Math.min(99, Math.round(shared + trackAvg))
}
