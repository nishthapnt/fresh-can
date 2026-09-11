// ─── Enum-style literal types ────────────────────────────────────────────────

export type JobStatus =
  | 'pending'
  | 'draft_ready'
  | 'approved'
  | 'generating'
  | 'ready'
  | 'failed'

export type SocialStatus =
  | 'pending_approval'
  | 'approved'
  | 'posting'
  | 'posted'
  | 'failed'

export type ContentType = 'image_post' | 'video' | 'blog'

export type PlatformType = 'instagram' | 'facebook' | 'twitter' | 'x'

export type Language = 'EN' | 'FR' | 'BOTH'

export type Category =
  | 'Food Desert Education'
  | 'AI & Mobile Technology'
  | 'Community Impact'
  | 'Customer Stories'
  | 'Behind the Mobile Unit'
  | 'How FreshCAN Works'
  | 'Fresh Produce & Local Farms'

export type TargetAudience =
  | 'Food-insecure families'
  | 'Community members'
  | 'Local farmers & partners'
  | 'General public'

// 'photo': strictly no text baked into the image (default, existing
// behavior). 'infographic': headline/subtitle/logo/CTA text rendered onto
// the image via a text-capable model — user-selected, never an automatic
// per-category guess (a prior automatic version of this was tried and
// removed for poor image quality).
export type ImageStyle = 'photo' | 'infographic'

// image_post only. A fixed dropdown, never free text, so the caption — and
// for image_style: 'infographic', the on-image headline/subtitle — draw
// from one of a known set of creative briefs (worker/src/prompts/brand/
// fresh-can.ts adAngleBriefs) instead of two independent, unrelated guesses
// at the same topic. null = "let AI decide".
export type ContentAngle =
  | 'community_story'
  | 'behind_scenes'
  | 'fresh_produce'
  | 'stat_fact'
  | 'call_to_action'

// ─── Database row types ───────────────────────────────────────────────────────

export interface ContentJob {
  id: string
  topic: string
  keywords: string | null
  category: Category
  target_audience: TargetAudience
  language: Language
  content_types: ContentType[]
  image_style: ImageStyle
  content_angle: ContentAngle | null
  status: JobStatus
  created_at: string
  updated_at: string
}

export interface ContentDraft {
  id: string
  job_id: string
  content_type: ContentType
  draft_data: Record<string, unknown>
  is_approved: boolean
  status: JobStatus
  created_at: string
  updated_at: string
}

export interface GeneratedContent {
  id: string
  job_id: string
  content_type: ContentType
  file_url: string | null
  thumbnail_url: string | null
  output_data: Record<string, unknown> | null
  created_at: string
}

export interface SocialPost {
  id: string
  job_id: string
  content_type: ContentType
  caption: string
  hashtags: string[]
  platforms: PlatformType[]
  status: SocialStatus
  created_at: string
  updated_at: string
}

export interface SocialPlatformLog {
  id: string
  social_post_id: string
  platform: PlatformType
  status: SocialStatus
  platform_post_id: string | null
  post_url: string | null
  error_message: string | null
  created_at: string
}

// ─── Form / input types ───────────────────────────────────────────────────────

export interface NewContentFormData {
  topic: string
  keywords: string
  category: Category
  target_audience: TargetAudience
  language: Language
  content_types: ContentType[]
  image_style: ImageStyle
}

// ─── n8n webhook payload types ────────────────────────────────────────────────

export interface N8nWebhookPayload {
  job_id: string
  topic: string
  keywords: string
  category: string
  target_audience: string
  language: Language
  brand: 'Fresh-CAN'
  content_type: ContentType
}

export interface N8nCallbackDraftReady {
  job_id: string
  content_type: ContentType
  event: 'draft_ready'
  data: {
    draft_data: Record<string, unknown>
  }
}

export interface N8nCallbackGenerationComplete {
  job_id: string
  content_type: ContentType
  event: 'generation_complete'
  data: {
    file_url: string
    thumbnail_url?: string
    output_data: Record<string, unknown>
  }
}

export interface N8nCallbackPostComplete {
  job_id: string
  content_type: ContentType
  event: 'post_complete'
  data: {
    platform: PlatformType
    platform_post_id: string
    post_url: string
  }
}

// New format sent by the video-approve n8n workflow on completion
export interface N8nVideoComplete {
  success: true
  status: 'completed'
  job_id: string
  completed_at: string
  video: {
    url: string
    duration_sec: number
    total_scenes: number
    language: string
    script_type: string
  }
  content: {
    topic: string
    category: string
    script_type: string
    language: string
  }
  display: {
    title: string
    subtitle: string
    status_label: string
    video_url: string
  }
}

export type N8nCallback =
  | N8nCallbackDraftReady
  | N8nCallbackGenerationComplete
  | N8nCallbackPostComplete

// ─── Aggregated view types ────────────────────────────────────────────────────

export interface JobWithDrafts extends ContentJob {
  drafts: ContentDraft[]
}

export interface JobWithAll extends ContentJob {
  drafts: ContentDraft[]
  generated_content: GeneratedContent[]
  social_posts: SocialPost[]
}

// ─── Video Library ────────────────────────────────────────────────────────────

export interface VideoLibraryItem {
  id: string
  job_id: string
  video_url: string
  output_data: {
    duration_sec?: number
    total_scenes?: number
    language?: string
    script_type?: string
  } | null
  completed_at: string
  topic: string
  category: string
  language: string
  status: string
}

// ─── Image Library ────────────────────────────────────────────────────────────

export interface ImageLibraryItem {
  id: string
  job_id: string
  image_url: string
  caption: string
  hashtags: string[]
  alt_text: string
  headline_text: string
  subtitle_text: string
  output_data: Record<string, unknown> | null
  completed_at: string
  topic: string
  category: string
  language: string
  status: string
}

// ─── Blog Library ─────────────────────────────────────────────────────────────

export interface BlogLibraryItem {
  id: string
  job_id: string
  file_url: string | null
  output_data: {
    // Legacy plain-text format
    title?: string
    content?: string
    excerpt?: string
    word_count?: number
    tags?: string[]
    // Current blog worker format (worker/src/steps/generateCopy.ts's schema)
    post_title?: string
    post_slug?: string
    post_status?: string
    post_excerpt?: string
    focus_keyword?: string
    hero_image_url?: string
    inline_image_url?: string
    html_final?: string
    post_content?: string
    images?: {
      hero?: { url: string; alt: string; width?: number; height?: number }
      inline?: { url: string; alt: string; width?: number; height?: number }
    }
    seo?: {
      title?: string
      meta_description?: string
      estimated_read_time?: string
      og_title?: string
      og_description?: string
    }
  } | null
  completed_at: string
  topic: string
  category: string
  language: string
  status: string
}

// ─── KPI types ────────────────────────────────────────────────────────────────

export interface KPIData {
  total_jobs: number
  drafts_pending: number
  ready_to_post: number
  posted_today: number
}
