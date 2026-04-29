/**
 * WX402-03: EIP-3009 authorization fields in the wire PAYMENT-SIGNATURE payload
 * must all be decimal strings matching /^\d+$/.
 *
 * The @x402/evm facilitator expects validAfter, validBefore, and value to be
 * decimal string representations of uint256 values -- not BigInt literals
 * (which would include an "n" suffix) and not numeric JS values (which parse
 * correctly but fail the facilitator's schema check when they're not strings).
 *
 * This test drives createPaymentSigner with an msw-intercepted 402 response
 * and a stubbed /sign endpoint, then decodes the PAYMENT-SIGNATURE header
 * from the retry request to assert field types and formats.
 */
import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { createPaymentSigner } from "../../src/payment-signer.js";
import type { WalletConfig } from "../../src/types.js";
import { server } from "../setup.js";

const wallet: WalletConfig = {
  subOrgId: "so_test_payload",
  walletAddress: "0x0000000000000000000000000000000000000007",
  hmacSecret: "dd".repeat(32),
};

const RESOURCE_URL =
  "https://app.keeperhub.com/api/mcp/workflows/payload-test/call";

const CHALLENGE_FIXTURE = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact" as const,
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000000",
      payTo: "0x0000000000000000000000000000000000000099",
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
  resource: {
    url: RESOURCE_URL,
    description: "payload-test",
    mimeType: "application/json",
  },
};

type Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

type DecodedPayload = {
  x402Version: number;
  accepted: Record<string, unknown>;
  payload: {
    signature: string;
    authorization: Authorization;
  };
};

describe("PAYMENT-SIGNATURE wire payload — WX402-03 uint256 decimal string assertion", () => {
  it("validAfter, validBefore, and value are all /^\\d+$/ decimal strings (no BigInt suffix, no float)", async () => {
    let capturedPaymentSig: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        () => HttpResponse.json({ signature: `0x${"ab".repeat(65)}` })
      ),
      http.post(RESOURCE_URL, ({ request }) => {
        capturedPaymentSig = request.headers.get("PAYMENT-SIGNATURE");
        return HttpResponse.json({ paid: true });
      })
    );

    const b64 = Buffer.from(JSON.stringify(CHALLENGE_FIXTURE)).toString(
      "base64"
    );
    const response402 = new Response(JSON.stringify(CHALLENGE_FIXTURE), {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": b64,
        "content-type": "application/json",
      },
    });
    Object.defineProperty(response402, "url", { value: RESOURCE_URL });

    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    const paid = await signer.pay(response402);

    expect(paid.status).toBe(200);
    expect(capturedPaymentSig).toBeTruthy();

    const decoded = JSON.parse(
      Buffer.from(capturedPaymentSig as string, "base64").toString("utf-8")
    ) as DecodedPayload;

    const { authorization } = decoded.payload;

    // validAfter must be a decimal-only string (no "n" BigInt suffix, no ".").
    expect(typeof authorization.validAfter).toBe("string");
    expect(/^\d+$/.test(authorization.validAfter)).toBe(true);
    expect(authorization.validAfter).not.toContain("n");

    // validBefore must be a decimal-only string.
    expect(typeof authorization.validBefore).toBe("string");
    expect(/^\d+$/.test(authorization.validBefore)).toBe(true);
    expect(authorization.validBefore).not.toContain("n");

    // value is the raw amount string from the challenge accept entry.
    expect(typeof authorization.value).toBe("string");
    expect(/^\d+$/.test(authorization.value)).toBe(true);
    expect(authorization.value).toBe("1000000");
  });
});
