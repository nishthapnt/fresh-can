import { CREDENTIAL_UNAVAILABLE_PREFIX } from '../server/pipeline/credentials'
import { createServiceClient, markPipelineFailed, markTrackFailed } from '../server/pipeline/db'

// onFailure handler shared by every job-scoped pipeline function. Inngest
// calls it once a run has failed terminally (retries exhausted, thrown
// non-retriable error, or the function-level timeout) — nothing will resume
// that run, so any row it left in-flight would otherwise sit at "generating"
// forever with no explanation (a render stalled for ~11h this way). Records
// the real reason on the track/pipeline so the job page shows it, and rolls
// the job to 'failed' via markTrackFailed/markPipelineFailed.
// A credential-unavailable error keeps its message verbatim; anything else is
// prefixed so it's clear the run itself stopped, not a provider rejection.
export async function failJobOnRunFailure({
  event,
}: {
  event: {
    data: {
      function_id?: string
      error?: { message?: string; name?: string }
      event?: { data?: unknown }
    }
  }
}): Promise<void> {
  const raw = event.data.error?.message ?? event.data.error?.name ?? 'unknown error'
  const message = raw.startsWith(CREDENTIAL_UNAVAILABLE_PREFIX)
    ? raw
    : `Run stopped (${event.data.function_id ?? 'pipeline function'}): ${raw}`
  const original = (event.data.event?.data ?? {}) as { pipelineId?: string; trackId?: string }
  const client = createServiceClient()

  // Only fail rows still in flight — a user cancel or an earlier terminal
  // outcome already wrote its own, more specific, last_error.
  if (original.trackId) {
    const { data } = await client.from('content_language_tracks').select('status').eq('id', original.trackId).maybeSingle()
    if (data && data.status !== 'ready' && data.status !== 'failed') {
      await markTrackFailed(client, original.trackId, message)
    }
  } else if (original.pipelineId) {
    const { data } = await client.from('content_pipelines').select('status').eq('id', original.pipelineId).maybeSingle()
    if (data && data.status !== 'ready' && data.status !== 'failed') {
      await markPipelineFailed(client, original.pipelineId, message)
    }
  }
}
