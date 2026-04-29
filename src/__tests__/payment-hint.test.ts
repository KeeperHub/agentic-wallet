/**
 * WHINT-01..05: End-to-end paymentHint routing through createPaymentSigner.
 *
 * These tests verify that paymentHint threads correctly from signer.fetch()
 * init and signer.pay() options all the way through to protocol dispatch.
 * Uses the same msw + challenge-fixture pattern as the existing integration
 * tests to avoid duplicating the selectProtocol unit tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { createPaymentSigner } from "../payment-signer.js";
import { KeeperHubError } from "../types.js";
import type { WalletConfig } from "../types.js";

// Local msw server — mirrors tests/setup.ts pattern but self-contained so
// this file can live in src/__tests__/ (rootDir: src) without importing from
// the sibling tests/ directory (excluded from tsconfig).
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const wallet: WalletConfig = {
  subOrgId: "so_hint_test",
  walletAddress: "0x0000000000000000000000000000000000000009",
  hmacSecret: "ff".repeat(32),
};

const RESOURCE_URL =
  "https://app.keeperhub.com/api/mcp/workflows/hint-test/call";

const X402_CHALLENGE = {
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
    description: "hint-test",
    mimeType: "application/json",
  },
};

/** 402 response offering both x402 and MPP challenges. */
function makeDual402(): Response {
  const b64 = Buffer.from(JSON.stringify(X402_CHALLENGE)).toString("base64");
  const resp = new Response(JSON.stringify(X402_CHALLENGE), {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": b64,
      "WWW-Authenticate": "Payment serialized-mpp-for-hint-test",
      "content-type": "application/json",
    },
  });
  Object.defineProperty(resp, "url", { value: RESOURCE_URL });
  return resp;
}

/** 402 response offering only x402 (no WWW-Authenticate). */
function makeX402Only402(): Response {
  const b64 = Buffer.from(JSON.stringify(X402_CHALLENGE)).toString("base64");
  const resp = new Response(JSON.stringify(X402_CHALLENGE), {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": b64,
      "content-type": "application/json",
    },
  });
  Object.defineProperty(resp, "url", { value: RESOURCE_URL });
  return resp;
}

/** 402 response offering only MPP (no PAYMENT-REQUIRED header). */
function makeMppOnly402(): Response {
  const resp = new Response(null, {
    status: 402,
    headers: {
      "WWW-Authenticate": "Payment serialized-mpp-only-for-hint-test",
    },
  });
  Object.defineProperty(resp, "url", { value: RESOURCE_URL });
  return resp;
}

describe("paymentHint end-to-end routing (WHINT-01..05)", () => {
  it("WHINT-03: hint omitted (auto), dual challenge: takes x402 path — PAYMENT-SIGNATURE header on retry", async () => {
    let capturedPaymentSig: string | null = null;
    let capturedAuth: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        () => HttpResponse.json({ signature: `0x${"ab".repeat(65)}` })
      ),
      http.post(RESOURCE_URL, ({ request }) => {
        capturedPaymentSig = request.headers.get("PAYMENT-SIGNATURE");
        capturedAuth = request.headers.get("Authorization");
        return HttpResponse.json({ paid: true });
      })
    );

    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    const paid = await signer.pay(makeDual402());

    expect(paid.status).toBe(200);
    // x402 path: PAYMENT-SIGNATURE present, Authorization absent.
    expect(capturedPaymentSig).toBeTruthy();
    expect(capturedAuth).toBeNull();
  });

  it("WHINT-01/02: hint=mpp via pay() options, dual challenge: takes MPP path — Authorization: Payment header on retry", async () => {
    let capturedPaymentSig: string | null = null;
    let capturedAuth: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        () => HttpResponse.json({ signature: "mpp-credential-for-hint-test" })
      ),
      http.post(RESOURCE_URL, ({ request }) => {
        capturedPaymentSig = request.headers.get("PAYMENT-SIGNATURE");
        capturedAuth = request.headers.get("Authorization");
        return HttpResponse.json({ paid: true });
      })
    );

    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    const paid = await signer.pay(makeDual402(), { paymentHint: "mpp" });

    expect(paid.status).toBe(200);
    // MPP path: Authorization: Payment present, PAYMENT-SIGNATURE absent.
    expect(capturedAuth).toBe("Payment mpp-credential-for-hint-test");
    expect(capturedPaymentSig).toBeNull();
  });

  it("WHINT-01: hint=x402 via signer.fetch init, x402-only: uses x402 path", async () => {
    let capturedPaymentSig: string | null = null;

    server.use(
      http.post(RESOURCE_URL, async ({ request }) => {
        if (request.headers.get("PAYMENT-REQUIRED") !== null) {
          // Should not hit here — this is the resource endpoint
        }
        const paymentSig = request.headers.get("PAYMENT-SIGNATURE");
        if (paymentSig) {
          capturedPaymentSig = paymentSig;
          return HttpResponse.json({ paid: true });
        }
        // First call: return 402 with x402 challenge
        const b64 = Buffer.from(JSON.stringify(X402_CHALLENGE)).toString(
          "base64"
        );
        return new HttpResponse(JSON.stringify(X402_CHALLENGE), {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": b64,
            "content-type": "application/json",
          },
        });
      }),
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        () => HttpResponse.json({ signature: `0x${"cd".repeat(65)}` })
      )
    );

    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    const paid = await signer.fetch(RESOURCE_URL, {
      method: "POST",
      paymentHint: "x402",
    });

    expect(paid.status).toBe(200);
    expect(capturedPaymentSig).toBeTruthy();
  });

  it("WHINT-04: hint=x402 via pay(), mpp-only challenge: throws KeeperHubError X402_NOT_OFFERED", async () => {
    const signer = createPaymentSigner({ walletLoader: async () => wallet });

    await expect(
      signer.pay(makeMppOnly402(), { paymentHint: "x402" })
    ).rejects.toMatchObject({ code: "X402_NOT_OFFERED" });
  });

  it("WHINT-05: hint=mpp via pay(), x402-only challenge: throws KeeperHubError MPP_NOT_OFFERED", async () => {
    const signer = createPaymentSigner({ walletLoader: async () => wallet });

    await expect(
      signer.pay(makeX402Only402(), { paymentHint: "mpp" })
    ).rejects.toMatchObject({ code: "MPP_NOT_OFFERED" });
  });

  it("WHINT-04: thrown error is instanceof KeeperHubError (not generic Error)", async () => {
    const signer = createPaymentSigner({ walletLoader: async () => wallet });

    await expect(
      signer.pay(makeMppOnly402(), { paymentHint: "x402" })
    ).rejects.toBeInstanceOf(KeeperHubError);
  });
});
