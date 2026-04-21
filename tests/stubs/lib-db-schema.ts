// Dev-only stub for @/lib/db/schema. See lib-db.ts for rationale. Never
// bundled into dist/. The agenticWallets re-export is a no-op because the
// package test harness never exercises a query path -- it only imports
// computeSignature from lib/agentic-wallet/hmac.ts for byte-for-byte
// comparison against the client mirror.
export const agenticWallets = {} as Record<string, unknown>;
