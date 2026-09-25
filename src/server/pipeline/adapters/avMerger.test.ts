import { describe, it, expect, vi } from 'vitest'
import {
  buildVideoConcatCommand,
  buildVideoConcatCommandCapped,
  buildAudioConcatCommand,
  buildMuxCommand,
  buildMuxCommandCapped,
  buildCaptionAssFile,
  buildCaptionBurnCommand,
  buildCaptionBurnCommandCapped,
  buildScaleCommand,
  buildSceneDurationMatchCommand,
  normalizeCaptionCues,
  UploadPostAVMerger,
} from './avMerger'
import { ProviderCallError } from './types'

const THREE_SCENES = [
  { clipUrl: 'https://example.com/s1.mp4', audioUrl: 'https://example.com/a1.mp3' },
  { clipUrl: 'https://example.com/s2.mp4', audioUrl: 'https://example.com/a2.mp3' },
  { clipUrl: 'https://example.com/s3.mp4', audioUrl: 'https://example.com/a3.mp3' },
]

describe('buildVideoConcatCommand', () => {
  it('throws when there are no scenes', () => {
    expect(() => buildVideoConcatCommand([])).toThrow()
  })

  it('takes only the clip URLs, in order, as files', () => {
    const { files } = buildVideoConcatCommand(THREE_SCENES)
    expect(files).toEqual(['https://example.com/s1.mp4', 'https://example.com/s2.mp4', 'https://example.com/s3.mp4'])
  })

  it('builds a video-only concat filter (a=0) sized to the scene count', () => {
    const { fullCommand, outputExtension } = buildVideoConcatCommand(THREE_SCENES)
    expect(fullCommand).toContain('-i {input0} -i {input1} -i {input2}')
    expect(fullCommand).toContain('[0:v][1:v][2:v]concat=n=3:v=1:a=0[vout]')
    expect(fullCommand).toContain('-map "[vout]"')
    expect(outputExtension).toBe('mp4')
  })

  it('never contains a semicolon (upload-post.com rejects any ";")', () => {
    const { fullCommand } = buildVideoConcatCommand(THREE_SCENES)
    expect(fullCommand).not.toContain(';')
  })

  it('uses quality-first CRF, not a fixed bitrate cap — this pass\'s own output is size-guarded by renderLanguageTrack.ts (escalating to buildVideoConcatCommandCapped if oversized) rather than throttled unconditionally on every render', () => {
    const { fullCommand } = buildVideoConcatCommand(THREE_SCENES)
    expect(fullCommand).toContain('-crf 23')
    expect(fullCommand).not.toContain('-b:v')
    expect(fullCommand).not.toContain('-maxrate')
    expect(fullCommand).not.toContain('-bufsize')
  })

  it('accepts a crf override', () => {
    const { fullCommand } = buildVideoConcatCommand(THREE_SCENES, 30)
    expect(fullCommand).toContain('-crf 30')
  })
})

describe('buildVideoConcatCommandCapped', () => {
  it('throws when there are no scenes', () => {
    expect(() => buildVideoConcatCommandCapped([])).toThrow()
  })

  it('builds the same video-only concat filter as buildVideoConcatCommand', () => {
    const { files, fullCommand, outputExtension } = buildVideoConcatCommandCapped(THREE_SCENES)
    expect(files).toEqual(['https://example.com/s1.mp4', 'https://example.com/s2.mp4', 'https://example.com/s3.mp4'])
    expect(fullCommand).toContain('-i {input0} -i {input1} -i {input2}')
    expect(fullCommand).toContain('[0:v][1:v][2:v]concat=n=3:v=1:a=0[vout]')
    expect(fullCommand).toContain('-map "[vout]"')
    expect(outputExtension).toBe('mp4')
  })

  it('caps bitrate instead of using CRF — the deterministic, guaranteed-fit fallback for when a quality-tier video-concat attempt exceeds SAFE_UPLOAD_BYTES', () => {
    const { fullCommand } = buildVideoConcatCommandCapped(THREE_SCENES)
    expect(fullCommand).toContain('-b:v 3800k')
    expect(fullCommand).toContain('-maxrate 3800k')
    expect(fullCommand).toContain('-bufsize 7600k')
    expect(fullCommand).not.toContain('-crf')
  })

  it('never contains a semicolon (upload-post.com rejects any ";")', () => {
    const { fullCommand } = buildVideoConcatCommandCapped(THREE_SCENES)
    expect(fullCommand).not.toContain(';')
  })
})

