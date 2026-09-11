import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Downloads a provider's (ephemeral) image URL and re-uploads it to
 * permanent Supabase Storage. KIE.ai's own URLs expire (~14 days,
 * tempfile.aiquickdraw.com host) — the old n8n image_post flow already did
 * this download+reupload step; the Blog pipeline currently does NOT (a
 * known gap — see worker/src/steps/generateVisualImage.ts), but image_post
 * gets it from day one here since it's cheap to do right the first time.
 *
 * Bucket name and path convention (`{job_id}-final.jpg`) confirmed against
 * real objects already in the live `fc-image-posts` bucket, not invented —
 * keeps the new pipeline's files indistinguishable from n8n's.
 */
export interface PhotoStorageUploader {
  upload(jobId: string, tempImageUrl: string): Promise<string>
}

const STORAGE_BUCKET = 'fc-image-posts'

export class SupabasePhotoStorageUploader implements PhotoStorageUploader {
  constructor(
    private readonly client: SupabaseClient,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async upload(jobId: string, tempImageUrl: string): Promise<string> {
    const res = await this.fetchImpl(tempImageUrl)
    if (!res.ok) {
      throw new Error(`failed to download generated photo (status ${res.status})`)
    }
    const contentType = res.headers.get('content-type') ?? 'image/png'
    const bytes = new Uint8Array(await res.arrayBuffer())
    const path = `${jobId}-final.jpg`

    const { error } = await this.client.storage
      .from(STORAGE_BUCKET)
      .upload(path, bytes, { contentType, upsert: true })
    if (error) {
      throw new Error(`failed to upload photo to storage: ${error.message}`)
    }

    const { data } = this.client.storage.from(STORAGE_BUCKET).getPublicUrl(path)
    return data.publicUrl
  }
}
