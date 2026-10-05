import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ markPipelineFailed: vi.fn(), markTrackFailed: vi.fn(), status: 'rendering' as string | null }))
vi.mock('../server/pipeline/db', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: db.status ? { status: db.status } : null }) }) }),
    }),
  }),
  markPipelineFailed: db.markPipelineFailed,
  markTrackFailed: db.markTrackFailed,
}))

import { CredentialUnavailableError } from '../server/pipeline/credentials'
import { failJobOnRunFailure } from './runFailure'

const failed = (message: string, data: object) => ({
  event: { data: { function_id: 'freshcan-video-track-render', error: { message }, event: { data } } },
})
const msg = new CredentialUnavailableError('openai').message

beforeEach(() => {
  vi.clearAllMocks()
  db.status = 'rendering'
})

describe('failJobOnRunFailure', () => {
  it('keeps the credential message verbatim on the track', async () => {
    await failJobOnRunFailure(failed(msg, { trackId: 't1', pipelineId: 'p1' }))
    expect(db.markTrackFailed).toHaveBeenCalledWith(expect.anything(), 't1', msg)
    expect(db.markPipelineFailed).not.toHaveBeenCalled()
  })

  it('records any other run failure with the function and reason', async () => {
    await failJobOnRunFailure(failed('function timed out', { trackId: 't1' }))
    expect(db.markTrackFailed).toHaveBeenCalledWith(
      expect.anything(),
      't1',
      'Run stopped (freshcan-video-track-render): function timed out',
    )
  })

  it('fails the pipeline for pipeline-level functions', async () => {
    await failJobOnRunFailure(failed('KIE exploded', { pipelineId: 'p1' }))
    expect(db.markPipelineFailed).toHaveBeenCalledWith(expect.anything(), 'p1', expect.stringContaining('KIE exploded'))
  })

  it('does not overwrite a row already ready/failed (e.g. user cancel)', async () => {
    db.status = 'failed'
    await failJobOnRunFailure(failed('x', { trackId: 't1' }))
    expect(db.markTrackFailed).not.toHaveBeenCalled()
  })
})