describe('buildAudioConcatCommand', () => {
  it('throws when there are no scenes', () => {
    expect(() => buildAudioConcatCommand([])).toThrow()
  })

  it('takes only the audio URLs, in order, as files', () => {
    const { files } = buildAudioConcatCommand(THREE_SCENES)
    expect(files).toEqual(['https://example.com/a1.mp3', 'https://example.com/a2.mp3', 'https://example.com/a3.mp3'])
  })

  it('builds an audio-only concat filter (v=0) sized to the scene count', () => {
    const { fullCommand, outputExtension } = buildAudioConcatCommand(THREE_SCENES)
    expect(fullCommand).toContain('-i {input0} -i {input1} -i {input2}')
    expect(fullCommand).toContain('[0:a][1:a][2:a]concat=n=3:v=0:a=1[aout]')
    expect(fullCommand).toContain('-map "[aout]"')
    expect(outputExtension).toBe('mp4')
  })

  it('never contains a semicolon (upload-post.com rejects any ";")', () => {
    const { fullCommand } = buildAudioConcatCommand(THREE_SCENES)
    expect(fullCommand).not.toContain(';')
  })
})

describe('buildMuxCommand', () => {
  it('takes the video and audio URLs as its two inputs, re-encoded (fade requires it, unlike the old -c copy remux)', () => {
    const { files, fullCommand, outputExtension } = buildMuxCommand(
      'https://example.com/video.mp4',
      'https://example.com/audio.mp4',
      10,
    )
    expect(files).toEqual(['https://example.com/video.mp4', 'https://example.com/audio.mp4'])
    expect(fullCommand).toContain('-i {input0} -i {input1}')
    expect(fullCommand).toContain('-c:v libx264')
    expect(fullCommand).toContain('-c:a aac')
    expect(fullCommand).toContain('-shortest')
    expect(outputExtension).toBe('mp4')
  })

  it('fades video and audio to black/silence over the last 0.6s of the real total duration — regression for a real render ending abruptly, mid-motion', () => {
    const { fullCommand } = buildMuxCommand('https://example.com/video.mp4', 'https://example.com/audio.mp4', 10)
    expect(fullCommand).toContain('fade=t=out:st=9.40:d=0.60')
    expect(fullCommand).toContain('afade=t=out:st=9.40:d=0.60')
  })

  it('never fades before 0 even for a total duration shorter than the fade window', () => {
    const { fullCommand } = buildMuxCommand('https://example.com/video.mp4', 'https://example.com/audio.mp4', 0.3)
    expect(fullCommand).toContain('st=0.00')
  })

  it('never contains a semicolon or filter_complex (single -vf/-af each, no filtergraph)', () => {
    const { fullCommand } = buildMuxCommand('https://example.com/video.mp4', 'https://example.com/audio.mp4', 10)
    expect(fullCommand).not.toContain(';')
    expect(fullCommand).not.toContain('-filter_complex')
  })

  it('defaults to CRF 23, quality-first, with no bitrate cap — the normal path whenever there are no captions', () => {
    const { fullCommand } = buildMuxCommand('https://example.com/video.mp4', 'https://example.com/audio.mp4', 10)
    expect(fullCommand).toContain('-crf 23')
    expect(fullCommand).not.toContain('-b:v')
    expect(fullCommand).not.toContain('-maxrate')
    expect(fullCommand).not.toContain('-bufsize')
  })

  it('accepts a crf override', () => {
    const { fullCommand } = buildMuxCommand('https://example.com/video.mp4', 'https://example.com/audio.mp4', 10, 30)
    expect(fullCommand).toContain('-crf 30')
  })
})

describe('buildMuxCommandCapped', () => {
  it('takes the same two inputs as buildMuxCommand, with the same fade behavior', () => {
    const { files, fullCommand, outputExtension } = buildMuxCommandCapped(
      'https://example.com/video.mp4',
      'https://example.com/audio.mp4',
      10,
    )
    expect(files).toEqual(['https://example.com/video.mp4', 'https://example.com/audio.mp4'])
    expect(fullCommand).toContain('fade=t=out:st=9.40:d=0.60')
    expect(fullCommand).toContain('afade=t=out:st=9.40:d=0.60')
    expect(outputExtension).toBe('mp4')
  })

  it('caps bitrate instead of using CRF — the deterministic, guaranteed-fit fallback for when a quality-tier mux attempt exceeds SAFE_UPLOAD_BYTES', () => {
    const { fullCommand } = buildMuxCommandCapped('https://example.com/video.mp4', 'https://example.com/audio.mp4', 10)
    expect(fullCommand).toContain('-b:v 3800k')
    expect(fullCommand).toContain('-maxrate 3800k')
    expect(fullCommand).toContain('-bufsize 7600k')
    expect(fullCommand).not.toContain('-crf')
  })

  it('never contains a semicolon or filter_complex', () => {
    const { fullCommand } = buildMuxCommandCapped('https://example.com/video.mp4', 'https://example.com/audio.mp4', 10)
    expect(fullCommand).not.toContain(';')
    expect(fullCommand).not.toContain('-filter_complex')
  })
})

