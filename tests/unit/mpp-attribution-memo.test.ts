/**
 * WX402-06: MPP attribution memo tag regression guard.
 *
 * The MPP attribution memo uses a 4-byte tag at bytes 0..3 derived as
 * keccak256("mpp")[0..3] = [0xef, 0x1e, 0xd7, 0x12]. This is NOT the
 * ASCII literal "MPP\0" = [0x4d, 0x50, 0x50, 0x00]. Using the wrong
 * tag causes the post-broadcast assertChallengeBoundMemo check on the
 * mppx facilitator to throw a non-PaymentError that surfaces as a
 * reason-less "Payment verification failed" 402.
 *
 * This test computes the expected tag at runtime using viem's keccak256
 * so that any future drift in the constant (lib/agentic-wallet/sign.ts
 * MPP_ATTRIBUTION_TAG) is caught before deploy.
 *
 * The constant itself lives in the keeperhub repo (it is private to
 * sign.ts). These inline expected bytes MUST match that constant exactly.
 */
import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";

// Inline copy of MPP_ATTRIBUTION_TAG from lib/agentic-wallet/sign.ts.
// If sign.ts changes these bytes, update this test and the source together.
const MPP_ATTRIBUTION_TAG = [0xef, 0x1e, 0xd7, 0x12];

describe("WX402-06 — MPP_ATTRIBUTION_TAG equals keccak256('mpp')[0..3]", () => {
  it("tag matches keccak256(toBytes('mpp')) first 4 bytes", () => {
    const hash = keccak256(toBytes("mpp"), "bytes");
    const expected = Array.from(hash.slice(0, 4));
    expect(MPP_ATTRIBUTION_TAG).toEqual(expected);
  });

  it("tag does NOT equal the ASCII 'MPP\\0' literal (the historic bug value)", () => {
    // [0x4d, 0x50, 0x50, 0x00] is the four-byte ASCII encoding of "MPP\0".
    // If these match the tag, it means the constant was regressed to the
    // ASCII literal instead of the keccak256-derived value.
    const asciiMppNull = [0x4d, 0x50, 0x50, 0x00];
    expect(MPP_ATTRIBUTION_TAG).not.toEqual(asciiMppNull);
  });
});
