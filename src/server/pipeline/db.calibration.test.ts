import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getMeasuredWordsPerSecond, isTestJobTopic, speedFromAudioUrl } from './db'

type Row = Record<string, unknown>

/** A chainable Supabase stand-in that returns preset rows per table and records the filters applied. */
function fakeClient(tables: Record<string, Row[]>) {
  const calls: { table: string; op: string; args: unknown[] }[] = []
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      const chain = (op: string) => (...args: unknown[]) => {
        calls.push({ table, op, args })
        return builder
      }
      for (const op of ['select', 'eq', 'not', 'in', 'order', 'limit']) builder[op] = chain(op)
      builder.then = (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: tables[table] ?? [], error: null })
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
const audio = (n: number, ms: number, file = 'scene-1-audio.mp3') => ({
  narration_text: words(n),
  duration_ms: ms,
  file_url: `https://x/${file}`,
})

describe('isTestJobTopic', () => {
  it('flags the e2e fixtures and nothing else', () => {
    expect(isTestJobTopic('E2E VIDEO TEST - DELETE ME')).toBe(true)
    expect(isTestJobTopic('E2E IMAGE TEST - DELETE ME')).toBe(true)
    expect(isTestJobTopic('test')).toBe(false)
    expect(isTestJobTopic('Food availablity for bacholars')).toBe(false)
    expect(isTestJobTopic(null)).toBe(false)
  })
})

describe('speedFromAudioUrl', () => {
  it('reads the speed back out of a fit file name', () => {
    expect(speedFromAudioUrl('https://x/EN/scene-4-audio-fit-80.mp3')).toBe(0.8)
    expect(speedFromAudioUrl('https://x/EN/scene-2-audio-fit-112.mp3')).toBe(1.12)
  })

  it('is 1 for natural-pace audio and for anything unparseable or implausible', () => {
    expect(speedFromAudioUrl('https://x/EN/scene-1-audio.mp3')).toBe(1)
    expect(speedFromAudioUrl('https://x/EN/scene-1-audio-corrected.mp3')).toBe(1)
    expect(speedFromAudioUrl(null)).toBe(1)
    expect(speedFromAudioUrl('https://x/scene-1-audio-fit-5.mp3')).toBe(1)
  })
})

describe('getMeasuredWordsPerSecond', () => {
  const base = (rows: Row[]) =>
    fakeClient({
      content_jobs: [{ id: 'j1', topic: 'real job' }, { id: 'j2', topic: 'E2E VIDEO TEST - DELETE ME' }],
      content_pipelines: [{ id: 'p1' }],
      content_language_tracks: [{ id: 't1' }],
      video_scene_audio: rows,
    })

  it('computes total words / total seconds over the voice\'s real scenes', async () => {
    const { client } = base(Array.from({ length: 6 }, () => audio(25, 10_000))) // 2.5 wps
    expect(await getMeasuredWordsPerSecond(client, 'voice', 'EN')).toBeCloseTo(2.5, 5)
  })

  it('asks the database to exclude test jobs, so fixtures cannot fill the sample window', async () => {
    const { client, calls } = base(Array.from({ length: 6 }, () => audio(25, 10_000)))
    await getMeasuredWordsPerSecond(client, 'voice', 'EN')
    const notCalls = calls.filter((c) => c.table === 'content_jobs' && c.op === 'not').map((c) => String(c.args[2]))
    expect(notCalls).toEqual(expect.arrayContaining(['%DELETE ME%', '%E2E%']))
  })

  it('converts audio spoken at a non-natural speed back to natural pace', async () => {
    // 25 words in 12.5s at speed 0.8 = 10s natural -> 2.5 wps, not 2.0.
    const { client } = base(Array.from({ length: 6 }, () => audio(25, 12_500, 'scene-1-audio-fit-80.mp3')))
    expect(await getMeasuredWordsPerSecond(client, 'voice', 'EN')).toBeCloseTo(2.5, 5)
  })

  it('returns null (so the caller uses the default) with too little history', async () => {
    const { client } = base(Array.from({ length: 5 }, () => audio(25, 10_000)))
    expect(await getMeasuredWordsPerSecond(client, 'voice', 'EN')).toBeNull()
  })

  it('returns null when every recent job is a test job', async () => {
    const { client } = fakeClient({ content_jobs: [{ id: 'j2', topic: 'E2E VIDEO TEST - DELETE ME' }] })
    expect(await getMeasuredWordsPerSecond(client, 'voice', 'EN')).toBeNull()
  })

  it('never throws: a failing query yields null', async () => {
    const broken = { from: () => { throw new Error('db down') } } as unknown as SupabaseClient
    expect(await getMeasuredWordsPerSecond(broken, 'voice', 'EN')).toBeNull()
  })
})