describe('buildCaptionAssFile', () => {
  it('returns null when there are no caption cues', () => {
    expect(buildCaptionAssFile({ not: 'an array' })).toBeNull()
    expect(buildCaptionAssFile(undefined)).toBeNull()
  })

  it('emits Dialogue events for caption cues, chunked into lines, in timeline order', () => {
    const words = [
      { text: 'hello', start: 0, end: 400 },
      { text: 'world', start: 400, end: 800 },
      { text: 'this', start: 1000, end: 1200 },
      { text: 'is', start: 1200, end: 1300 },
      { text: 'fresh-can', start: 1300, end: 1800 },
      { text: 'foods', start: 1800, end: 2100 },
      { text: 'today', start: 2100, end: 2400 },
      { text: 'and', start: 2400, end: 2500 },
    ]
    const ass = buildCaptionAssFile(words)
    // Width-aware chunking (2026-09-19) on the default 9:16 frame wraps
    // this into 3 lines, not a flat "7 words per line" split — see the
    // dedicated normalizeCaptionCues describe block for the regression
    // this replaced.
    expect(ass).toContain('hello world this is')
    expect(ass).toContain('fresh-can foods today')
    expect(ass).toMatch(/Dialogue:.*,and\n?$/)
    expect(ass).toContain('[Events]')
  })

  it('never needs escaping for apostrophes/colons — regression for the whole class of drawtext-escaping bugs this rewrite removes (a real caption with an apostrophe used to break the rest of that filter)', () => {
    const words = [{ text: "it's: fresh", start: 0, end: 500 }]
    const ass = buildCaptionAssFile(words)
    expect(ass).toContain("it's: fresh")
  })

  it('strips literal braces (ASS override-tag delimiters) rather than risk a malformed tag', () => {
    const words = [{ text: 'a {weird} word', start: 0, end: 500 }]
    const ass = buildCaptionAssFile(words)
    expect(ass).toContain('a weird word')
    expect(ass).not.toContain('{weird}')
  })

  it('pins PlayResX/PlayResY to the real delivery resolution for the given aspect ratio', () => {
    const words = [{ text: 'hello', start: 0, end: 400 }]
    const ass916 = buildCaptionAssFile(words, '9:16')!
    expect(ass916).toContain('PlayResX: 720')
    expect(ass916).toContain('PlayResY: 1280')
    const ass169 = buildCaptionAssFile(words, '16:9')!
    expect(ass169).toContain('PlayResX: 1280')
    expect(ass169).toContain('PlayResY: 720')
  })

  it('wraps into MORE, shorter lines on the narrower 9:16 frame than on the wider 16:9 frame, for the same words', () => {
    // Regression test for a real generation where a caption ran off both
    // the left and right edges of a 9:16 (1080px-wide) frame — the old
    // fixed "7 words per line" chunking had no idea the frame was that
    // narrow. Long, real words (not short filler like "hello world") are
    // exactly the case that used to overflow.
    const words = [
      { text: 'this', start: 0, end: 200 },
      { text: 'community', start: 200, end: 700 },
      { text: 'partnership', start: 700, end: 1300 },
      { text: 'struggle', start: 1300, end: 1800 },
      { text: 'against', start: 1800, end: 2200 },
      { text: 'food', start: 2200, end: 2400 },
      { text: 'insecurity', start: 2400, end: 3000 },
    ]
    const narrow = buildCaptionAssFile(words, '9:16')!
    const wide = buildCaptionAssFile(words, '16:9')!
    const countDialogues = (ass: string) => ass.split('Dialogue:').length - 1
    expect(countDialogues(narrow)).toBeGreaterThan(countDialogues(wide))
  })

  it('splits a Dialogue event at a scene boundary instead of letting one cue span two scenes', () => {
    const words = [
      { text: 'hello', start: 0, end: 400 },
      { text: 'world', start: 6200, end: 6580 },
    ]
    const withoutBoundary = buildCaptionAssFile(words)!
    expect(withoutBoundary.split('Dialogue:').length - 1).toBe(1)

    const withBoundary = buildCaptionAssFile(words, '9:16', [6000])!
    expect(withBoundary.split('Dialogue:').length - 1).toBe(2)
  })

  it('shrinks fontsize (via an inline {\\fsN} override) only for a single word too long to fit on its own line, never for an ordinary short cue', () => {
    const longWord = 'a'.repeat(60) // long enough to exceed even the widest (16:9) safe line width alone
    const long = buildCaptionAssFile([{ text: longWord, start: 0, end: 1000 }], '9:16')!
    expect(long).toContain(longWord)
    expect(long).toMatch(/\{\\fs\d+\}a+/)

    const short = buildCaptionAssFile([{ text: 'hello', start: 0, end: 400 }], '9:16')!
    expect(short).not.toContain('\\fs')
  })
})

