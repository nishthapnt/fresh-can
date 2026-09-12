import type { AspectRatio } from '@/types/content'

// Maps a video job's stored aspect_ratio to the Tailwind class its preview
// box should use — every video preview across the dashboard/library used to
// be hardcoded `aspect-video` (16:9) regardless of the clip's real shape,
// which looked wrong even before aspect ratio was user-selectable (real
// clips were always square). Centralized here since it's used by more than
// one preview component.
export function videoAspectClass(ratio: AspectRatio): string {
  switch (ratio) {
    case '1:1':
      return 'aspect-square'
    case '16:9':
      return 'aspect-video'
    case '9:16':
    default:
      return 'aspect-[9/16]'
  }
}
