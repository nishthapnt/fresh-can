import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // /api/inngest reads assets/fresh-can/freshcan_logo.png from disk at
  // runtime (src/server/pipeline/lib/watermark.ts) rather than importing
  // it, so Next's file tracer has nothing to auto-detect that dependency
  // from — without this it would be missing from the deployed serverless
  // function bundle even though it works in local dev.
  outputFileTracingIncludes: {
    "/api/inngest": ["./assets/fresh-can/freshcan_logo.png"],
  },
};

export default nextConfig;