describe('buildCaptionBurnCommand', () => {
  it('takes the merged video and ASS file as two inputs, burns via the subtitles filter, and passes audio through with -c:a copy', () => {
    const { files, fullCommand } = buildCaptionBurnCommand('https://example.com/merged.mp4', 'https://example.com/captions.ass')
    expect(files).toEqual(['https://example.com/merged.mp4', 'https://example.com/captions.ass'])
    expect(fullCommand).toContain('-i {input0}')
    expect(fullCommand).toContain('subtitles={input1}')
    expect(fullCommand).toContain('-c:a copy')
  })

  it('never contains a semicolon or bracket-labeled pads', () => {
    const { fullCommand } = buildCaptionBurnCommand('https://example.com/merged.mp4', 'https://example.com/captions.ass')
    expect(fullCommand).not.toContain(';')
    expect(fullCommand).not.toContain('-filter_complex')
  })

  it('defaults to CRF 23, quality-first, with no bitrate cap — the normal path whenever captions are present', () => {
    const { fullCommand } = buildCaptionBurnCommand('https://example.com/merged.mp4', 'https://example.com/captions.ass')
    expect(fullCommand).toContain('-crf 23')
    expect(fullCommand).not.toContain('-b:v')
    expect(fullCommand).not.toContain('-maxrate')
    expect(fullCommand).not.toContain('-bufsize')
  })

  it('accepts a crf override', () => {
    const { fullCommand } = buildCaptionBurnCommand('https://example.com/merged.mp4', 'https://example.com/captions.ass', 30)
    expect(fullCommand).toContain('-crf 30')
  })
})

describe('buildCaptionBurnCommandCapped', () => {
  it('takes the same two inputs as buildCaptionBurnCommand, burning via the subtitles filter with audio passed through', () => {
    const { files, fullCommand } = buildCaptionBurnCommandCapped(
      'https://example.com/merged.mp4',
      'https://example.com/captions.ass',
    )
    expect(files).toEqual(['https://example.com/merged.mp4', 'https://example.com/captions.ass'])
    expect(fullCommand).toContain('subtitles={input1}')
    expect(fullCommand).toContain('-c:a copy')
  })

  it('caps bitrate instead of using CRF — the deterministic, guaranteed-fit fallback for when a quality-tier caption-burn attempt exceeds SAFE_UPLOAD_BYTES', () => {
    const { fullCommand } = buildCaptionBurnCommandCapped('https://example.com/merged.mp4', 'https://example.com/captions.ass')
    expect(fullCommand).toContain('-b:v 3800k')
    expect(fullCommand).toContain('-maxrate 3800k')
    expect(fullCommand).toContain('-bufsize 7600k')
    expect(fullCommand).not.toContain('-crf')
  })

  it('never contains a semicolon or filter_complex', () => {
    const { fullCommand } = buildCaptionBurnCommandCapped('https://example.com/merged.mp4', 'https://example.com/captions.ass')
    expect(fullCommand).not.toContain(';')
    expect(fullCommand).not.toContain('-filter_complex')
  })
})

