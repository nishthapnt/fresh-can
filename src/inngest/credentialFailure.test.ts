import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ markPipelineFailed: vi.fn(), markTrackFailed: vi.fn() }))
vi.mock('../server/pipeline/db', () => ({ createServiceClient: () => ({}), ...db }))

import { CredentialUnavailableError } from '../server/pipeline/credentials'
import { failJobOnCredentialUnavailable } from './credentialFailure'

const failed = (message: string, data: object) => ({ event: { data: { error: { message }, event: { data } } } })
const msg = new CredentialUnavailableError('openai').message

beforeEach(() => vi.clearAllMocks())

describe('failJobOnCredentialUnavailable', () => {
  it('marks the track failed with the explicit message when a track function lost its credential', async () => {
    await failJobOnCredentialUnavailable(failed(msg, { trackId: 't1', pipelineId: 'p1', jobId: 'j1' }))
    expect(db.markTrackFailed).toHaveBeenCalledWith({}, 't1', msg)
    expect(db.markPipelineFailed).not.toHaveBeenCalled()
  })

  it('marks the pipeline failed for pipeline-level functions', async () => {
    await failJobOnCredentialUnavailable(failed(msg, { pipelineId: 'p1', jobId: 'j1' }))
    expect(db.markPipelineFailed).toHaveBeenCalledWith({}, 'p1', msg)
  })

  it('ignores every other failure (existing handling is untouched)', async () => {
    await failJobOnCredentialUnavailable(failed('KIE exploded', { pipelineId: 'p1' }))
    expect(db.markPipelineFailed).not.toHaveBeenCalled()
    expect(db.markTrackFailed).not.toHaveBeenCalled()
  })
})
