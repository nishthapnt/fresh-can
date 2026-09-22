// The single switch point for re-branding this worker — see
// brand/fresh-can.ts's header comment.
export { BRAND_PROFILE } from './brand/fresh-can'
export type {
  BrandProfile,
  BrandReferenceImage,
  UnitDescriptor,
  ImageStyle,
  SceneVisualState,
  CreativeBrief,
  VideoScriptStory,
  VideoScriptLook,
  CastBibleEntry,
  VideoLocation,
  ImagePostPlan,
} from './types'
export {
  composeHeroPrompt,
  composeInlinePrompt,
  composePhotoPrompt,
  composeCharacterRefPrompt,
  composeSceneImagePrompt,
  composeSceneVideoPrompt,
  type ImageComposition,
  type UnitPresence,
} from './core/compose'
export {
  composeIntentSystemPrompt,
  composeImagePlanSystemPrompt,
  composeOutlineSystemPrompt,
  composeCopySystemPrompt,
  composeCaptionSystemPrompt,
  composeAdCopySystemPrompt,
  composeVideoScriptSystemPrompt,
  composeLocalizeScriptSystemPrompt,
  type ImagePlanSystemPromptOptions,
  type CopySystemPromptOptions,
  type CaptionSystemPromptOptions,
  type AdCopySystemPromptOptions,
  type VideoScriptSystemPromptOptions,
  type LocalizeScriptSystemPromptOptions,
} from './core/composeText'