describe('normalizeCaptionCues', () => {
  it('falls back to a fixed word-count chunk when no frame width/fontsize is given', () => {
    const words = Array.from({ length: 8 }, (_, i) => ({ text: `w${i}`, start: i * 100, end: i * 100 + 90 }))
    const cues = normalizeCaptionCues(words)
    expect(cues).toHaveLength(2)
    expect(cues[0].text).toBe('w0 w1 w2 w3 w4 w5 w6')
    expect(cues[1].text).toBe('w7')
  })

  it('wraps a line before the estimated rendered width would exceed the safe frame-width budget', () => {
    const words = [
      { text: 'community', start: 0, end: 500 },
      { text: 'partnership', start: 500, end: 1000 },
      { text: 'struggle', start: 1000, end: 1500 },
    ]
    // A tiny frame/fontsize forces a new cue after almost every word —
    // proves the wrap decision is actually driven by the width budget,
    // not just re-deriving the old fixed word count.
    const cues = normalizeCaptionCues(words, 100, 40)
    expect(cues.length).toBeGreaterThan(1)
  })

  it('still returns no cues for malformed/absent timing data', () => {
    expect(normalizeCaptionCues(null, 1080, 63)).toEqual([])
    expect(normalizeCaptionCues({ not: 'an array' }, 1080, 63)).toEqual([])
  })

  it('forces a break at a scene boundary even when the words would otherwise fit on one line together — regression for a caption phrase continuing verbatim across an unrelated scene cut', () => {
    const words = [
      { text: 'hello', start: 0, end: 400 },
      { text: 'world', start: 6200, end: 6580 }, // after the 6000ms boundary
    ]
    // No boundary: both words are short enough to share one cue.
    const withoutBoundary = normalizeCaptionCues(words, 1080, 63)
    expect(withoutBoundary).toHaveLength(1)

    // With a scene boundary at 6000ms, they must split into two cues even
    // though nothing about the width budget forces it.
    const withBoundary = normalizeCaptionCues(words, 1080, 63, [6000])
    expect(withBoundary).toHaveLength(2)
    expect(withBoundary[0].text).toBe('hello')
    expect(withBoundary[1].text).toBe('world')
  })

  it('does not force a break for words on the same side of every boundary', () => {
    const words = [
      { text: 'hello', start: 0, end: 400 },
      { text: 'there', start: 400, end: 800 },
    ]
    const cues = normalizeCaptionCues(words, 1080, 63, [6000, 12000])
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('hello there')
  })

  it('handles multiple boundaries, splitting one word per scene when each is isolated by a cut', () => {
    const words = [
      { text: 'one', start: 0, end: 200 },
      { text: 'two', start: 6100, end: 6300 },
      { text: 'three', start: 12100, end: 12400 },
    ]
    const cues = normalizeCaptionCues(words, 1080, 63, [6000, 12000])
    expect(cues.map((c) => c.text)).toEqual(['one', 'two', 'three'])
  })
})

describe('buildScaleCommand', () => {
  it('takes the clip URL as its sole input', () => {
    const { files, outputExtension } = buildScaleCommand('https://example.com/clip.mp4', 1080, 1920)
    expect(files).toEqual(['https://example.com/clip.mp4'])
    expect(outputExtension).toBe('mp4')
  })

  it('scales to the exact given width/height and drops audio', () => {
    const { fullCommand } = buildScaleCommand('https://example.com/clip.mp4', 1080, 1920)
    expect(fullCommand).toContain('-vf "scale=1080:1920"')
    expect(fullCommand).toContain('-an')
  })

  it('uses the bare {input} placeholder, not {input0} (single-file commands crash on the indexed form)', () => {
    const { fullCommand } = buildScaleCommand('https://example.com/clip.mp4', 1080, 1920)
    expect(fullCommand).toContain('-i {input}')
    expect(fullCommand).not.toContain('{input0}')
  })

  it('sets -crf 23 explicitly — the same quality target libx264 already defaults to, not a reduction', () => {
    const { fullCommand } = buildScaleCommand('https://example.com/clip.mp4', 1080, 1920)
    expect(fullCommand).toContain('-crf 23')
  })

  it('never contains a semicolon', () => {
    const { fullCommand } = buildScaleCommand('https://example.com/clip.mp4', 1080, 1920)
    expect(fullCommand).not.toContain(';')
  })
})

