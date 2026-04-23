import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createPaymentSigner } from "../../src/payment-signer.js";
import type { WalletConfig } from "../../src/types.js";
import { server } from "../setup.js";

const wallet: WalletConfig = {
  subOrgId: "so_test",
  walletAddress: "0x0000000000000000000000000000000000000003",
  hmacSecret: "aa".repeat(32),
};

const RESOURCE_URL =
  "https://app.keeperhub.com/api/mcp/workflows/demo/call";
// 132 chars total: 0x + 130 hex.
const SIG_HEX = `0x${"a".repeat(130)}`;

describe("paymentSigner.pay() -- PAY-01 x402-only on Base USDC", () => {
  it("retries with PAYMENT-SIGNATURE header and returns 200", async () => {
    let capturedSigHeader: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        async ({ request }) => {
          const body = (await request.json()) as {
            chain: string;
            workflowSlug?: string;
          };
          expect(body.chain).toBe("base");
          // v0.1.5: workflowSlug forwarded so the server can verify
          // payTo + amount against the workflows registry.
          expect(body.workflowSlug).toBe("demo");
          return HttpResponse.json({ signature: SIG_HEX });
        }
      ),
      http.post(RESOURCE_URL, ({ request }) => {
        capturedSigHeader = request.headers.get("PAYMENT-SIGNATURE");
        return HttpResponse.json({ paid: true });
      })
    );

    const challenge = {
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
        url: RESOURCE_URL,
        description: "demo",
        mimeType: "application/json",
      },
    };
    const b64 = Buffer.from(JSON.stringify(challenge)).toString("base64");
    const response402 = new Response(JSON.stringify(challenge), {
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
    const json = (await paid.json()) as { paid: boolean };
    expect(json.paid).toBe(true);

    // PAYMENT-SIGNATURE header is sent on retry. Full extractPayerAddress
    // round-trip is covered by the server-side Phase 33 /sign integration
    // test in the keeperhub repo (tests/integration/agentic-wallet-sign-route.test.ts).
    expect(capturedSigHeader).toBeTruthy();
    expect(typeof capturedSigHeader).toBe("string");

    // v0.1.7 shape check: PaymentPayload decodes with x402Version=2, accepted
    // mirrors the exact accept entry (for server findMatchingRequirements
    // deepEqual), and EIP-3009 wire fields are stringified per
    // @x402/evm ExactEIP3009Payload.
    const sig = capturedSigHeader as unknown as string;
    type ExactAuth = {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    type DecodedPayload = {
      x402Version: number;
      accepted: { scheme: string; network: string; amount: string; payTo: string };
      payload: { signature: string; authorization: ExactAuth };
    };
    const decoded = JSON.parse(
      Buffer.from(sig, "base64").toString("utf-8")
    ) as DecodedPayload;
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.scheme).toBe("exact");
    expect(decoded.accepted.network).toBe("eip155:8453");
    expect(decoded.accepted.amount).toBe("1000000");
    expect(decoded.accepted.payTo).toBe(
      "0x0000000000000000000000000000000000000099"
    );
    expect(typeof decoded.payload.authorization.validAfter).toBe("string");
    expect(typeof decoded.payload.authorization.validBefore).toBe("string");
    expect(decoded.payload.authorization.value).toBe("1000000");
  });
});
