import { CREDENTIAL_UNAVAILABLE_PREFIX } from '../server/pipeline/credentials'
import { createServiceClient, markPipelineFailed, markTrackFailed } from '../server/pipeline/db'

// onFailure handler shared by every job-scoped pipeline function. When a job's
// pinned credential is gone, getApiKey throws a non-retriable
// CredentialUnavailableError at the top of the function — before any step has
// claimed or failed the row — so without this the run would die in Inngest
// while the job sat at "generating" in the UI. This marks the track/pipeline
// failed with the explicit message instead. Any other failure is left to the
// function's existing handling.
export async function failJobOnCredentialUnavailable({
  event,
}: {
  event: { data: { error?: { message?: string }; event?: { data?: unknown } } }
}): Promise<void> {
  const message = event.data.error?.message
  if (!message?.startsWith(CREDENTIAL_UNAVAILABLE_PREFIX)) return
  const original = (event.data.event?.data ?? {}) as { pipelineId?: string; trackId?: string }
  const client = createServiceClient()
  if (original.trackId) await markTrackFailed(client, original.trackId, message)
  else if (original.pipelineId) await markPipelineFailed(client, original.pipelineId, message)
}
