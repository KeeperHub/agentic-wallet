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

const RESOURCE_URL = "https://app.keeperhub.com/api/mcp/workflows/demo/call";
const SIG_HEX = `0x${"a".repeat(130)}`;
const ORIGINAL_BODY = JSON.stringify({ address: "0xdead" });

describe("signer.fetch() -- forwards body + headers on 402 retry (BUG-3)", () => {
  it("x402 path: retry carries the original body and content-type", async () => {
    let retryBody: string | null = null;
    let retryContentType: string | null = null;
    let retrySigHeader: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        () => HttpResponse.json({ signature: SIG_HEX })
      ),
      http.post(RESOURCE_URL, async ({ request }) => {
        retryBody = await request.text();
        retryContentType = request.headers.get("content-type");
        retrySigHeader = request.headers.get("PAYMENT-SIGNATURE");
        if (!retrySigHeader) {
          // First call (the 402 attempt) is served by the msw handler below
          // via default 402 response. We only reach this handler on retry.
          return new HttpResponse(null, { status: 500 });
        }
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

    // Prime the 402 response for the first fetch.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const hasSig = Boolean(
        init?.headers && new Headers(init.headers).get("PAYMENT-SIGNATURE")
      );
      if (url === RESOURCE_URL && !hasSig) {
        return new Response(JSON.stringify(challenge), {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": b64,
            "content-type": "application/json",
          },
        });
      }
      return globalThis.fetch(input, init);
    };

    const signer = createPaymentSigner({
      walletLoader: async () => wallet,
      fetchImpl,
    });
    const paid = await signer.fetch(RESOURCE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ORIGINAL_BODY,
    });

    expect(paid.status).toBe(200);
    const json = (await paid.json()) as { paid: boolean };
    expect(json.paid).toBe(true);

    expect(retryBody).toBe(ORIGINAL_BODY);
    expect(retryContentType).toBe("application/json");
    expect(retrySigHeader).toBeTruthy();
  });

  it("pay(response, {body}) still works for advanced callers", async () => {
    let retryBody: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        () => HttpResponse.json({ signature: SIG_HEX })
      ),
      http.post(RESOURCE_URL, async ({ request }) => {
        retryBody = await request.text();
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
    const paid = await signer.pay(response402, {
      body: ORIGINAL_BODY,
      headers: { "content-type": "application/json" },
    });

    expect(paid.status).toBe(200);
    expect(retryBody).toBe(ORIGINAL_BODY);
  });

  it("non-402 first response short-circuits fetch()", async () => {
    server.use(
      http.post(RESOURCE_URL, () => HttpResponse.json({ ok: true }))
    );
    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    const resp = await signer.fetch(RESOURCE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ORIGINAL_BODY,
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });
});
