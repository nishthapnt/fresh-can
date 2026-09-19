import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import sharp from 'sharp'
import { compositeLogoWatermark } from './watermark'

// A flat, uniform-color synthetic image — used only to check placement
// precisely (anywhere the logo actually drew something will differ from
// this color, anywhere it didn't will still match it).
async function makeSolidBase(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer()
}

// A real, photo-like PNG (one of the brand's own reference photos) — closer
// to what KIE.ai actually returns than a synthetic solid color, so this
// exercises the real decode/composite/encode path against real photo data
// rather than a degenerate case that happens to be easy to generate.
function loadRealSamplePhoto(): Buffer {
  return readFileSync(path.join(process.cwd(), 'assets', 'fresh-can', 'truck_exterior_back.png'))
}

describe('compositeLogoWatermark', () => {
  it('preserves the base image dimensions and re-encodes as JPEG', async () => {
    const base = await makeSolidBase(1024, 1024)
    const result = await compositeLogoWatermark(base)
    const meta = await sharp(result).metadata()
    expect(meta.width).toBe(1024)
    expect(meta.height).toBe(1024)
    expect(meta.format).toBe('jpeg')
  })

  it('draws something in the top-right corner and leaves the rest of the image untouched', async () => {
    const base = await makeSolidBase(1000, 1000)
    const result = await compositeLogoWatermark(base)

    // A generous region comfortably containing the logo's resized+placed
    // footprint (16% width + 3.5% margin, per watermark.ts) without pinning
    // the test to those exact numbers — averaged over the region so it
    // isn't sensitive to which exact pixels of the (mostly transparent)
    // logo PNG happen to be opaque.
    const cornerRegion = await sharp(result)
      .extract({ left: 780, top: 20, width: 200, height: 80 })
      .raw()
      .toBuffer()
    let diffSum = 0
    for (let i = 0; i < cornerRegion.length; i += 3) {
      diffSum += Math.abs(cornerRegion[i] - 10) + Math.abs(cornerRegion[i + 1] - 20) + Math.abs(cornerRegion[i + 2] - 30)
    }
    expect(diffSum).toBeGreaterThan(0)

    // Bottom-left corner is far outside the logo's placement — must stay
    // (up to harmless JPEG quantization noise) the original flat background
    // color, not exact equality since re-encoding is lossy.
    const farCorner = await sharp(result)
      .extract({ left: 5, top: 995, width: 1, height: 1 })
      .raw()
      .toBuffer()
    const [r, g, b] = [farCorner[0], farCorner[1], farCorner[2]]
    expect(Math.abs(r - 10)).toBeLessThanOrEqual(4)
    expect(Math.abs(g - 20)).toBeLessThanOrEqual(4)
    expect(Math.abs(b - 30)).toBeLessThanOrEqual(4)
  })

  it('handles a real photo-like PNG (not just a synthetic solid color) without throwing, at its real dimensions', async () => {
    const base = loadRealSamplePhoto()
    const { width: originalWidth, height: originalHeight } = await sharp(base).metadata()

    const result = await compositeLogoWatermark(base)
    const meta = await sharp(result).metadata()

    expect(meta.width).toBe(originalWidth)
    expect(meta.height).toBe(originalHeight)
    expect(meta.format).toBe('jpeg')
    // Sanity: output isn't empty/truncated — a real composited photo at
    // this resolution is always at least a few KB.
    expect(result.byteLength).toBeGreaterThan(1000)
  })

  it('scales the logo proportionally for a small and a large image, never overflowing the frame', async () => {
    for (const size of [200, 4000]) {
      const base = await makeSolidBase(size, size)
      const result = await compositeLogoWatermark(base)
      const meta = await sharp(result).metadata()
      expect(meta.width).toBe(size)
      expect(meta.height).toBe(size)
    }
  })
})
