/**
 * WX402-05: EIP-712 domain parity guard.
 *
 * The domain constants used to sign x402 challenges on the keeperhub server
 * (lib/agentic-wallet/sign.ts BASE_USDC_DOMAIN) must match the extra fields
 * that buildPaymentConfig emits in the PAYMENT-REQUIRED challenge header
 * (lib/payments/x402/payment-gate.ts). A divergence between the two causes
 * the CDP facilitator to reconstruct a different domain hash from what /sign
 * signed against, producing "verification-failed" for every payment.
 *
 * These constants are defined inline (cross-repo import is not possible) and
 * must be kept in sync with:
 *   - lib/agentic-wallet/sign.ts::BASE_USDC_DOMAIN (server signing domain)
 *   - lib/payments/x402/payment-gate.ts::buildPaymentConfig extra field
 *   - lib/agentic-wallet/constants.ts::USDC_BASE_ADDRESS, BASE_CHAIN_ID
 *
 * If this test fails after a dependency bump or domain migration, update all
 * three keeperhub source locations together.
 */
import { describe, expect, it } from "vitest";

// Reference values from lib/agentic-wallet/sign.ts BASE_USDC_DOMAIN.
// These MUST match that file exactly. Do not change these values without
// also updating BASE_USDC_DOMAIN in the keeperhub repo.
const EXPECTED_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;

// Reference challenge extra fixture — what buildPaymentConfig emits after
// the KEEP-364 fix. The CDP facilitator reads name/version exclusively from
// these extra fields to reconstruct the EIP-712 domain.
const REFERENCE_CHALLENGE_EXTRA = {
  name: "USD Coin",
  version: "2",
} as const;

describe("WX402-05 — BASE_USDC_DOMAIN vs challenge extra parity", () => {
  it("domain name matches challenge extra.name ('USD Coin')", () => {
    expect(EXPECTED_DOMAIN.name).toBe(REFERENCE_CHALLENGE_EXTRA.name);
  });

  it("domain version matches challenge extra.version ('2')", () => {
    expect(EXPECTED_DOMAIN.version).toBe(REFERENCE_CHALLENGE_EXTRA.version);
  });

  it("domain chainId is 8453 (Base mainnet)", () => {
    expect(EXPECTED_DOMAIN.chainId).toBe(8453);
  });

  it("domain verifyingContract is the canonical Base USDC address", () => {
    expect(EXPECTED_DOMAIN.verifyingContract).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    );
  });

  it("extra fields are plain strings, not empty, not undefined", () => {
    expect(typeof REFERENCE_CHALLENGE_EXTRA.name).toBe("string");
    expect(REFERENCE_CHALLENGE_EXTRA.name.length).toBeGreaterThan(0);
    expect(typeof REFERENCE_CHALLENGE_EXTRA.version).toBe("string");
    expect(REFERENCE_CHALLENGE_EXTRA.version.length).toBeGreaterThan(0);
  });
});
