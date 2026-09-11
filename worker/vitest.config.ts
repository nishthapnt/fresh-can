import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Live integration/e2e tests do many real Supabase round trips per test
    // (the busiest does ~20+) with real, variable network latency — 5s was
    // too tight, and even 20s flaked under latency variance across runs.
    // Pure-logic tests finish in milliseconds regardless, so this costs
    // them nothing.
    testTimeout: 45_000,
  },
})
