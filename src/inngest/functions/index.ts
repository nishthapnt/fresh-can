import { blogGenerate, blogTrackProcess } from './blog'
import { imageGenerate, imageTrackProcess } from './image'
import { socialPublish } from './social'
import { videoGenerate, videoApprove, videoTrackRender } from './video'

export const functions = [
  blogGenerate,
  blogTrackProcess,
  imageGenerate,
  imageTrackProcess,
  socialPublish,
  videoGenerate,
  videoApprove,
  videoTrackRender,
]
