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

const RESOURCE_URL = "https://app.keeperhub.com/api/mcp/demo/call";
// 132 chars total: 0x + 130 hex.
const SIG_HEX = `0x${"a".repeat(130)}`;

describe("paymentSigner.pay() -- PAY-01 x402-only on Base USDC", () => {
  it("retries with PAYMENT-SIGNATURE header and returns 200", async () => {
    let capturedSigHeader: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        async ({ request }) => {
          const body = (await request.json()) as { chain: string };
          expect(body.chain).toBe("base");
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
  });
});
