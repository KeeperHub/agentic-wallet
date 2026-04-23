import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createPaymentSigner } from "../../src/payment-signer.js";
import type { WalletConfig } from "../../src/types.js";
import { server } from "../setup.js";

const wallet: WalletConfig = {
  subOrgId: "so_test_dual",
  walletAddress: "0x0000000000000000000000000000000000000005",
  hmacSecret: "cc".repeat(32),
};

const RESOURCE_URL =
  "https://app.keeperhub.com/api/mcp/workflows/dual-demo/call";

describe("paymentSigner.pay() -- dual-challenge prefers x402, single credential", () => {
  it("submits exactly one credential (x402) when both x402 and MPP are offered", async () => {
    const signCalls: Array<{ chain: string; workflowSlug?: string }> = [];
    let retryCount = 0;
    let capturedAuth: string | null = null;
    let capturedPaymentSig: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        async ({ request }) => {
          const body = (await request.json()) as {
            chain: string;
            workflowSlug?: string;
          };
          signCalls.push({ chain: body.chain, workflowSlug: body.workflowSlug });
          return HttpResponse.json({
            signature: `0x${"aa".repeat(65)}`,
          });
        }
      ),
      http.post(RESOURCE_URL, ({ request }) => {
        retryCount += 1;
        capturedAuth = request.headers.get("Authorization");
        capturedPaymentSig = request.headers.get("PAYMENT-SIGNATURE");
        return HttpResponse.json({ paid: true, via: "dual" });
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
        description: "dual",
        mimeType: "application/json",
      },
    };
    const b64 = Buffer.from(JSON.stringify(challenge)).toString("base64");

    const response402 = new Response(JSON.stringify(challenge), {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": b64,
        "WWW-Authenticate": "Payment serialized-dual-mpp-challenge",
        "content-type": "application/json",
      },
    });
    Object.defineProperty(response402, "url", { value: RESOURCE_URL });

    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    const paid = await signer.pay(response402);

    // Core assertion: exactly ONE /sign call, and it is x402 (chain=base).
    // Before this fix the wallet preferred MPP on dual-challenge 402s;
    // MPP-transaction-mode isn't implemented on the server, so prefer-MPP
    // meant every paid workflow failed out of the box.
    expect(signCalls).toHaveLength(1);
    expect(signCalls[0]).toEqual({ chain: "base", workflowSlug: "dual-demo" });
    // No MPP call was made -- no double-charge.
    const tempoCalls = signCalls.filter((c) => c.chain === "tempo");
    expect(tempoCalls).toHaveLength(0);
    // Exactly one retry of the resource URL, with PAYMENT-SIGNATURE (x402),
    // no Authorization header (MPP).
    expect(retryCount).toBe(1);
    expect(capturedPaymentSig).toBeTruthy();
    expect(capturedAuth).toBeNull();
    expect(paid.status).toBe(200);
  });

  it("falls back to MPP when the 402 offers only MPP (no x402 challenge)", async () => {
    const signCalls: Array<{ chain: string }> = [];
    let retryCount = 0;
    let capturedAuth: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        async ({ request }) => {
          const body = (await request.json()) as { chain: string };
          signCalls.push({ chain: body.chain });
          return HttpResponse.json({ signature: "mpp-only-credential" });
        }
      ),
      http.post(RESOURCE_URL, ({ request }) => {
        retryCount += 1;
        capturedAuth = request.headers.get("Authorization");
        return HttpResponse.json({ paid: true, via: "mpp-only" });
      })
    );

    // 402 with MPP-only (no PAYMENT-REQUIRED header; only WWW-Authenticate)
    const response402 = new Response("", {
      status: 402,
      headers: {
        "WWW-Authenticate": "Payment serialized-mpp-only-challenge",
      },
    });
    Object.defineProperty(response402, "url", { value: RESOURCE_URL });

    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    const paid = await signer.pay(response402);

    // MPP is still exercised when it's the only available protocol.
    expect(signCalls).toHaveLength(1);
    expect(signCalls[0]).toEqual({ chain: "tempo" });
    expect(retryCount).toBe(1);
    expect(capturedAuth).toBe("Payment mpp-only-credential");
    expect(paid.status).toBe(200);
  });
});
