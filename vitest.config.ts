import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['src/server/pipeline/**/*.test.ts', 'src/app/api/settings/**/*.test.ts', 'src/inngest/**/*.test.ts', 'src/lib/**/*.test.ts'],
    // Live integration/e2e tests do many real Supabase round trips per test
    // (the busiest does ~20+) with real, variable network latency — 5s was
    // too tight, and even 20s flaked under latency variance across runs.
    // Pure-logic tests finish in milliseconds regardless, so this costs
    // them nothing. (Moved here from worker/vitest.config.ts along with the
    // test files themselves during the Inngest migration.)
    testTimeout: 45_000,
  },
})
