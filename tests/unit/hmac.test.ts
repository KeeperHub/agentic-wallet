import { describe, expect, it } from "vitest";
import { buildHmacHeaders, computeSignature } from "../../src/hmac.js";

const SIG_HEX_64 = /^[0-9a-f]{64}$/;

// Golden signature produced by the server-side canonical signing string
// in keeperhub/keeperhub @ lib/agentic-wallet/hmac.ts (computeSignature).
// Signing string: `${method}\n${path}\n${subOrgId}\n${sha256_hex(body)}\n${timestamp}`
// Inputs below MUST produce this exact byte sequence so the client mirror is
// proven byte-identical to the server verifier across repo boundaries.
const GOLDEN = {
  secret: "supersecret",
  method: "POST",
  path: "/api/agentic-wallet/sign",
  subOrgId: "so_abc",
  body: '{"x":1}',
  timestamp: "1714652400",
  expected:
    "58c422b3e6eb341000e4892b2dc80dff4d226abfc352f8f41f381af637394781",
};

describe("hmac.ts (client mirror)", () => {
  it("computeSignature returns a 64-char lowercase hex string", () => {
    const sig = computeSignature(
      "supersecret",
      "POST",
      "/api/agentic-wallet/sign",
      "so_abc",
      '{"x":1}',
      "1714652400"
    );
    expect(sig).toMatch(SIG_HEX_64);
  });

  it("client signature matches the server golden fixture byte-for-byte", () => {
    const client = computeSignature(
      GOLDEN.secret,
      GOLDEN.method,
      GOLDEN.path,
      GOLDEN.subOrgId,
      GOLDEN.body,
      GOLDEN.timestamp
    );
    expect(client).toBe(GOLDEN.expected);
  });

  it("buildHmacHeaders emits the three X-KH-* headers with 64-hex signature", () => {
    const h = buildHmacHeaders(
      "supersecret",
      "POST",
      "/api/agentic-wallet/sign",
      "so_abc",
      "{}"
    );
    expect(h["X-KH-Sub-Org"]).toBe("so_abc");
    expect(Number.parseInt(h["X-KH-Timestamp"], 10)).toBeGreaterThan(
      1_700_000_000
    );
    expect(h["X-KH-Signature"]).toMatch(SIG_HEX_64);
  });
});