describe('buildSceneDurationMatchCommand', () => {
  it('takes the clip URL as its sole input and drops audio', () => {
    const { files, outputExtension, fullCommand } = buildSceneDurationMatchCommand(
      'https://example.com/clip.mp4',
      8,
    )
    expect(files).toEqual(['https://example.com/clip.mp4'])
    expect(outputExtension).toBe('mp4')
    expect(fullCommand).toContain('-an')
  })

  it('always pads by the FULL target duration and hard-trims to it — regression for a real caption/audio desync caused by assuming the input clip\'s real length instead', () => {
    // Old behavior computed stop_duration as a SHORTFALL against an assumed
    // input length (pickClipDurationSeconds's '5'/'10' bucket) — correct
    // only when that assumption held (true for Kling/Hailuo, NOT true for
    // Seedance 1.5 Pro, confirmed live 2026-09-21). Padding by the full
    // target instead means this function is correct regardless of the real
    // input length, which it no longer takes as a parameter at all: the
    // padded clip is always >= targetDurationSeconds long, and -t always
    // trims it to exactly that — any padding beyond what was actually
    // needed is just a content-free hold on the clip's own last frame.
    const { fullCommand } = buildSceneDurationMatchCommand('https://example.com/clip.mp4', 8)
    expect(fullCommand).toContain('stop_duration=8.00')
    expect(fullCommand).toContain('-t 8.00')
  })

  it('pads by the full target even for a small target — still correct whether the real input clip is longer or shorter than it', () => {
    const { fullCommand } = buildSceneDurationMatchCommand('https://example.com/clip.mp4', 6)
    expect(fullCommand).toContain('stop_duration=6.00')
    expect(fullCommand).toContain('-t 6.00')
  })

  it('uses the bare {input} placeholder, not {input0}', () => {
    const { fullCommand } = buildSceneDurationMatchCommand('https://example.com/clip.mp4', 8)
    expect(fullCommand).toContain('-i {input}')
    expect(fullCommand).not.toContain('{input0}')
  })

  it('never contains a semicolon', () => {
    const { fullCommand } = buildSceneDurationMatchCommand('https://example.com/clip.mp4', 8)
    expect(fullCommand).not.toContain(';')
  })

  it('applies no fade by default — unchanged behavior for a caller that omits transition', () => {
    const { fullCommand } = buildSceneDurationMatchCommand('https://example.com/clip.mp4', 8)
    expect(fullCommand).not.toContain('fade=')
  })

  it('chains a fade-in after tpad, in the same -vf, when fadeInSeconds is given — no new pass, no semicolon', () => {
    const { fullCommand } = buildSceneDurationMatchCommand('https://example.com/clip.mp4', 8, { fadeInSeconds: 0.25 })
    expect(fullCommand).toContain('tpad=stop_mode=clone:stop_duration=8.00,fade=t=in:st=0:d=0.25')
    expect(fullCommand).not.toContain(';')
  })

  it('chains a fade-out timed against the END of the target duration when fadeOutSeconds is given', () => {
    const { fullCommand } = buildSceneDurationMatchCommand('https://example.com/clip.mp4', 8, { fadeOutSeconds: 0.25 })
    expect(fullCommand).toContain('fade=t=out:st=7.75:d=0.25')
    expect(fullCommand).not.toContain(';')
  })

  it('applies both fade-in and fade-out together, comma-chained, when a scene borders two interior joins', () => {
    const { fullCommand } = buildSceneDurationMatchCommand('https://example.com/clip.mp4', 8, {
      fadeInSeconds: 0.25,
      fadeOutSeconds: 0.25,
    })
    expect(fullCommand).toContain('fade=t=in:st=0:d=0.25,fade=t=out:st=7.75:d=0.25')
  })

  it('clamps each fade side to at most a quarter of the target duration — a pathologically short scene never fades through most of its own runtime', () => {
    const { fullCommand } = buildSceneDurationMatchCommand('https://example.com/clip.mp4', 1, {
      fadeInSeconds: 0.9,
      fadeOutSeconds: 0.9,
    })
    expect(fullCommand).toContain('fade=t=in:st=0:d=0.25')
    expect(fullCommand).toContain('fade=t=out:st=0.75:d=0.25')
  })

  it('ignores a negative fade value rather than emitting an invalid filter', () => {
    const { fullCommand } = buildSceneDurationMatchCommand('https://example.com/clip.mp4', 8, { fadeInSeconds: -1 })
    expect(fullCommand).not.toContain('fade=')
  })
})

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string; arrayBufferBody?: Uint8Array }) {
  return vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
    arrayBuffer: async () => (response.arrayBufferBody ?? new Uint8Array([])).buffer,
  })) as unknown as typeof fetch
}

const ONE_SCENE = { scenes: [{ clipUrl: 'https://example.com/s1.mp4', audioUrl: 'https://example.com/a1.mp3' }] }

