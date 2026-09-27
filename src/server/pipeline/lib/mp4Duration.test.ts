import { describe, it, expect } from 'vitest'
import { parseMp4DurationSeconds } from './mp4Duration'

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, 4, 'ascii')
  return Buffer.concat([header, payload])
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const payload = Buffer.alloc(20)
  payload.writeUInt8(0, 0) // version
  payload.writeUInt32BE(0, 4) // creation_time
  payload.writeUInt32BE(0, 8) // modification_time
  payload.writeUInt32BE(timescale, 12)
  payload.writeUInt32BE(duration, 16)
  return box('mvhd', payload)
}

function mvhdV1(timescale: number, duration: bigint): Buffer {
  const payload = Buffer.alloc(32)
  payload.writeUInt8(1, 0) // version
  payload.writeBigUInt64BE(BigInt(0), 4) // creation_time
  payload.writeBigUInt64BE(BigInt(0), 12) // modification_time
  payload.writeUInt32BE(timescale, 20)
  payload.writeBigUInt64BE(duration, 24)
  return box('mvhd', payload)
}

function mp4File(mvhd: Buffer): Buffer {
  const ftyp = box('ftyp', Buffer.alloc(4))
  const moov = box('moov', mvhd)
  return Buffer.concat([ftyp, moov])
}

describe('parseMp4DurationSeconds', () => {
  it('reads duration from a version-0 mvhd box (timescale/duration both 32-bit)', () => {
    const buffer = mp4File(mvhdV0(1000, 6800))
    expect(parseMp4DurationSeconds(buffer)).toBeCloseTo(6.8, 5)
  })

  it('reads duration from a version-1 mvhd box (64-bit duration)', () => {
    const buffer = mp4File(mvhdV1(1000, BigInt(6800)))
    expect(parseMp4DurationSeconds(buffer)).toBeCloseTo(6.8, 5)
  })

  it('finds moov regardless of where it sits relative to other top-level boxes', () => {
    const ftyp = box('ftyp', Buffer.alloc(4))
    const mdat = box('mdat', Buffer.alloc(16)) // moov AFTER mdat, same as some real encoders
    const moov = box('moov', mvhdV0(1000, 7000))
    const buffer = Buffer.concat([ftyp, mdat, moov])
    expect(parseMp4DurationSeconds(buffer)).toBeCloseTo(7.0, 5)
  })

  it('returns null (never throws) for a completely non-MP4 buffer', () => {
    expect(parseMp4DurationSeconds(Buffer.from('not an mp4 file at all'))).toBeNull()
  })

  it('returns null when there is no moov box', () => {
    const buffer = box('ftyp', Buffer.alloc(4))
    expect(parseMp4DurationSeconds(buffer)).toBeNull()
  })

  it('returns null when moov has no mvhd child', () => {
    const buffer = mp4File(box('trak', Buffer.alloc(8)))
    expect(parseMp4DurationSeconds(buffer)).toBeNull()
  })

  it('returns null for a truncated/malformed box rather than throwing', () => {
    const buffer = Buffer.from([0, 0, 0, 200, 109, 111, 111, 118]) // claims size=200 ('moov'), only 8 bytes present
    expect(parseMp4DurationSeconds(buffer)).toBeNull()
  })

  it('returns null for a zero timescale rather than dividing by zero', () => {
    const buffer = mp4File(mvhdV0(0, 6800))
    expect(parseMp4DurationSeconds(buffer)).toBeNull()
  })
})
