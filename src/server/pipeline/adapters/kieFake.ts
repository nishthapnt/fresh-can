import type {
  ImageGenerator,
  ImageGenerationInput,
  ImageJobRef,
  ImagePollResult,
  VideoGenerator,
  VideoGenerationInput,
  VideoJobRef,
  VideoPollResult,
} from './types'

/**
 * TEST-ONLY, zero-cost stand-ins for KIE.ai's image/video generation —
 * gated behind KIE_FAKE_MODE (src/server/pipeline/env.ts), never used
 * otherwise. submit() never makes a network call and returns instantly;
 * poll() reports 'ready' on its very first call, so there's no polling
 * window at all for a restart to land in (nothing to resume, nothing to
 * orphan). This exists purely to exercise the pipeline's own logic
 * (parallelization, DB writes, aspect ratio plumbing, retry/resume, the
 * render pipeline downstream of visuals) without spending a single real
 * KIE credit.
 *
 * Originally scoped to video's character_ref/scene_image/scene_video_clip
 * generation only; extended (2026-09-18) to also cover blog/image_post's
 * hero/inline/photo generation (src/inngest/functions/{blog,image}.ts,
 * where NanoBananaImageGenerator is swapped for FakeKieImageGenerator when
 * this flag is set) so a local end-to-end smoke test can exercise the full
 * Inngest event chain for any content type without real KIE spend.
 *
 * The returned URLs are real, already-hosted files from an unrelated,
 * already-completed job (content_pipeline_id 397fec92-..., not a stale
 * test job — a legitimate finished production run) — NOT invented paths.
 * That matters because downstream steps (Supabase upload, upload-post.com's
 * downscale/mux/caption-burn) are real, unfaked HTTP calls that need to
 * fetch an ACTUALLY VALID image/video file to succeed; only the KIE.ai
 * generation call itself is faked here, per the "only fake KIE" scope this
 * was built to.
 */
const FAKE_IMAGE_URL =
  'https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/freshcan-videos/397fec92-5696-44d1-89f2-c1875a68a566/scene-6-image.png'
const FAKE_VIDEO_URL =
  'https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/freshcan-videos/397fec92-5696-44d1-89f2-c1875a68a566/scene-5-clip.mp4'

let fakeTaskCounter = 0

export class FakeKieImageGenerator implements ImageGenerator {
  async submit(input: ImageGenerationInput): Promise<ImageJobRef> {
    const providerRef = `fake-image-${++fakeTaskCounter}`
    console.log(
      `[kieFake] FAKE image submission ${providerRef} (prompt: ${input.prompt.length} chars, aspectRatio=${input.aspectRatio ?? '1:1'}) — no real KIE call made`,
    )
    return { providerRef }
  }

  async poll(jobRef: ImageJobRef): Promise<ImagePollResult> {
    return { status: 'ready', fileUrl: FAKE_IMAGE_URL }
  }
}

export class FakeKieVideoGenerator implements VideoGenerator {
  async submit(input: VideoGenerationInput): Promise<VideoJobRef> {
    const providerRef = `fake-video-${++fakeTaskCounter}`
    console.log(
      `[kieFake] FAKE video submission ${providerRef} (prompt: ${input.prompt.length} chars, duration=${input.durationSeconds}s) — no real KIE call made`,
    )
    return { providerRef }
  }

  async poll(jobRef: VideoJobRef): Promise<VideoPollResult> {
    return { status: 'ready', fileUrl: FAKE_VIDEO_URL }
  }
}
