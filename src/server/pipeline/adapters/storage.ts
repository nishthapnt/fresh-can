import type { SupabaseClient } from '@supabase/supabase-js'
import { compositeLogoWatermark } from '../lib/watermark'

/**
 * Downloads a provider's (ephemeral) image URL and re-uploads it to
 * permanent Supabase Storage. KIE.ai's own URLs expire (~14 days,
 * tempfile.aiquickdraw.com host) — the old n8n image_post flow already did
 * this download+reupload step; the Blog pipeline currently does NOT (a
 * known gap — see worker/src/steps/blog/generateVisualImage.ts), but image_post
 * gets it from day one here since it's cheap to do right the first time.
 *
 * Also composites the real Fresh-CAN logo into the top-right corner (see
 * lib/watermark.ts) before uploading — this is the one place every image_post
 * photo (any retry, any regeneration) passes through, so doing it here means
 * no caller has to remember to apply it.
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
    const rawBytes = Buffer.from(await res.arrayBuffer())
    // compositeLogoWatermark always re-encodes to JPEG, so the uploaded
    // content-type is fixed here rather than taken from the provider's
    // response (which no longer reflects the actual bytes being sent).
    const bytes = await compositeLogoWatermark(rawBytes)
    const path = `${jobId}-final.jpg`

    const { error } = await this.client.storage
      .from(STORAGE_BUCKET)
      .upload(path, bytes, { contentType: 'image/jpeg', upsert: true })
    if (error) {
      throw new Error(`failed to upload photo to storage: ${error.message}`)
    }

    const { data } = this.client.storage.from(STORAGE_BUCKET).getPublicUrl(path)
    return data.publicUrl
  }
}

/**
 * Video-only bucket. Storage path convention is `{job_id}/{language}.mp4`
 * for renders (ARCHITECTURE.MD §17.2); scene audio uses `{job_id}/
 * {language}/{scene_number}.mp3` under the same bucket, per-language and
 * per-scene like content_visual_assets' own generation-scoped rows.
 */
const VIDEO_STORAGE_BUCKET = 'freshcan-videos'

export interface VideoStorageUploader {
  /** For ElevenLabs' audio bytes (no ephemeral URL to download from — the
   *  provider call is synchronous and hands back a Buffer directly) and for
   *  upload-post.com's FFmpeg render download (which needs an auth header
   *  neither `upload()` nor a plain unauthenticated fetch can provide). */
  uploadBuffer(path: string, buffer: Buffer, contentType: string): Promise<string>
  /** For KIE.ai's ephemeral image/video URLs (character_ref, scene_image,
   *  scene_video_clip) — same download-then-reupload shape as
   *  SupabasePhotoStorageUploader.upload(), parameterized by path instead of
   *  a fixed `{jobId}-final.jpg` convention, since video has several
   *  differently-named assets per job (character ref, N scene images, N
   *  scene clips) sharing one bucket. */
  uploadFromUrl(path: string, tempUrl: string): Promise<string>
}

export class SupabaseVideoStorageUploader implements VideoStorageUploader {
  constructor(
    private readonly client: SupabaseClient,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async uploadBuffer(path: string, buffer: Buffer, contentType: string): Promise<string> {
    const { error } = await this.client.storage
      .from(VIDEO_STORAGE_BUCKET)
      .upload(path, buffer, { contentType, upsert: true })
    if (error) {
      throw new Error(`failed to upload to ${VIDEO_STORAGE_BUCKET}/${path}: ${error.message}`)
    }

    const { data } = this.client.storage.from(VIDEO_STORAGE_BUCKET).getPublicUrl(path)
    return data.publicUrl
  }

  async uploadFromUrl(path: string, tempUrl: string): Promise<string> {
    const res = await this.fetchImpl(tempUrl)
    if (!res.ok) {
      throw new Error(`failed to download from ${tempUrl} (status ${res.status})`)
    }
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const buffer = Buffer.from(await res.arrayBuffer())
    return this.uploadBuffer(path, buffer, contentType)
  }
}
