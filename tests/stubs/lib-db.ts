// Dev-only stub for @/lib/db. Used by vitest resolve.alias to keep the
// package test harness from pulling in Drizzle + postgres.js when the
// client-side HMAC unit test imports the server-side reference. This file
// is NEVER bundled into dist/ -- vitest.config.ts is dev-only.
export const db = {} as Record<string, unknown>;
