/**
 * WHINT-06: selectProtocol pure function — 9-case matrix + backward compat.
 *
 * selectProtocol(x402, mpp, hint) decides which payment protocol to execute
 * given the challenges offered in the 402 response and the caller's preference.
 * Keeping it as a pure exported function enables exhaustive unit testing without
 * spinning up msw or mocking fetch.
 *
 * Decision table (10 cases):
 *   hint=x402, x402 offered            → "x402"
 *   hint=x402, x402 absent (mpp only)  → throws X402_NOT_OFFERED
 *   hint=x402, neither offered         → throws X402_NOT_OFFERED
 *   hint=mpp,  mpp offered             → "mpp"
 *   hint=mpp,  mpp absent (x402 only)  → throws MPP_NOT_OFFERED
 *   hint=mpp,  neither offered         → throws MPP_NOT_OFFERED
 *   hint=auto, both offered            → "x402" (x402-first default preserved)
 *   hint=auto, x402 only               → "x402"
 *   hint=auto, mpp only                → "mpp"
 *   hint=auto, neither                 → null (pay() returns 402 unchanged)
 *   hint omitted (undefined)           → same as "auto" (backward compat)
 */
import { describe, expect, it } from "vitest";
import { selectProtocol } from "../../src/payment-signer.js";
import { KeeperHubError } from "../../src/types.js";
import type { X402Challenge } from "../../src/x402-detect.js";
import type { MppChallenge } from "../../src/mpp-detect.js";

const mockX402: X402Challenge = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000000",
      payTo: "0x0000000000000000000000000000000000000099",
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
  resource: {
    url: "https://app.keeperhub.com/api/mcp/workflows/test/call",
    description: "test",
    mimeType: "application/json",
  },
};

const mockMpp: MppChallenge = {
  serialized: "serialized-mpp-challenge-xyz",
};

describe("selectProtocol — 9-case matrix (WHINT-06)", () => {
  // hint = "x402"
  it("hint=x402, x402 offered: returns 'x402'", () => {
    expect(selectProtocol(mockX402, null, "x402")).toBe("x402");
  });

  it("hint=x402, only MPP offered: throws KeeperHubError X402_NOT_OFFERED", () => {
    expect(() => selectProtocol(null, mockMpp, "x402")).toThrow(
      expect.objectContaining({ code: "X402_NOT_OFFERED" })
    );
  });

  it("hint=x402, neither offered: throws KeeperHubError X402_NOT_OFFERED", () => {
    expect(() => selectProtocol(null, null, "x402")).toThrow(
      expect.objectContaining({ code: "X402_NOT_OFFERED" })
    );
  });

  // hint = "mpp"
  it("hint=mpp, MPP offered: returns 'mpp'", () => {
    expect(selectProtocol(null, mockMpp, "mpp")).toBe("mpp");
  });

  it("hint=mpp, only x402 offered: throws KeeperHubError MPP_NOT_OFFERED", () => {
    expect(() => selectProtocol(mockX402, null, "mpp")).toThrow(
      expect.objectContaining({ code: "MPP_NOT_OFFERED" })
    );
  });

  it("hint=mpp, neither offered: throws KeeperHubError MPP_NOT_OFFERED", () => {
    expect(() => selectProtocol(null, null, "mpp")).toThrow(
      expect.objectContaining({ code: "MPP_NOT_OFFERED" })
    );
  });

  // hint = "auto"
  it("hint=auto, both offered: returns 'x402' (x402-first default preserved)", () => {
    expect(selectProtocol(mockX402, mockMpp, "auto")).toBe("x402");
  });

  it("hint=auto, only x402 offered: returns 'x402'", () => {
    expect(selectProtocol(mockX402, null, "auto")).toBe("x402");
  });

  it("hint=auto, only MPP offered: returns 'mpp'", () => {
    expect(selectProtocol(null, mockMpp, "auto")).toBe("mpp");
  });

  it("hint=auto, neither offered: returns null (pay() returns 402 response unchanged)", () => {
    expect(selectProtocol(null, null, "auto")).toBeNull();
  });

  // omitted hint — backward compatibility
  it("hint omitted (undefined), both offered: returns 'x402' (backward compat)", () => {
    expect(selectProtocol(mockX402, mockMpp, undefined)).toBe("x402");
  });

  // Error class assertions
  it("thrown error is instanceof KeeperHubError", () => {
    expect(() => selectProtocol(null, mockMpp, "x402")).toThrow(KeeperHubError);
    expect(() => selectProtocol(mockX402, null, "mpp")).toThrow(KeeperHubError);
  });
});
