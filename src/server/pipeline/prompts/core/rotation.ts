// Deterministic (not random) rotation — the same seed always picks the same
// option. This matters twice over: a retried generation (backoff, worker
// restart) must not land on a different mood than its first attempt, and a
// blog's hero + inline image must land on the SAME mood as each other. Both
// are satisfied by keying the pick off something stable for the lifetime of
// the thing being generated (a pipeline id), never off Math.random().
export function pickDeterministic<T>(seed: string, options: readonly T[]): T {
  if (options.length === 0) {
    throw new Error('pickDeterministic: options must be non-empty')
  }
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return options[hash % options.length]
}
