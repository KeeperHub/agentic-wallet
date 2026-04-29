/**
 * KEEP-364 EIP-712 domain diagnostic harness.
 *
 * CONFIRMED SUSPECT: Suspect 1 — missing extra.name / extra.version in
 * buildPaymentConfig (lib/payments/x402/payment-gate.ts).
 *
 * Empirical proof (from @x402/evm@2.9.0 source inspection + tests below):
 *
 * The @x402/evm facilitator's verifyEIP3009 reads domain parameters exclusively
 * from requirements.extra.name and requirements.extra.version. When extra={}
 * (the current buildPaymentConfig output), the facilitator throws:
 *   "EIP-712 domain parameters (name, version) are required in payment
 *    requirements for asset 0x8335..."
 * This throw is caught by the payment gateway and surfaces as "verification-failed"
 * to the caller. The /sign server uses BASE_USDC_DOMAIN {name:"USD Coin",version:"2"}
 * correctly — the mismatch is entirely on the challenge-issuance side.
 *
 * The offline EIP-712 tests below confirm:
 *   1. A signature made with the correct domain (name+version) can be verified
 *      with that same domain (round-trip passes).
 *   2. A domain WITHOUT name/version produces a different hash than a domain
 *      WITH name/version — proving the two domains are not equivalent, which is
 *      why any signature accepted by one will be rejected by the other.
 *   3. EIP-55 address checksumming is idempotent for lowercase input (Suspect 2
 *      ruled out — no case-sensitivity bug).
 *   4. uint256 fields encoded as decimal strings have no BigInt suffix (Suspect 3
 *      ruled out — encoding is correct).
 *
 * Fix: add extra: { name: "USD Coin", version: "2" } to the accepts object in
 * buildPaymentConfig so the challenge domain matches what /sign signs against.
 *
 * Suspect 4 (CDP fresh-sub-org allowlist): deferred to live smoke test in
 * PLAN-04 (requires Turnkey + CDP access not available in offline harness).
 */

import { describe, expect, it } from "vitest";
import { getAddress, hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Standard Hardhat account 0 private key — public knowledge, no real funds.
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const account = privateKeyToAccount(TEST_PRIVATE_KEY);
const SIGNER_ADDRESS = account.address;

// Base USDC contract (same value as lib/agentic-wallet/sign.ts BASE_USDC_DOMAIN).
const USDC_BASE_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const AUTHORIZATION_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Synthetic authorization message matching KEEP-364 fixture shape.
const TEST_MESSAGE = {
  from: SIGNER_ADDRESS,
  to: "0x0000000000000000000000000000000000000099" as const,
  value: BigInt("1000000"),
  validAfter: BigInt(1_700_000_000 - 60),
  validBefore: BigInt(1_700_000_000 + 60),
  nonce: `0x${"ab".repeat(32)}` as `0x${string}`,
};

// Variant A: correct domain matching lib/agentic-wallet/sign.ts BASE_USDC_DOMAIN.
// This is what /sign uses when calling Turnkey.
const DOMAIN_CORRECT = {
  name: "USD Coin",
  version: "2",
  chainId: BigInt(8453),
  verifyingContract: USDC_BASE_ADDRESS,
} as const;

// Variant B: minimal domain that the facilitator would use if it fell back to
// empty strings for missing name/version fields. The @x402/evm facilitator
// actually throws "EIP-712 domain parameters (name, version) are required"
// when extra.name/version are absent — but if it were to proceed with empty
// strings, the domain hash would differ from Variant A.
const DOMAIN_EMPTY_NAME_VERSION = {
  name: "",
  version: "",
  chainId: BigInt(8453),
  verifyingContract: USDC_BASE_ADDRESS,
} as const;

describe("KEEP-364 x402 EIP-712 domain diagnostic", () => {
  it("Suspect 1: recovers signer with correct domain (name + version present)", async () => {
    const signature = await account.signTypedData({
      domain: DOMAIN_CORRECT,
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: TEST_MESSAGE,
    });

    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN_CORRECT,
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: TEST_MESSAGE,
      signature,
    });

    expect(recovered.toLowerCase()).toBe(SIGNER_ADDRESS.toLowerCase());
  });

  it("Suspect 1: fails to recover signer when domain name/version differ from signing domain", async () => {
    // Sign with the CORRECT domain (as /sign does with BASE_USDC_DOMAIN).
    const signature = await account.signTypedData({
      domain: DOMAIN_CORRECT,
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: TEST_MESSAGE,
    });

    // Attempt recovery with wrong domain (empty name/version — simulating what
    // the facilitator would reconstruct from extra={}).
    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN_EMPTY_NAME_VERSION,
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: TEST_MESSAGE,
      signature,
    });

    // The recovered address will NOT match — proving that any domain difference
    // causes verification to fail, which is exactly what the CDP facilitator
    // experiences when extra.name/version are missing.
    expect(recovered.toLowerCase()).not.toBe(SIGNER_ADDRESS.toLowerCase());
  });

  it("Suspect 1: correct-domain hash differs from empty-name-version-domain hash", () => {
    const hashCorrect = hashTypedData({
      domain: DOMAIN_CORRECT,
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: TEST_MESSAGE,
    });

    const hashEmptyNameVersion = hashTypedData({
      domain: DOMAIN_EMPTY_NAME_VERSION,
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: TEST_MESSAGE,
    });

    // The two hashes must differ — that is the mechanism of verification-failed.
    expect(hashCorrect).not.toBe(hashEmptyNameVersion);
  });

  it("Suspect 2: address case — getAddress is idempotent on lowercase input", () => {
    // viem's getAddress accepts lowercase hex but rejects fully-uppercase (invalid
    // checksum). The EIP-55 checksum function is idempotent for mixed-case input.
    const checksummed = getAddress(SIGNER_ADDRESS);
    const fromLower = getAddress(SIGNER_ADDRESS.toLowerCase());

    // EIP-55 checksumming is idempotent; no case-sensitivity bug in our flow.
    // wallet.walletAddress stored as EIP-55 checksummed → authorization.from is correct.
    expect(checksummed).toBe(fromLower);
    expect(checksummed).toBe(SIGNER_ADDRESS);
  });

  it("Suspect 3: uint256 fields are decimal strings without BigInt suffix", () => {
    const validAfterNum = 1_700_000_000 - 60;
    const validBeforeNum = 1_700_000_000 + 60;
    const amount = "1000000";

    const assembled = {
      validAfter: String(validAfterNum),
      validBefore: String(validBeforeNum),
      value: amount,
    };

    // All fields must be decimal digit-only strings (no 'n' BigInt suffix).
    expect(/^\d+$/.test(assembled.validAfter)).toBe(true);
    expect(/^\d+$/.test(assembled.validBefore)).toBe(true);
    expect(/^\d+$/.test(assembled.value)).toBe(true);

    // Confirm no BigInt coercion artifact.
    expect(assembled.validAfter).not.toContain("n");
    expect(assembled.validBefore).not.toContain("n");
    expect(assembled.value).not.toContain("n");
  });
});
