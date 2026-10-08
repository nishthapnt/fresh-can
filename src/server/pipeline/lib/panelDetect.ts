import sharp from 'sharp'

// Detects an image that is really several photos stacked vertically (a
// "collage") instead of one continuous frame. Real job 65b08e09's scene 1
// still came back as three stacked landscape shots of the same barbecue, and
// the clip animated it, so the first ~6s (19%) of the finished video was a
// three-panel collage; an Oct 5 job (8b682bc9, scene 5) did the same. The
// vision QA gate never flagged either, and a collage cannot be fixed by an
// image edit, so this is a deterministic, free, local check (no extra API
// call) that lets the caller regenerate from scratch.
//
// How: downsample to grayscale, take the mean absolute difference between
// every pair of adjacent rows, and look near 1/3 and 2/3 of the height for a
// row boundary that is far sharper than its surroundings (a seam spans the
// whole width; natural edges like a horizon rarely do). A collage has BOTH
// seams, so the image's score is the weaker of the two.
//
// Calibrated 2026-10-08 on 42 real scene stills: the two known collages
// scored 4.5 and 4.5; every other still scored 1.9 or less (median 1.25).
// 3.0 sits in that gap with room on both sides.
export const STACKED_PANEL_THRESHOLD = 3.0

const ANALYSIS_WIDTH = 96
// Seams are searched within +/-4% of the height around 1/3 and 2/3.
const SEAM_SEARCH_FRACTION = 0.04
// Rows within +/-6 of the candidate (excluding the 2 nearest) are its context.
const CONTEXT_ROWS = 6
// Added to the context mean so a flat, textureless region (diff ~0) cannot
// turn a tiny difference into a huge ratio.
const CONTEXT_FLOOR = 1.5

/** The weaker of the two 1/3 and 2/3 seam sharpness ratios (1.0 = no seam). */
export async function stackedPanelScore(image: Buffer): Promise<number> {
  const height = Math.round((ANALYSIS_WIDTH * 16) / 9)
  const { data, info } = await sharp(image)
    .greyscale()
    .resize({ width: ANALYSIS_WIDTH, height, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height

  const rowDiff: number[] = []
  for (let y = 0; y < h - 1; y++) {
    let sum = 0
    for (let x = 0; x < w; x++) sum += Math.abs(data[y * w + x] - data[(y + 1) * w + x])
    rowDiff.push(sum / w)
  }

  const seamScore = (fraction: number): number => {
    const centre = Math.round(fraction * h)
    const reach = Math.round(h * SEAM_SEARCH_FRACTION)
    let best = 0
    for (let y = centre - reach; y <= centre + reach; y++) {
      if (y < CONTEXT_ROWS || y > h - CONTEXT_ROWS - 2) continue
      const context: number[] = []
      for (let k = -CONTEXT_ROWS; k <= CONTEXT_ROWS; k++) {
        if (Math.abs(k) >= 2 && y + k >= 0 && y + k < rowDiff.length) context.push(rowDiff[y + k])
      }
      const contextMean = context.reduce((a, b) => a + b, 0) / context.length
      best = Math.max(best, (rowDiff[y] + 0.001) / (contextMean + CONTEXT_FLOOR))
    }
    return best
  }

  return Math.min(seamScore(1 / 3), seamScore(2 / 3))
}

export async function isStackedPanelCollage(image: Buffer): Promise<boolean> {
  return (await stackedPanelScore(image)) >= STACKED_PANEL_THRESHOLD
}

/** Fetches `url` and checks it. Fails OPEN (false) on any error — this is a
 *  quality gate on an already-paid-for image, never a new way to fail a scene. */
export async function isStackedPanelCollageUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return false
    return await isStackedPanelCollage(Buffer.from(await res.arrayBuffer()))
  } catch {
    return false
  }
}
