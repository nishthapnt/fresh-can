// The single switch point for re-branding this worker — see
// brand/fresh-can.ts's header comment.
export { BRAND_PROFILE } from './brand/fresh-can'
export type { BrandProfile, ImageMood, BrandReferenceImage, ImageStyle, SceneVisualState } from './types'
export {
  composeHeroPrompt,
  composeInlinePrompt,
  composePhotoPrompt,
  composeCharacterRefPrompt,
  composeSceneImagePrompt,
  composeSceneVideoPrompt,
  type ImageComposition,
} from './core/compose'
export {
  composeOutlineSystemPrompt,
  composeCopySystemPrompt,
  composeCaptionSystemPrompt,
  composeAdCopySystemPrompt,
  composeVideoScriptSystemPrompt,
  composeLocalizeScriptSystemPrompt,
  type CopySystemPromptOptions,
  type CaptionSystemPromptOptions,
  type AdCopySystemPromptOptions,
  type VideoScriptSystemPromptOptions,
  type LocalizeScriptSystemPromptOptions,
} from './core/composeText'
