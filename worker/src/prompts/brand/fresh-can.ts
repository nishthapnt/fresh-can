// THE ONE FILE TO SWAP PER CLIENT. To rebrand this worker for another
// company: copy this file to brand/<new-brand>.ts with that brand's own
// containerDescriptor/moods/referenceImages, then change the one import in
// prompts/index.ts. Nothing else in the worker needs to change.
import type { BrandProfile } from '../types.js'

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

  voiceGuidelines:
    'Warm, hopeful, community-driven — never corporate. Highlight real people, local farmers, and ' +
    'communities; frame technology as serving people, not the other way around. Write in third person only ' +
    '— never "we", "our", or "us"; always "Fresh-CAN", "the app", or "the team". Use Canadian spellings ' +
    '(neighbourhood, colour, organise, prioritise, centre, realise). Never name competitors negatively. ' +
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
  categoryVisualHints: {
    'Food Desert Education':
      'A wide, natural-light documentary photo of a real Canadian residential neighbourhood street, or a ' +
      'sparse, half-empty grocery store aisle — conveying limited access to fresh food. No vehicles, ' +
      'storefronts, or branding of any kind visible.',
    'AI & Mobile Technology':
      "A close-up, natural-light photo of a person's hands holding a smartphone showing a simple, generic " +
      'grocery-shopping app screen — warm and approachable, no real logos or brand names visible on the ' +
      'phone screen or elsewhere.',
    'Community Impact':
      'A warm, candid documentary photo of a small group of neighbours, or a family together outdoors in a ' +
      'Canadian residential neighbourhood — genuine expressions, natural light, no vehicles or branding ' +
      'visible.',
    'Customer Stories':
      'A warm, candid portrait-style photo of a single person or family in a home kitchen or their own ' +
      'neighbourhood — genuine expression, natural light, no vehicles or branding visible.',
    'Fresh Produce & Local Farms':
      'A vibrant, close-up natural-light photo of fresh, colourful local produce — vegetables and fruit — ' +
      'in a wooden crate or at a farm stand, some held in human hands. No packaging, vehicles, or branding ' +
      'of any kind visible.',
  },

  // Verified against real reference photos on 2026-09-10
  // (worker/assets/fresh-can/truck_exterior_back.png) — not invented. It's
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
  containerDescriptor:
    'The Fresh-CAN mobile grocery store: a dark maroon-red steel shipping container mounted on the back of ' +
    'a white box truck (white cab, dark maroon-red cargo box). The truck cab itself is completely ' +
    'unbranded — plain white, no decals, no stickers, no logos, no text anywhere on the cab; all branding ' +
    'appears only on the rear cargo container. A steel header bar spans the top of the container\'s rear ' +
    'face with a white "Fresh [maple leaf icon] CAN" wordmark. The rear entrance is a black-frame glass ' +
    'double door set flush into the back of the container at bumper height, with no external staircase. ' +
    'Keep this exact structure, color, and logo placement identical every time it appears in an image — ' +
    'this is a fixed brand element, not a creative choice.',

  // Verified against real reference photos on 2026-09-10
  // (worker/assets/fresh-can/freshcan_interior_1.png, _2.png).
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

  noTextInstruction:
    'Photorealistic, natural lighting, documentary style. Absolutely no text, no words, no letters, ' +
    'no captions, no titles, no logos, no watermarks, no typography anywhere in the image — pure photography only.',

  noNewTextInstruction:
    'Photorealistic, natural lighting, documentary style. Preserve the Fresh-CAN truck\'s real signage and ' +
    'logo exactly as shown in the reference photo — do not invent, add, or alter any text, captions, or ' +
    'typography beyond what is already visible on the vehicle in that photo.',

  // Confirmed live (2026-09-10) with nano-banana-2: a plain "the Fresh-CAN
  // logo" reference produced a plausible-looking but wrong cursive
  // wordmark. This exact phrasing matches containerDescriptor's own
  // wordmark description (bold sans-serif, maple leaf between the words).
  // Updated 2026-09-11 against the real FreshCAN Brand Guidelines doc: this
  // is the "negative logo" variant (solid white, for placement over a
  // photo/color background, as opposed to the red-on-white primary logo)
  // per that doc, in the guide's actual typeface (Manrope) and with its
  // explicit usage restrictions (no stretching, no recoloring, no rotation,
  // no added effects, never on a busy/low-contrast area) folded in directly
  // — these aren't just nice-to-haves, they're the same category of failure
  // as the cursive-wordmark bug above (the model inventing a plausible but
  // off-brand rendering) and are cheap to rule out explicitly.
  logoDescriptor:
    'In the top-right corner, the FreshCAN wordmark in its negative (reversed) form: "Fresh [maple leaf icon] ' +
    'CAN" rendered entirely in solid, flat white with no other colors, gradient, outline, or drop shadow — in ' +
    'Manrope or a very similar bold, clean, modern geometric sans-serif typeface (never cursive, never ' +
    'script, never a serif font). "Fresh" and "CAN" are the exact same bold weight and size, with a simple ' +
    'solid white maple leaf icon between the two words. The wordmark is never stretched, distorted, or ' +
    'rotated, and sits over a plain, uncluttered area of the image so it stays clearly legible — never over a ' +
    'busy or low-contrast part of the photo.',

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

  // Uploaded to the public brand-assets Supabase bucket on 2026-09-10 from
  // worker/assets/fresh-can/. One is picked per image (hero/inline/photo
  // pick independently) — each `framing` string must accurately describe
  // what that specific photo shows, since Flux Kontext edits from it.
  // TODO before M3 can run against the real ElevenLabs API: fill these in
  // from elevenlabs.io's Voice Library (or a cloned voice) — left empty
  // rather than guessed, per BrandProfile.videoVoiceIds's doc comment.
  videoVoiceIds: {
    EN: '',
    FR: '',
  },

  referenceImages: {
    exterior: [
      {
        url: 'https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/brand-assets/truck_exterior_back.png',
        framing:
          'Camera positioned directly behind the truck, straight-on, facing the rear entrance doors and ' +
          'header wordmark dead-on.',
      },
      {
        url: 'https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/brand-assets/truck_exterior_arrival.png',
        framing:
          'Camera positioned ahead and to the side of the truck, a three-quarter front view as the truck ' +
          'arrives and parks at the curb, driver visible through the windshield.',
      },
      {
        url: 'https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/brand-assets/truck_exterior_standing.png',
        framing:
          'Camera positioned directly to the side of the container, a full profile view along its length, ' +
          'close enough to fill the frame with the side wall and logo.',
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