describe('UploadPostAVMerger', () => {
  it('submitVideoConcat() sends Apikey auth (not Bearer) and the built video-concat command', async () => {
    let capturedHeaders: Record<string, string> = {}
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-1', status: 'PENDING' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitVideoConcat(ONE_SCENE)
    expect(ref.providerRef).toBe('job-1')
    expect(capturedHeaders.Authorization).toBe('Apikey secret-key')
    const body = JSON.parse(capturedBody!)
    expect(body).toMatchObject({ output_extension: 'mp4' })
    expect(body.files).toEqual(['https://example.com/s1.mp4'])
    expect(body.full_command).not.toContain(';')
  })

  it('submitVideoConcatCapped() sends the deterministic bitrate-capped fallback command', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-1vc' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitVideoConcatCapped(ONE_SCENE)
    expect(ref.providerRef).toBe('job-1vc')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/s1.mp4'])
    expect(body.full_command).toContain('-b:v 3800k')
    expect(body.full_command).not.toContain('-crf')
  })

  it('submitAudioConcat() sends the audio-only concat command', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-1a' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitAudioConcat(ONE_SCENE)
    expect(ref.providerRef).toBe('job-1a')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/a1.mp3'])
    expect(body.full_command).not.toContain(';')
  })

  it('submitMux() sends both URLs as files and a semicolon-free remux command', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-1m' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitMux('https://example.com/v.mp4', 'https://example.com/a.mp4', 10)
    expect(ref.providerRef).toBe('job-1m')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/v.mp4', 'https://example.com/a.mp4'])
    expect(body.full_command).not.toContain(';')
    expect(body.full_command).toContain('fade=t=out:st=9.40:d=0.60')
    expect(body.full_command).toContain('-crf 23')
  })

  it('submitMuxCapped() sends the deterministic bitrate-capped fallback command', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-1mc' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitMuxCapped('https://example.com/v.mp4', 'https://example.com/a.mp4', 10)
    expect(ref.providerRef).toBe('job-1mc')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/v.mp4', 'https://example.com/a.mp4'])
    expect(body.full_command).toContain('-b:v 3800k')
    expect(body.full_command).not.toContain('-crf')
  })

  it('submitScale() sends Apikey auth and the built scale command for the given clip/dimensions', async () => {
    let capturedHeaders: Record<string, string> = {}
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-scale' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitScale('https://example.com/clip.mp4', 1080, 1920)
    expect(ref.providerRef).toBe('job-scale')
    expect(capturedHeaders.Authorization).toBe('Apikey secret-key')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/clip.mp4'])
    expect(body.full_command).toContain('scale=1080:1920')
    expect(body.full_command).not.toContain(';')
  })

  it('submitSceneDurationMatch() sends Apikey auth and the built duration-match command for the given clip/target duration', async () => {
    let capturedHeaders: Record<string, string> = {}
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-duration-match' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitSceneDurationMatch('https://example.com/clip.mp4', 8)
    expect(ref.providerRef).toBe('job-duration-match')
    expect(capturedHeaders.Authorization).toBe('Apikey secret-key')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/clip.mp4'])
    expect(body.full_command).toContain('stop_duration=8.00')
    expect(body.full_command).toContain('-t 8.00')
  })

  it('submitSceneDurationMatch() threads the transition option through to the built fade filters', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-transition' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    await merger.submitSceneDurationMatch('https://example.com/clip.mp4', 8, {
      fadeInSeconds: 0.25,
      fadeOutSeconds: 0.25,
    })
    const body = JSON.parse(capturedBody!)
    expect(body.full_command).toContain('fade=t=in:st=0:d=0.25')
    expect(body.full_command).toContain('fade=t=out:st=7.75:d=0.25')
  })

  it('submitVideoConcat() throws ProviderCallError when job_id is missing', async () => {
    const fetchImpl = mockFetch({ jsonBody: {} })
    const merger = new UploadPostAVMerger('key', fetchImpl)
    await expect(merger.submitVideoConcat(ONE_SCENE)).rejects.toThrow(ProviderCallError)
  })

  it('submitCaptionBurn() sends the merged video and ASS file URLs and a semicolon-free command', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-2' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitCaptionBurn('https://example.com/merged.mp4', 'https://example.com/captions.ass')
    expect(ref.providerRef).toBe('job-2')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/merged.mp4', 'https://example.com/captions.ass'])
    expect(body.full_command).not.toContain(';')
    expect(body.full_command).toContain('-crf 23')
  })

  it('submitCaptionBurnCapped() sends the deterministic bitrate-capped fallback command', async () => {
    let capturedBody: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return { ok: true, status: 202, json: async () => ({ job_id: 'job-2c' }), text: async () => '' }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl)
    const ref = await merger.submitCaptionBurnCapped('https://example.com/merged.mp4', 'https://example.com/captions.ass')
    expect(ref.providerRef).toBe('job-2c')
    const body = JSON.parse(capturedBody!)
    expect(body.files).toEqual(['https://example.com/merged.mp4', 'https://example.com/captions.ass'])
    expect(body.full_command).toContain('-b:v 3800k')
    expect(body.full_command).not.toContain('-crf')
  })

  it('poll() returns pending for PENDING/PROCESSING', async () => {
    const merger = new UploadPostAVMerger('key', mockFetch({ jsonBody: { status: 'PROCESSING' } }))
    expect(await merger.poll({ providerRef: 'job-1' })).toEqual({ status: 'pending' })
  })

  it('poll() downloads the finished render with the Apikey header and returns its bytes', async () => {
    const videoBytes = new Uint8Array([1, 2, 3, 4])
    let downloadUrl = ''
    let downloadHeaders: Record<string, string> = {}
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/download')) {
        downloadUrl = url
        downloadHeaders = init?.headers as Record<string, string>
        return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => videoBytes.buffer }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'FINISHED' }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('secret-key', fetchImpl, 'https://api.upload-post.com')
    const result = await merger.poll({ providerRef: 'job-1' })

    expect(downloadUrl).toBe('https://api.upload-post.com/api/uploadposts/ffmpeg/jobs/job-1/download')
    expect(downloadHeaders.Authorization).toBe('Apikey secret-key')
    expect(result.status).toBe('ready')
    expect(result).toMatchObject({ status: 'ready' })
    if (result.status === 'ready') {
      expect(Buffer.from(result.fileBuffer)).toEqual(Buffer.from(videoBytes))
    }
  })

  it('poll() throws ProviderCallError when the download request itself fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/download')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'server error', arrayBuffer: async () => new ArrayBuffer(0) }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'FINISHED' }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('key', fetchImpl)
    await expect(merger.poll({ providerRef: 'job-1' })).rejects.toThrow(ProviderCallError)
  })

  it('poll() returns failed on ERROR', async () => {
    const merger = new UploadPostAVMerger('key', mockFetch({ jsonBody: { status: 'ERROR' } }))
    const result = await merger.poll({ providerRef: 'job-1' })
    expect(result.status).toBe('failed')
  })

  // The real API (confirmed live 2026-09-12, RQ-backed): lowercase
  // queued/started/finished/failed — not the PENDING/PROCESSING/FINISHED/
  // ERROR this adapter used to check for, which meant a real 'finished' or
  // 'failed' silently fell through to "pending" forever.
  it('poll() returns pending for the real lowercase in-flight statuses', async () => {
    const merger = new UploadPostAVMerger('key', mockFetch({ jsonBody: { status: 'started' } }))
    expect(await merger.poll({ providerRef: 'job-1' })).toEqual({ status: 'pending' })
  })

  it('poll() downloads on the real lowercase "finished" status', async () => {
    const videoBytes = new Uint8Array([1, 2, 3, 4])
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/download')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => videoBytes.buffer }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'finished' }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    }) as unknown as typeof fetch
    const merger = new UploadPostAVMerger('key', fetchImpl)
    const result = await merger.poll({ providerRef: 'job-1' })
    expect(result.status).toBe('ready')
  })

  it('poll() surfaces the provider\'s exc_info traceback as the failure detail on the real lowercase "failed" status', async () => {
    const merger = new UploadPostAVMerger(
      'key',
      mockFetch({ jsonBody: { status: 'failed', exc_info: 'ValueError: full_command debe contener {input} y {output}' } }),
    )
    const result = await merger.poll({ providerRef: 'job-1' })
    expect(result).toEqual({
      status: 'failed',
      detail: 'ValueError: full_command debe contener {input} y {output}',
    })
  })

  it('poll() throws ProviderCallError on a non-ok HTTP response from the status check', async () => {
    const merger = new UploadPostAVMerger('key', mockFetch({ ok: false, status: 404, textBody: 'not found' }))
    await expect(merger.poll({ providerRef: 'job-1' })).rejects.toThrow(ProviderCallError)
  })
})
