// THE ONE FILE TO SWAP PER CLIENT. To rebrand this worker for another
// company: copy this file to brand/<new-brand>.ts with that brand's own
// containerDescriptor/moods/referenceImages, then change the one import in
// prompts/index.ts. Nothing else in the worker needs to change.
import type { BrandProfile } from '../types'

// Pulled out of the object literal below (containerDescriptor's own value,
// verbatim) so BACKGROUND_TRUCK_CLAUSE can splice in the real, full
// structure rather than a shorthand "maroon-red + wordmark" summary. That
// shorthand was the actual gap that let a background truck come out as some
// other vehicle shape wearing the wordmark — this constant is what
// containerDescriptor below is assigned from, so the two can never drift
// apart the way earlier hand-copied summaries did.
// Tightened 2026-09-19 to explicitly cover the SIDE panels, which the
// original wording left undefined (it only ever described the cab and the
// rear face). That gap is what let a generation invent a side door: with
// nothing telling the model what the side actually looks like, it filled
// the ambiguity itself. Now explicit and simple, matching what the brand
// actually wants: each side shows the logo, nothing else, ever.
//
// Extended same day: a later generation hallucinated a door on the
// container's FRONT face (the wall nearest the cab) instead of a side —
// the same class of gap, just on the one remaining face this descriptor
// never named directly. The old "NEVER... on either side... the rear
// double door is the vehicle's ONLY entrance and ONLY opening" wording is
// logically absolute (it implies nowhere else, including the front, has
// an opening), but the side-door bug already proved an implied "nowhere
// else" isn't reliable enough — the model needs every real face named
// explicitly, not left to infer from a global negative. Now the front
// gets the same explicit, named treatment the sides already got.
//
// Trimmed twice, 2026-09-19 (same rules and every enumerated specific
// kept — only connecting prose cut) after a real generation hit
// KieImageGenerator's own prompt-length cap ("The prompt word cannot
// exceed 3000 characters", confirmed live). A first trim (1708 -> 1491
// chars) wasn't enough — composeSceneImagePrompt's total FIXED overhead
// (before any scene content) was still ~2796, and real (short!) scenes
// from a live job were already landing at ~3006-3007, over the limit
// with almost no scene content to blame. This second pass gets
// containerDescriptor itself down to ~1180. Kept the critical
// NEVER-render sentence and the ONLY-entrance sentence 100% verbatim
// (compose.test.ts asserts on both), and kept every enumerated specific
// (the side's full no-graphics/decals/stripes/URLs/vents list, the
// front's no-door/window/vent/wordmark list) — cut two lower-value
// sentences instead (the standalone "wordmark is the vehicle's only
// text" restatement, redundant with the side/front rules already saying
// so; and shortened the closing "logo can't appear elsewhere" sentence's
// object list).
//
// Extended again 2026-09-19: a real generation still rendered an open
// service hatch on the side, in a scene where a family approaches to shop
// — the existing "never a door/hatch/window/vent on either side" wording
// apparently read as ruling out a delivery-style door, not the specific
// "customer service window" framing the model reached for instead. Named
// that exact failure mode directly (customers are served ONLY through the
// rear double door, never a side window/hatch) rather than trusting the
// existing generic wording to cover it by implication a second time.
//
// Rewritten again 2026-09-19 after direct user feedback ("make sure the
// correct fresh-can logo is used and the logo is not used at random
// places — only on the side of the truck") plus re-inspecting the real
// reference photos (assets/fresh-can/*.png) closely for the first time
// against that exact claim. They contradict the OLD wording here in real,
// verified ways: truck_exterior_back.png's rear header bar carries a
// small second wordmark AND a whole separate "Scan to Shop Fresh"
// QR-code/feature-list panel next to the door; truck_exterior_arrival.png
// shows a large wordmark on the FRONT face too; every exterior photo's
// visible side also carries "fresh-can.com" URL text and a decorative red
// graphic wave alongside the real wordmark. None of that was ever
// described here, so nothing told the model to disregard it — this is the
// actual source of the "duplicate garbled decal" character-ref defect
// fixed earlier the same day (see composeCharacterRefPrompt's own
// comment): the model was trying to faithfully reproduce real, genuine
// (but undocumented) extra branding from whichever reference photo it
// used. Rather than keep chasing each one individually, the wordmark's
// legitimate location is now simplified to exactly ONE place — the side
// panels, once each — with the front and rear both now explicitly plain.
// Real photos disagree (the physical truck's actual wrap does carry it in
// 2-3 places), but a single, simple, consistently-enforceable rule is what
// actually stops the drift a generated image can show, and referenceImages.
// exterior's own framing strings (below) now explicitly call out and
// disregard every one of those other real elements, whichever photo is
// used as the edit source.
const CONTAINER_DESCRIPTOR =
  'The Fresh-CAN mobile grocery store: a white box truck with a dark maroon-red steel cargo container ' +
  'mounted on back — always this exact maroon-red. The cab is plain white, unbranded; all branding is on ' +
  'the container only. The white "Fresh [maple leaf icon] CAN" wordmark, never distorted, appears ONLY on ' +
  'the two side panels, centered, once per side, and nowhere else on the vehicle. No other text, ' +
  'graphics, decals, stripes, URLs, or vents anywhere on the container. The front face (where it meets ' +
  'the cab) and the rear face are both plain maroon-red with no wordmark, signage, or QR code — the ' +
  'rear\'s only feature is its entrance, a black-frame glass double door, flush at bumper height, with no ' +
  'external staircase. NEVER render a door, hatch, customer service window, vent, or any other opening ' +
  "or fixture on the front face or either side of the container, under any circumstance — the rear " +
  "double door above is the vehicle's ONLY entrance and ONLY opening, on any face, always, and the only " +
  'place customers are ever served. Keep this structure, color, and single side-panel wordmark identical ' +
  'every time. The side panels are the only place the Fresh-CAN logo may appear — never on another ' +
  'vehicle, sign, storefront, or object, unless the scene explicitly calls for one elsewhere.'

