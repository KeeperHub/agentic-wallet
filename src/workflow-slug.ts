// Server-derived payTo binding (Phase 37 fix #2 in keeperhub repo).
//
// The wallet only signs payments for KeeperHub-registered workflows. The
// resource URL of the 402 challenge is matched against the canonical
// /api/mcp/workflows/<slug>/call pattern; the slug is forwarded to /sign so
// the server can verify payTo + amount against the workflows registry.
//
// URLs that don't match this pattern (e.g. arbitrary x402 services discovered
// in the wild) are unsupported in v0.1.5 — the signer throws
// UNSUPPORTED_RECIPIENT and refuses to round-trip. KEEP-311's generic 402
// fetch CLI is a separate codepath with its own threat model.

const KEEPERHUB_WORKFLOW_RE =
  /\/api\/mcp\/workflows\/([a-zA-Z0-9_-]+)\/call(?:\/?)(?:\?|$|#)/;

export type SlugExtractionResult =
  | { ok: true; slug: string }
  | { ok: false; reason: "EMPTY_URL" | "URL_PATTERN_MISMATCH" };

export function extractKeeperHubWorkflowSlug(
  url: string | null | undefined
): SlugExtractionResult {
  if (!url || url.length === 0) {
    return { ok: false, reason: "EMPTY_URL" };
  }
  const match = KEEPERHUB_WORKFLOW_RE.exec(url);
  if (!match || !match[1]) {
    return { ok: false, reason: "URL_PATTERN_MISMATCH" };
  }
  return { ok: true, slug: match[1] };
}
