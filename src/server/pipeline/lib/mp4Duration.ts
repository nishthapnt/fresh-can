// Reads an MP4/MOV container's real duration straight from its `moov/mvhd`
// box metadata (ISO/IEC 14496-12) — no ffmpeg/ffprobe binary involved. This
// app has none: every other ffmpeg operation in this codebase runs remotely
// via upload-post.com (avMerger.ts's own header), and adding a local ffprobe
// dependency just to read one integer would be a bigger change than the one
// asked for. Used ONLY by renderLanguageTrack.ts to decide how avMerger.ts's
// buildSceneDurationMatchCommand should close a small visual-duration gap
// (subtle zoom vs its existing fallback) — never to gate, retry, or
// regenerate KIE/Seedance visuals themselves, and never touched by anything
// upstream of that one render-time decision.
//
// Walks top-level boxes looking for `moov`, then that box's own children
// looking for `mvhd`, exactly like any standard MP4 parser — works
// regardless of whether `moov` sits before or after `mdat` in the file,
// since the whole buffer is scanned. Returns null (never throws) for
// anything that doesn't parse as a standard box structure, so a probe
// failure always degrades to the existing, already-safe fallback rather
// than blocking or corrupting a render.

interface BoxRange {
  start: number
  end: number
}

function findBox(buffer: Buffer, start: number, end: number, type: string): BoxRange | null {
  let offset = start
  while (offset + 8 <= end) {
    const size = buffer.readUInt32BE(offset)
    const boxType = buffer.toString('ascii', offset + 4, offset + 8)
    let boxSize = size
    let headerSize = 8
    if (size === 1) {
      // 64-bit "largesize" form — real size lives in the next 8 bytes.
      if (offset + 16 > end) return null
      boxSize = Number(buffer.readBigUInt64BE(offset + 8))
      headerSize = 16
    } else if (size === 0) {
      // Box extends to the end of its parent (or the file, at top level).
      boxSize = end - offset
    }
    if (boxSize < headerSize || offset + boxSize > end) return null
    if (boxType === type) {
      return { start: offset + headerSize, end: offset + boxSize }
    }
    offset += boxSize
  }
  return null
}

export function parseMp4DurationSeconds(buffer: Buffer): number | null {
  try {
    const moov = findBox(buffer, 0, buffer.length, 'moov')
    if (!moov) return null
    const mvhd = findBox(buffer, moov.start, moov.end, 'mvhd')
    if (!mvhd) return null

    // mvhd payload: version(1)+flags(3), then creation/modification/
    // timescale/duration — each 4 bytes (version 0) or 8 bytes (version 1,
    // except timescale, which stays 4 bytes either way).
    const version = buffer.readUInt8(mvhd.start)
    let timescale: number
    let duration: number
    if (version === 1) {
      if (mvhd.end - mvhd.start < 32) return null
      timescale = buffer.readUInt32BE(mvhd.start + 20)
      duration = Number(buffer.readBigUInt64BE(mvhd.start + 24))
    } else {
      if (mvhd.end - mvhd.start < 20) return null
      timescale = buffer.readUInt32BE(mvhd.start + 12)
      duration = buffer.readUInt32BE(mvhd.start + 16)
    }
    if (!timescale || !Number.isFinite(duration) || duration <= 0) return null
    return duration / timescale
  } catch {
    return null
  }
}
