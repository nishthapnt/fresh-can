// Decides whether a given piece of content should show the brand's physical
// subject (the truck/container) at all, before any image prompt gets built.
// Ported from a real bug fixed in Fresh-CAN's n8n pipeline: a topic purely
// about produce ("Sweet PEI Summer — local strawberries and corn") got
// bolted onto a scene of people at the truck, because nothing checked
// whether the topic's own words were actually about a visit/access moment
// versus just naming food. This is a cheap keyword heuristic, not an LLM
// call — good enough to avoid that specific failure mode without adding a
// new API round trip per image.

const VISIT_OR_FACILITY_KEYWORDS =
  /\b(truck|container|unit|store|shop\w*|scan\w*|qr|checkout|pick\s?up|visit\w*|arriv\w*|enter\w*|door\w*|drive[- ]?up|drive[- ]?thru|delivery|mobile grocery|grocery access)\b/i

const PRODUCE_OR_RECIPE_ONLY_KEYWORDS =
  /\b(strawberr\w*|corn|pumpkin|squash|apple\w*|peach\w*|tomato\w*|lettuce|kale|spinach|carrot\w*|potato\w*|bread|produce|harvest\w*|recipe\w*|ingredient\w*|seasonal|farm(?:s|ers?)?|fruit\w*|vegetable\w*|berry|berries|melon\w*|greens)\b/i

/**
 * @param defaultRelevant what to assume when the text gives no signal
 *   either way — true for image_post's photo (which is inherently about
 *   grocery access), false for blog hero/inline (generic article imagery
 *   unless the topic says otherwise).
 */
export function isContainerRelevant(text: string, defaultRelevant: boolean): boolean {
  const isProduceOnly = PRODUCE_OR_RECIPE_ONLY_KEYWORDS.test(text) && !VISIT_OR_FACILITY_KEYWORDS.test(text)
  if (isProduceOnly) return false
  if (VISIT_OR_FACILITY_KEYWORDS.test(text)) return true
  return defaultRelevant
}