// Added 2026-09-18 after a real bad generation: a categoryVisualHints entry
// telling the model the truck "may appear in the background" with only a
// color+wordmark summary — combined with textLayerFor's noTextInstruction
// ("no logos anywhere") in the same prompt whenever no reference photo is
// attached — is a direct contradiction that left the model free to invent
// some other vehicle shape and put the wordmark on it, or skip the wordmark
// but still browbeat some random car into looking "branded". This clause
// closes both gaps: it pins the truck to its real, full structure (not a
// shorthand) when it does appear, and explicitly rules out the wordmark/logo
// leaking onto any other vehicle in frame. See core/compose.ts's
// composeBlogImage for the matching fix to the noText contradiction itself.
const BACKGROUND_TRUCK_CLAUSE =
  'If the Fresh-CAN truck fits naturally in this scene, it must be built to this exact structure — ' +
  `${CONTAINER_DESCRIPTOR} — never any other vehicle shape, color, or logo, and never as the main subject. ` +
  'Every other vehicle in the scene — any other truck, van, or car — must stay completely unbranded; never ' +
  'place the Fresh-CAN wordmark or logo on it.'

export const BRAND_PROFILE: BrandProfile = {
  name: 'Fresh-CAN',

  // Sourced from Fresh-CAN's own n8n content pipeline prompts (the
  // authoritative brand facts already used for video/blog generation
  // elsewhere in the org) — not invented for this worker.
  missionStatement:
    'Fresh-CAN is a Canadian company that deploys AI-assisted mobile grocery stores — built inside converted ' +
    'shipping containers — directly into food desert communities across Canada, partnering with local farmers ' +
    'to stock affordable, fresh produce. Customers use the free Fresh-CAN app to find the nearest unit, scan ' +
    'in with a QR code, shop cashlessly, and leave without a checkout line.',

  // See BrandProfile.neutralIdentityLine's own doc comment for why this
  // exists separately from missionStatement — deliberately drops the
  // "food desert" mission framing and statistics-adjacent language, kept
  // to just the physical facts (what the unit is, how customers use it)
  // a story might legitimately need for accuracy if it touches the truck
  // or app at all.
  neutralIdentityLine:
    'Fresh-CAN operates a mobile grocery unit — a converted shipping container customers visit and shop in, ' +
    'found and unlocked via the free Fresh-CAN app and a QR code — in communities across Canada.',

  voiceGuidelines:
    'Warm, hopeful, community-driven — never corporate. Highlight real people, local farmers, and ' +
    'communities; frame technology as serving people, not the other way around. Write in third person only ' +
    '— never "we", "our", or "us"; always "Fresh-CAN", "the app", or "the team". Use Canadian spellings ' +
    '(neighbourhood, colour, organise, prioritise, centre, realise). Never name competitors negatively. ' +
    'Never name a specific Canadian city, town, neighbourhood, or province as a setting or example (e.g. ' +
    'Toronto, Vancouver, Ontario) — "Canada" is the only place name to use. ' +
    'Leave the reader feeling hopeful, not lectured.',

  bannedWords: [
    'seamlessly',
    'effortlessly',
    'revolutionize',
    'game-changer',
    'cutting-edge',
    'innovative solution',
    'in today\'s world',
    'imagine a world where',
  ],

  // Real, verified stats — cite verbatim if relevant, never paraphrase into
  // a different number, never force one into an unrelated topic.
  statistics: [
    'roughly one in five Canadians lives in a food desert region',
    'one in eight Canadian households experienced food insecurity as of 2018',
    '54% of First Nations people living on reserve face food insecurity',
    'only about one in four food-insecure households uses a food bank',
  ],

  // Keyed by the exact category strings from src/app/dashboard/new's dropdown.
  categoryBriefs: {
    'Food Desert Education':
      'What food deserts are, Canadian statistics, their impact on families, and how mobile grocery access ' +
      'like Fresh-CAN helps close the gap.',
    'AI & Mobile Technology':
      'How Fresh-CAN uses AI-assisted logistics and its cashierless app to make finding and shopping for ' +
      'groceries effortless for the customer.',
    'Community Impact':
      'Real neighbourhood stories — local farmer partnerships, community events, and how Fresh-CAN supports ' +
      'food-insecure families.',
    'Customer Stories':
      'A narrative story of a specific person or family whose access to fresh food improved because of ' +
      'Fresh-CAN.',
    'Behind the Mobile Unit':
      'How the mobile grocery unit itself works physically — how it is stocked, and how it moves between ' +
      'neighbourhoods.',
    'How FreshCAN Works':
      'A step-by-step walkthrough of the customer journey — download the app, find a unit, scan in, shop, ' +
      'and go.',
    'Fresh Produce & Local Farms':
      'The farm-to-unit supply chain, local farmer partnerships, seasonal produce, and sustainability.',
  },

  // For a blog post whose topic isn't actually about the mobile unit itself
  // (core/scene.ts's isContainerRelevant gate returns false) — no reference
  // photo, pure text-to-image, deliberately generic/non-branded so these
  // scenes vary freely instead of being edited from one of the same handful
  // of real photos every time. Keyed by the exact same strings as
  // categoryBriefs above.
  // Trailing clause on each hint below was tightened 2026-09-17: it used to
  // ban ANY Fresh-CAN branding outright ("no vehicles or branding visible"),
  // which went further than intended — the 2026-09-11 fix (see
  // composeBlogImage's comment) only meant to stop the truck being FORCED
  // into every non-container scene as the main subject. These scenes should
  // still read as Fresh-CAN's own content, not generic stock photography, so
  // the truck/wordmark/app may now appear naturally in the background when
  // it plausibly fits — just never as the forced main subject.
  categoryVisualHints: {
    'Food Desert Education':
      'A wide, natural-light documentary photo of a real Canadian residential neighbourhood street, or a ' +
      'sparse, half-empty grocery store aisle — conveying limited access to fresh food. ' +
      `${BACKGROUND_TRUCK_CLAUSE} This scene is about the food desert itself, not the truck.`,
    'AI & Mobile Technology':
      "A close-up, natural-light photo of a person's hands holding a smartphone. Since this scene is " +
      "specifically about using the app, the real Fresh-CAN app interface and wordmark may be visible on " +
      "the phone screen — warm and approachable, not a generic unbranded app mockup.",
    'Community Impact':
      'A warm, candid documentary photo of a small group of neighbours, or a family together outdoors in a ' +
      'Canadian residential neighbourhood — genuine expressions, natural light. ' +
      `${BACKGROUND_TRUCK_CLAUSE}`,
    'Customer Stories':
      'A warm, candid portrait-style photo of a single person or family in a home kitchen or their own ' +
      'neighbourhood — genuine expression, natural light. ' +
      `${BACKGROUND_TRUCK_CLAUSE}`,
    'Fresh Produce & Local Farms':
      'A vibrant, close-up natural-light photo of fresh, colourful local produce — vegetables and fruit — ' +
      'in a wooden crate or at a farm stand, some held in human hands. ' +
      `${BACKGROUND_TRUCK_CLAUSE} Keep focus on the produce itself.`,
  },

  // Verified against real reference photos on 2026-09-10
  // (assets/fresh-can/truck_exterior_back.png) — not invented. It's
  // a box truck (enclosed cargo body), not a flatbed, and there is no
  // staircase at the rear door; earlier wording had both wrong, carried
  // over unverified from Fresh-CAN's old n8n pipeline description of a
  // different, more elaborate rig.
  // 2026-09-10: a real image_post test showed a small garbled decal
  // invented on the truck cab door (illegible pseudo-text, not a copy of
  // anything in the reference photos) even though the two large container
  // wordmarks rendered correctly — the model filled an unbranded area with
  // plausible-looking-but-invented signage. Added the explicit
  // "completely unbranded cab" rule below since all reference photos show
  // exactly that; the container brief in noNewTextInstruction wasn't
  // specific enough on its own to stop it.
  // Tightened 2026-09-17 (1319 -> 1030 chars in composeCharacterRefPrompt's
  // full output) after flux1-kontext's Market endpoint hard-rejected the
  // original wording as too long (worker/src/adapters/kie.ts's
  // KieSceneImageGenerator) — every constraint below was kept, none
  // dropped, only reworded tighter; see git history for the original
  // phrasing if a future failure suggests something here needs the fuller
  // wording back.
  // Extended same day: explicit "no side doors" (only the single rear
  // entrance is real — nothing in any reference photo shows a side door,
  // but nothing previously ruled one out either), a locked "always this
  // exact maroon-red" color anchor, and "never distorted" on the wordmark
  // — all requested after a review of what the prompt was still leaving
  // ambiguous, not in response to an observed bad generation like the
  // other constraints here.
  containerDescriptor: CONTAINER_DESCRIPTOR,

  // Verified against real reference photos on 2026-09-10
  // (assets/fresh-can/freshcan_interior_1.png, _2.png).
  interiorDescriptor:
    'The interior of the Fresh-CAN mobile grocery store: a narrow aisle inside the shipping container with ' +
    'light grey wood-look laminate flooring and bright overhead fluorescent lighting. Black wire shelving ' +
    'units on one side of the aisle, stocked with bagged snacks and packaged groceries. Black-framed ' +
    'glass-door refrigerated cases on the other side, each topped with a red header sign bearing a white ' +
    '"Fresh [maple leaf icon] CAN" wordmark, stocked with bottled beverages and fresh salad containers ' +
    '(some containers individually labeled with a small "Fresh CAN" sticker). A stainless steel counter ' +
    'and sink near a plain white door at the far end of the aisle. Keep this exact interior layout, ' +
    'fixtures, and branding identical every time it appears in an image — this is a fixed brand element, ' +
    'not a creative choice.',

  // "natural lighting, documentary style" dropped 2026-09-19 — that was
  // mood/style dictation bolted onto what these two fields actually exist
  // for (stopping invented text/logos), competing with both the scene's own
  // requested style and the separate, deferential mood system (moodClause
  // in core/compose.ts). "Photorealistic" stays: that's a format constraint
  // (this pipeline renders photos, never illustrations), not a mood choice.
  //
  // Briefly tightened, then restored, chasing composeSceneImagePrompt's
  // length cap — moot either way for THIS field specifically, since scene
  // images always attach a reference image and use noNewTextInstruction
  // below instead; this one is only ever read by the no-reference-image
  // branch (composeCharacterRefPrompt/blog/photo when no photo is
  // configured yet), which isn't anywhere near KieImageGenerator's real
  // ~3000-char cap. Left at the fuller, explicit enumeration.
  noTextInstruction:
    'Photorealistic. Absolutely no text, no words, no letters, ' +
    'no captions, no titles, no logos, no watermarks, no typography anywhere in the image — pure photography only.',

  // Tightened 2026-09-19 after a real 'photo'-style generation (a split-
  // scene request) came back with invented panel labels and storefront
  // signage — this field's old wording only forbade invented text "on the
  // vehicle," so anything elsewhere in the frame was left unscoped. 'photo'
  // style is defined as strictly no on-image text at all (see ImageStyle's
  // own doc comment); only 'infographic' renders text, through a completely
  // separate function (infographicTextLayer) that textLayerFor routes to
  // instead of this field, so tightening this can't affect infographic
  // jobs. Re-tightened again 2026-09-19 (this field, unlike noTextInstruction
  // above, is on composeSceneImagePrompt's critical path — it's the
  // no-reference-image field that's unused there) after confirming
  // KieImageGenerator has its own real, ~3000-char prompt-length cap (see
  // REFERENCE_IS_GUIDE_NOT_COPY's comment in core/compose.ts). Kept the
  // scoping fix ("on the vehicle or off it") exactly, since that's the
  // actual bug fix this field's history is about.
  noNewTextInstruction:
    'Photorealistic. Keep the truck\'s real signage/logo exactly as shown in the reference photo, unaltered. ' +
    'No other invented text, logo, or typography anywhere, on the vehicle or off it — pure photography only.',

  ctaBarText: 'Visit fresh-can.com',

  // From the real FreshCAN Brand Guidelines doc (2026-09-11): typeface is
  // Manrope; the deep red brand color is FreshCAN Red (hex #C81015); the
  // CTA/header bars in the guide's own applications use the brand's near-
  // black Charcoal (hex #1F1F1F), not a generic "dark" tone.
  typographyDescriptor:
    'Manrope or a very similar clean, modern, geometric sans-serif typeface — bold weight for the headline, ' +
    'semi-bold weight for the subtitle, never cursive, never script, never a serif font.',
  ctaBarColorDescriptor: 'a solid charcoal-black band, similar to hex #1F1F1F',

  // Keyed by the exact option values from src/app/dashboard/new's Content
  // Angle dropdown. Shared verbatim between generate_ad_copy (the shared
  // on-image headline/subtitle for 'infographic'-style image_post jobs) and
  // generate_caption (every image_post caption, regardless of image_style)
  // — the whole point is one brief driving both, not two separately-guessed
  // takes on the same post.
  adAngleBriefs: {
    community_story:
      'A real community moment — a specific person, family, or neighbourhood interaction with the mobile ' +
      'unit, not a generic company statement.',
    behind_scenes:
      'How the mobile unit actually works day-to-day — stocking, the AI-assisted logistics, or a look ' +
      'inside the container itself.',
    fresh_produce:
      'The fresh, local produce itself and its health benefit — where it comes from and why it matters to ' +
      'eat well.',
    stat_fact:
      'Lead with one real, verified food-insecurity statistic from the brand facts above, then connect it ' +
      'to what Fresh-CAN does about it.',
    call_to_action:
      'A direct invitation to act — find the nearest unit, download the app, or visit fresh-can.com today.',
  },

  moods: [
    { key: 'warm_golden', detail: 'Golden hour sunlight, warm amber tones, welcoming and hopeful mood.' },
    { key: 'overcast_neutral', detail: 'Soft overcast daylight, neutral natural color, calm documentary mood.' },
    { key: 'urban_daylight', detail: 'Clear daytime light in an urban setting, crisp and modern mood.' },
  ],

  // Real ElevenLabs voice IDs (male voices only, by request — no female
  // narration voice configured for either language at this time).
  videoVoiceIds: {
    EN: 'epkQ8pqDcY2DxhmFi8xl',
    FR: 'n2pCwUKS6q9Iur03Rten',
  },

  // Uploaded to the public brand-assets Supabase bucket on 2026-09-10 from
  // assets/fresh-can/. One is picked per image (hero/inline/photo
  // pick independently) — each `framing` string must accurately describe
  // what that specific photo shows, since Flux Kontext edits from it.
  //
  // `arrival`/`standing` framing strings tightened 2026-09-19: both used to
  // mix in narrative ("as the truck arrives and parks at the curb") or
  // compositional direction ("close enough to fill the frame") alongside
  // the factual camera-angle description — dictating the NEW image's story/
  // composition rather than just describing the reference photo, which is
  // what compose.ts's describeReferencePhoto() now explicitly scopes these
  // strings as. Also fixed the same day: a three-quarter-angle generation
  // rendered a hallucinated glass side door, most likely because neither
  // framing string said what was actually on that visible side, leaving the
  // model to fill the ambiguity itself despite containerDescriptor's
  // separate, generic "never on the side" rule.
  //
  // Tightened further, same day: containerDescriptor now defines the
  // side panels as logo-only (no graphics, URL text, or vents) — but both
  // of these real reference photos actually DO show a decorative red
  // graphic accent, "fresh-can.com" text, and (standing) two vents on the
  // side, which would otherwise contradict that simplified rule exactly
  // the way the door ambiguity once did. Each framing string below now
  // explicitly calls out those specific real details and tells the model
  // to disregard them in favor of containerDescriptor's logo-only side —
  // rather than leaving the model to notice the mismatch itself.
  //
  // Reordered and rewritten again 2026-09-19, prompted by direct user
  // feedback that the logo must be the correct one and must never appear
  // anywhere but the side — see CONTAINER_DESCRIPTOR's own comment for the
  // full finding. `standing` is now listed FIRST because
  // composeCharacterRefPrompt (core/compose.ts) deliberately always uses
  // referenceImages.exterior[0] — this is the one photo showing the real
  // logo in exactly its correct, simplified location (a full dead-on side
  // profile, one clean wordmark, nothing rear/front competing for
  // attention in the same frame), unlike `back` (which also shows a
  // second, smaller rear wordmark plus a whole QR-code panel in the same
  // shot) or `arrival` (which also shows a large front-face wordmark in
  // the same shot). Every framing string below was re-checked directly
  // against the actual image file (not assumed from memory) and now names
  // every real extra element each specific photo shows, so whichever one
  // a caller ends up using, nothing is left for the model to notice and
  // try to faithfully reproduce on its own.
  referenceImages: {
    exterior: [
      {
        url: 'https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/brand-assets/truck_exterior_standing.png',
        framing:
          'Camera positioned directly to the side of the container, a full profile view along its length, ' +
          'showing the real "Fresh CAN" wordmark in its correct place — reproduce that exact wordmark ' +
          'faithfully, once. This particular photo also shows a decorative red graphic wave, "fresh-can.com" ' +
          'text, and two small dark ventilation grilles elsewhere on the side — none of that is part of the ' +
          'container\'s real, correct design; disregard all three. Otherwise the side is plain maroon-red — ' +
          'no vents, no URL text, no extra graphics, and no door, hatch, or opening of any kind.',
      },
      {
        url: 'https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/brand-assets/truck_exterior_back.png',
        framing:
          'Camera positioned directly behind the truck, straight-on, facing the rear entrance doors dead-on. ' +
          'This particular photo also shows a small second wordmark on the header bar above the door and a ' +
          '"Scan to Shop Fresh" QR-code panel to the left of the door — neither is part of the container\'s ' +
          'real, correct design; disregard both. Render the rear face plain maroon-red apart from the glass ' +
          'double door itself, exactly as described elsewhere in this prompt — no wordmark, signage, or QR ' +
          'code on the rear.',
      },
      {
        url: 'https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/brand-assets/truck_exterior_arrival.png',
        framing:
          'Camera positioned ahead and to the side of the truck, a three-quarter front view, driver visible ' +
          'through the windshield. This particular photo also shows a large wordmark on the container\'s ' +
          'front face, plus a decorative red graphic accent and small "fresh-can.com" text on the visible ' +
          'side panel — none of that is part of the container\'s real, correct design; disregard all of it. ' +
          'Render the front face plain maroon-red with nothing on it, and the side panel exactly as ' +
          'described elsewhere in this prompt (plain maroon-red with only the wordmark logo, once) — no ' +
          'door, hatch, or opening of any kind.',
      },
    ],
    interior: [
      {
        url: 'https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/brand-assets/freshcan_interior_1.png',
        framing:
          'Camera positioned near the entrance looking straight down the aisle toward the white door at the ' +
          'far end, wire shelving on the left and glass-door refrigerated cases on the right receding into ' +
          'the distance.',
      },
      {
        url: 'https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/brand-assets/freshcan_interior_2.png',
        framing:
          'Camera positioned further down the aisle, close to the refrigerated cases, with the glass-door ' +
          'fridges and their red Fresh CAN header signs filling most of the frame on the left and a ' +
          'stainless sink and counter visible near the white door ahead.',
      },
    ],
  },
}
