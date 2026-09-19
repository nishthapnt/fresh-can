import { readFileSync } from 'fs'
import path from 'path'
import sharp from 'sharp'

// Bundled with the deployed function via next.config.ts's
// outputFileTracingIncludes for the /api/inngest route — without that entry
// Next.js's file tracer has no static import to detect this path from, and
// the file would be missing from the serverless bundle in production even
// though it works locally.
const LOGO_PATH = path.join(process.cwd(), 'assets', 'fresh-can', 'freshcan_logo.png')

let cachedLogo: Buffer | null = null
function loadLogo(): Buffer {
  if (!cachedLogo) cachedLogo = readFileSync(LOGO_PATH)
  return cachedLogo
}

// Percentages of the BASE image's own width, not fixed pixels — KIE's
// output resolution isn't guaranteed constant, and a fixed pixel size would
// look tiny on a large render or oversized on a small one.
const LOGO_WIDTH_FRACTION = 0.16
const MARGIN_FRACTION = 0.035
// The corner vignette's radius and peak darkness — see the function's own
// comment for why this replaced both earlier attempts (plain composite,
// then a flat chip).
const GRADIENT_RADIUS_FRACTION = 0.42
const GRADIENT_PEAK_OPACITY = 0.55

/**
 * Composites the real Fresh-CAN logo into the top-right corner of a
 * generated image_post photo. Replaces the old approach of asking the AI
 * model to draw a corner logo from a text description (brand.logoDescriptor,
 * removed 2026-09-19) — that always risked a plausible-but-wrong rendering;
 * this stamps the actual asset on instead, so it's identical every time.
 *
 * The real logo asset is the brand's white "negative" variant (meant for
 * placement over a photo/color background, per the old logoDescriptor's own
 * notes) — confirmed live (2026-09-19) that a plain composite of it is
 * unreadable whenever the top-right corner happens to land on a bright/light
 * area (e.g. sky), since there's no reference-photo-aware placement here the
 * way the removed AI-drawn instruction had ("never over a busy or
 * low-contrast area"). Two fixes were tried and rejected before this one:
 * a blurred halo behind the logo (too weak — thin sans-serif letterforms
 * have too little "ink" for a blur to build real contrast) and a flat,
 * hard-edged semi-transparent chip (legible, but reads as an obviously
 * pasted-on box rather than part of the image — rejected on review against
 * real ad-style reference images that instead use a soft corner vignette).
 * A radial gradient anchored at the true top-right corner — dark near the
 * corner, fading smoothly to fully transparent well before the image's
 * midpoint — keeps the logo legible on any background with no visible edge
 * anywhere, matching how the reference images actually do it.
 *
 * Always re-encodes to JPEG regardless of the source format, matching the
 * `{jobId}-final.jpg` storage path this feeds (see storage.ts) — previously
 * that path's contentType came from whatever the provider sent, which could
 * mismatch the .jpg extension.
 */
export async function compositeLogoWatermark(imageBuffer: Buffer): Promise<Buffer> {
  const base = sharp(imageBuffer)
  const { width } = await base.metadata()
  if (!width) {
    throw new Error('compositeLogoWatermark: could not read base image width')
  }

  const logoWidth = Math.round(width * LOGO_WIDTH_FRACTION)
  const margin = Math.round(width * MARGIN_FRACTION)
  const resizedLogo = await sharp(loadLogo()).resize({ width: logoWidth }).toBuffer()

  const radius = Math.round(width * GRADIENT_RADIUS_FRACTION)
  // Two stops before the fade-out (rather than one linear ramp) so the
  // darkness stays close to peak through the whole area the logo actually
  // sits in, and only tapers away beyond that — a pure linear ramp from the
  // very corner was measurably too faint by the time it reached the logo's
  // own position.
  const gradientSvg = `<svg width="${radius}" height="${radius}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="g" cx="100%" cy="0%" r="100%">
        <stop offset="0%" stop-color="black" stop-opacity="${GRADIENT_PEAK_OPACITY}"/>
        <stop offset="40%" stop-color="black" stop-opacity="${GRADIENT_PEAK_OPACITY * 0.85}"/>
        <stop offset="100%" stop-color="black" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
  </svg>`
  const gradient = await sharp(Buffer.from(gradientSvg)).png().toBuffer()

  return base
    .composite([
      { input: gradient, top: 0, left: Math.max(width - radius, 0) },
      { input: resizedLogo, top: margin, left: Math.max(width - logoWidth - margin, 0) },
    ])
    .jpeg({ quality: 92 })
    .toBuffer()
}
