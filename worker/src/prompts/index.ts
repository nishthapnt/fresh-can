// The single switch point for re-branding this worker — see
// brand/fresh-can.ts's header comment.
export { BRAND_PROFILE } from './brand/fresh-can.js'
export type { BrandProfile, ImageMood, BrandReferenceImage, ImageStyle } from './types.js'
export { composeHeroPrompt, composeInlinePrompt, composePhotoPrompt, type ImageComposition } from './core/compose.js'
export {
  composeOutlineSystemPrompt,
  composeCopySystemPrompt,
  composeCaptionSystemPrompt,
  composeAdCopySystemPrompt,
  type CopySystemPromptOptions,
  type CaptionSystemPromptOptions,
  type AdCopySystemPromptOptions,
} from './core/composeText.js'
