import { describe, it, expect, vi } from 'vitest'
import { UploadPostSocialPublisher } from './socialPublisher'
import { ProviderCallError } from './types'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  })) as unknown as typeof fetch
}

function capturingFetch() {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    capturedUrl = url
    capturedInit = init
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, results: { instagram: { success: true, url: 'https://instagram.com/p/abc' } } }),
      text: async () => '',
    }
  }) as unknown as typeof fetch
  return {
    fetchImpl,
    getUrl: () => capturedUrl,
    getInit: () => capturedInit,
  }
}

describe('UploadPostSocialPublisher (upload-post.com — docs.upload-post.com)', () => {
  describe('publish()', () => {
    it('posts to /api/upload for video content', async () => {
      const { fetchImpl, getUrl } = capturingFetch()
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      await publisher.publish({
        contentType: 'video',
        platforms: ['instagram'],
        caption: 'Check out this truck',
        hashtags: ['fresh'],
        mediaUrl: 'https://example.com/video.mp4',
      })
      expect(getUrl()).toBe('https://api.upload-post.com/api/upload')
    })

    it('posts to /api/upload_photos for image_post/blog content', async () => {
      const { fetchImpl, getUrl } = capturingFetch()
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      await publisher.publish({
        contentType: 'image_post',
        platforms: ['instagram'],
        caption: 'A fresh photo',
        hashtags: [],
        mediaUrl: 'https://example.com/photo.png',
      })
      expect(getUrl()).toBe('https://api.upload-post.com/api/upload_photos')
    })

    it('sends the Apikey auth header (confirmed live scheme, same as avMerger.ts)', async () => {
      const { fetchImpl, getInit } = capturingFetch()
      const publisher = new UploadPostSocialPublisher('my-secret-key', 'test-profile', fetchImpl)
      await publisher.publish({
        contentType: 'video',
        platforms: ['instagram'],
        caption: 'x',
        hashtags: [],
        mediaUrl: 'https://example.com/v.mp4',
      })
      const headers = getInit()!.headers as Record<string, string>
      expect(headers.Authorization).toBe('Apikey my-secret-key')
    })

    it('sends user/platform[]/video as multipart form fields for video', async () => {
      const { fetchImpl, getInit } = capturingFetch()
      const publisher = new UploadPostSocialPublisher('test-key', 'fc-profile', fetchImpl)
      await publisher.publish({
        contentType: 'video',
        platforms: ['instagram', 'facebook'],
        caption: 'Fresh produce today',
        hashtags: ['fresh', 'local'],
        mediaUrl: 'https://example.com/video.mp4',
      })
      const body = getInit()!.body as FormData
      expect(body.get('user')).toBe('fc-profile')
      expect(body.getAll('platform[]')).toEqual(['instagram', 'facebook'])
      expect(body.get('video')).toBe('https://example.com/video.mp4')
      expect(body.get('title')).toBe('Fresh produce today #fresh #local')
      expect(body.getAll('photos[]')).toEqual([])
    })

    it('sends photos[] (not video) as a form field for image_post/blog', async () => {
      const { fetchImpl, getInit } = capturingFetch()
      const publisher = new UploadPostSocialPublisher('test-key', 'fc-profile', fetchImpl)
      await publisher.publish({
        contentType: 'blog',
        platforms: ['facebook'],
        caption: 'Read our latest post',
        hashtags: [],
        mediaUrl: 'https://example.com/hero.png',
      })
      const body = getInit()!.body as FormData
      expect(body.getAll('photos[]')).toEqual(['https://example.com/hero.png'])
      expect(body.get('video')).toBeNull()
    })

    it('returns status=ready with per-platform outcomes for a synchronous response', async () => {
      const fetchImpl = mockFetch({
        jsonBody: {
          success: true,
          results: {
            instagram: { success: true, url: 'https://instagram.com/p/abc' },
            facebook: { success: false, error: 'token expired' },
          },
        },
      })
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      const outcome = await publisher.publish({
        contentType: 'image_post',
        platforms: ['instagram', 'facebook'],
        caption: 'x',
        hashtags: [],
        mediaUrl: 'https://example.com/p.png',
      })
      expect(outcome).toEqual({
        status: 'ready',
        perPlatform: [
          { platform: 'instagram', success: true, url: 'https://instagram.com/p/abc', error: undefined },
          { platform: 'facebook', success: false, url: undefined, error: 'token expired' },
        ],
      })
    })

    it('returns status=pending with a request jobRef for the async response shape', async () => {
      const fetchImpl = mockFetch({
        jsonBody: { success: true, message: 'Upload initiated successfully in background.', request_id: 'req-123', total_platforms: 2 },
      })
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      const outcome = await publisher.publish({
        contentType: 'video',
        platforms: ['instagram', 'facebook'],
        caption: 'x',
        hashtags: [],
        mediaUrl: 'https://example.com/v.mp4',
      })
      expect(outcome).toEqual({ status: 'pending', jobRef: { kind: 'request', requestId: 'req-123' } })
    })

    it('returns status=pending with a job jobRef for the scheduled response shape', async () => {
      const fetchImpl = mockFetch({ jsonBody: { success: true, job_id: 'scheduler_job_123' } })
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      const outcome = await publisher.publish({
        contentType: 'video',
        platforms: ['instagram'],
        caption: 'x',
        hashtags: [],
        mediaUrl: 'https://example.com/v.mp4',
      })
      expect(outcome).toEqual({ status: 'pending', jobRef: { kind: 'job', jobId: 'scheduler_job_123' } })
    })

    it('throws ProviderCallError when the response has neither results, request_id, nor job_id', async () => {
      const fetchImpl = mockFetch({ jsonBody: { success: false } })
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      await expect(
        publisher.publish({
          contentType: 'video',
          platforms: ['instagram'],
          caption: 'x',
          hashtags: [],
          mediaUrl: 'https://example.com/v.mp4',
        }),
      ).rejects.toThrow(ProviderCallError)
    })

    it('throws ProviderCallError on a non-ok HTTP response', async () => {
      const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid api key' })
      const publisher = new UploadPostSocialPublisher('bad-key', 'test-profile', fetchImpl)
      await expect(
        publisher.publish({
          contentType: 'video',
          platforms: ['instagram'],
          caption: 'x',
          hashtags: [],
          mediaUrl: 'https://example.com/v.mp4',
        }),
      ).rejects.toThrow(ProviderCallError)
    })
  })

  describe('poll()', () => {
    it('queries request_id for a request-kind jobRef', async () => {
      const { fetchImpl, getUrl } = capturingFetch()
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      await publisher.poll({ kind: 'request', requestId: 'req-123' })
      expect(getUrl()).toBe('https://api.upload-post.com/api/uploadposts/status?request_id=req-123')
    })

    it('queries job_id for a job-kind jobRef', async () => {
      const { fetchImpl, getUrl } = capturingFetch()
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      await publisher.poll({ kind: 'job', jobId: 'scheduler_job_123' })
      expect(getUrl()).toBe('https://api.upload-post.com/api/uploadposts/status?job_id=scheduler_job_123')
    })

    it('returns status=ready with per-platform outcomes once results appear', async () => {
      const fetchImpl = mockFetch({
        jsonBody: { results: { instagram: { success: true, url: 'https://instagram.com/p/abc' } } },
      })
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      const result = await publisher.poll({ kind: 'request', requestId: 'req-123' })
      expect(result).toEqual({
        status: 'ready',
        perPlatform: [{ platform: 'instagram', success: true, url: 'https://instagram.com/p/abc', error: undefined }],
      })
    })

    it('returns status=failed when the provider reports an error status', async () => {
      const fetchImpl = mockFetch({ jsonBody: { status: 'error', error: 'transcoding failed' } })
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      const result = await publisher.poll({ kind: 'request', requestId: 'req-123' })
      expect(result).toEqual({ status: 'failed', detail: 'transcoding failed' })
    })

    it('returns status=pending for an unrecognized/in-progress body (fail-safe-to-pending, same as avMerger.ts)', async () => {
      const fetchImpl = mockFetch({ jsonBody: { status: 'processing' } })
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      const result = await publisher.poll({ kind: 'request', requestId: 'req-123' })
      expect(result).toEqual({ status: 'pending' })
    })

    it('throws ProviderCallError on a non-ok HTTP response', async () => {
      const fetchImpl = mockFetch({ ok: false, status: 404, textBody: 'not found' })
      const publisher = new UploadPostSocialPublisher('test-key', 'test-profile', fetchImpl)
      await expect(publisher.poll({ kind: 'request', requestId: 'req-123' })).rejects.toThrow(ProviderCallError)
    })
  })
})
