import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { isStackedPanelCollage, isStackedPanelCollageUrl, stackedPanelScore, STACKED_PANEL_THRESHOLD } from './panelDetect'

const W = 216
const H = 384

/** Deterministic pseudo-noise so the tests never flake. */
function noise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return (x - Math.floor(x) - 0.5) * 12
}

/** Builds a W x H greyscale PNG from a per-pixel brightness function. */
async function image(fn: (x: number, y: number) => number): Promise<Buffer> {
  const raw = Buffer.alloc(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      raw[y * W + x] = Math.max(0, Math.min(255, Math.round(fn(x, y) + noise(y * W + x))))
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer()
}

describe('stacked-panel collage detector', () => {
  it('flags three different shots stacked vertically (the real 65b08e09 scene 1 failure)', async () => {
    const panel = (y: number) => (y < H / 3 ? 60 : y < (2 * H) / 3 ? 150 : 215)
    const collage = await image((x, y) => panel(y) + x * 0.05)
    expect(await stackedPanelScore(collage)).toBeGreaterThan(STACKED_PANEL_THRESHOLD)
    expect(await isStackedPanelCollage(collage)).toBe(true)
  })

  it('does not flag a smooth single photo', async () => {
    const photo = await image((x, y) => 80 + y * 0.25 + Math.sin(x / 17) * 10)
    expect(await stackedPanelScore(photo)).toBeLessThan(STACKED_PANEL_THRESHOLD)
    expect(await isStackedPanelCollage(photo)).toBe(false)
  })

  it('does not flag a single hard horizon (one seam, not two)', async () => {
    const horizon = await image((_x, y) => (y < H / 2 ? 200 : 60))
    expect(await isStackedPanelCollage(horizon)).toBe(false)
  })

  it('does not flag a seam at only one of the two collage positions', async () => {
    const oneSeam = await image((_x, y) => (y < H / 3 ? 60 : 160))
    expect(await isStackedPanelCollage(oneSeam)).toBe(false)
  })

  it('does not flag pure noise', async () => {
    const grain = await image(() => 128)
    expect(await isStackedPanelCollage(grain)).toBe(false)
  })

  it('fails open: an unreachable, non-OK, or undecodable URL is never a collage', async () => {
    const boom = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const notFound = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch
    const junk = (async () => new Response('not an image', { status: 200 })) as unknown as typeof fetch
    expect(await isStackedPanelCollageUrl('https://x/y.png', boom)).toBe(false)
    expect(await isStackedPanelCollageUrl('https://x/y.png', notFound)).toBe(false)
    expect(await isStackedPanelCollageUrl('https://x/y.png', junk)).toBe(false)
  })

  it('detects a collage fetched from a URL', async () => {
    const panel = (y: number) => (y < H / 3 ? 50 : y < (2 * H) / 3 ? 140 : 220)
    const buf = await image((_x, y) => panel(y))
    const ok = (async () => new Response(new Uint8Array(buf), { status: 200 })) as unknown as typeof fetch
    expect(await isStackedPanelCollageUrl('https://x/y.png', ok)).toBe(true)
  })
})
