import { createHash, createHmac } from "node:crypto";
import type { HmacHeaders } from "./types.js";

/**
 * Mirror of lib/agentic-wallet/hmac.ts::computeSignature.
 * Format (byte-for-byte identical to server):
 *   `${method}\n${path}\n${subOrgId}\n${sha256_hex(body)}\n${timestamp}`
 * Post-HI-05: subOrgId is a signed field.
 *
 * @security Do NOT log the secret or the returned signature. Any stdout
 *   emitter (the global console object or util.inspect) added to this
 *   file is a T-34-08 violation (grep-enforced).
 */
export function computeSignature(
  secret: string,
  method: string,
  path: string,
  subOrgId: string,
  body: string,
  timestamp: string
): string {
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingString = `${method}\n${path}\n${subOrgId}\n${bodyDigest}\n${timestamp}`;
  return createHmac("sha256", secret).update(signingString).digest("hex");
}

/**
 * Build the three X-KH-* headers that authenticate every request to
 * /api/agentic-wallet/* (except /provision, which uses the session cookie).
 *
 * Timestamp is unix seconds (Math.floor(Date.now() / 1000)); the server
 * enforces a symmetric 300-second replay window.
 */
export function buildHmacHeaders(
  secret: string,
  method: string,
  path: string,
  subOrgId: string,
  body: string
): HmacHeaders {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeSignature(
    secret,
    method,
    path,
    subOrgId,
    body,
    timestamp
  );
  return {
    "X-KH-Sub-Org": subOrgId,
    "X-KH-Timestamp": timestamp,
    "X-KH-Signature": signature,
  };
}
