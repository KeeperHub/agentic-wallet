import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createPaymentSigner } from "../../src/payment-signer.js";
import type { WalletConfig } from "../../src/types.js";
import { server } from "../setup.js";

const wallet: WalletConfig = {
  subOrgId: "so_test_mpp",
  walletAddress: "0x0000000000000000000000000000000000000004",
  hmacSecret: "bb".repeat(32),
};

const RESOURCE_URL = "https://app.keeperhub.com/api/mcp/demo/mpp-call";
const MPP_SIG = "mpp-credential-base64-payload";

describe("paymentSigner.pay() -- PAY-02 MPP-only on Tempo USDC.e", () => {
  it("retries with Authorization: Payment header and returns 200", async () => {
    let capturedAuthHeader: string | null = null;
    let signChainCalled = "";

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        async ({ request }) => {
          const body = (await request.json()) as {
            chain: string;
            paymentChallenge: { kind: string };
          };
          signChainCalled = body.chain;
          expect(body.paymentChallenge.kind).toBe("mpp");
          return HttpResponse.json({ signature: MPP_SIG });
        }
      ),
      http.post(RESOURCE_URL, ({ request }) => {
        capturedAuthHeader = request.headers.get("Authorization");
        return HttpResponse.json({ paid: true, via: "mpp" });
      })
    );

    const response402 = new Response(null, {
      status: 402,
      headers: {
        "WWW-Authenticate": "Payment serialized-mpp-challenge-abc123",
      },
    });
    Object.defineProperty(response402, "url", { value: RESOURCE_URL });

    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    const paid = await signer.pay(response402);

    expect(paid.status).toBe(200);
    expect(signChainCalled).toBe("tempo");
    expect(capturedAuthHeader).toBe(`Payment ${MPP_SIG}`);
  });
});
