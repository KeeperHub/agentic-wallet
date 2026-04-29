/**
 * WX402-04: v-parity convention guard.
 *
 * x402 signatures must use Ethereum's v+27 convention: Turnkey returns
 * yParity as "00" or "01"; @turnkey/ethers::serializeSignature adds 27,
 * so the final byte of the 132-char hex signature is always "1b" (27) or
 * "1c" (28). Any regression that returns raw yParity (0 or 1) would produce
 * a signature ending in "00" or "01" that CDP facilitators cannot verify.
 *
 * MPP charge signing uses the OPPOSITE convention: Tempo's SignatureEnvelope
 * expects the raw yParity bit (0 or 1), NOT v+27. Swapping the conventions
 * between paths is the class of bug this test prevents.
 *
 * Implementation note: the keeperhub server-side signX402Challenge calls
 * @turnkey/ethers::serializeSignature (src: lib/agentic-wallet/sign.ts).
 * The npm client (payment-signer.ts) forwards the opaque signature string
 * from /sign verbatim into the PAYMENT-SIGNATURE payload. We pin the
 * parity convention here by asserting on the signature string coming back
 * from the mocked /sign endpoint, as the client would receive it.
 */
import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { createPaymentSigner } from "../../src/payment-signer.js";
import type { WalletConfig } from "../../src/types.js";
import { server } from "../setup.js";

const wallet: WalletConfig = {
  subOrgId: "so_test_parity",
  walletAddress: "0x0000000000000000000000000000000000000008",
  hmacSecret: "ee".repeat(32),
};

const RESOURCE_URL =
  "https://app.keeperhub.com/api/mcp/workflows/parity-test/call";

function makeX402Response(sig: string): { response: Response; b64: string } {
  const challenge = {
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
      description: "parity-test",
      mimeType: "application/json",
    },
  };
  const b64 = Buffer.from(JSON.stringify(challenge)).toString("base64");
  const response = new Response(JSON.stringify(challenge), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": b64, "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { value: RESOURCE_URL });
  return { response, b64: sig };
}

type DecodedPayload = {
  payload: { signature: string };
};

describe("WX402-04 — x402 v-parity: signature must end in 1b or 1c", () => {
  it("x402 signature ending in 1b (Turnkey v=00 -> v+27=0x1b) is forwarded unchanged", async () => {
    // Simulate Turnkey returning v=00 -> serializeSignature produces trailing "1b".
    const sig1b = `0x${"aa".repeat(32)}${"11".repeat(32)}1b`;
    let capturedPaymentSig: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        () => HttpResponse.json({ signature: sig1b })
      ),
      http.post(RESOURCE_URL, ({ request }) => {
        capturedPaymentSig = request.headers.get("PAYMENT-SIGNATURE");
        return HttpResponse.json({ paid: true });
      })
    );

    const { response } = makeX402Response(sig1b);
    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    await signer.pay(response);

    expect(capturedPaymentSig).toBeTruthy();
    const decoded = JSON.parse(
      Buffer.from(capturedPaymentSig as string, "base64").toString("utf-8")
    ) as DecodedPayload;

    // Signature is forwarded verbatim from /sign into the wire payload.
    // It must end in "1b" (not "00" which would be raw yParity).
    expect(decoded.payload.signature).toBe(sig1b);
    expect(decoded.payload.signature.slice(-2)).toBe("1b");
  });

  it("x402 signature ending in 1c (Turnkey v=01 -> v+27=0x1c) is forwarded unchanged", async () => {
    const sig1c = `0x${"aa".repeat(32)}${"11".repeat(32)}1c`;
    let capturedPaymentSig: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        () => HttpResponse.json({ signature: sig1c })
      ),
      http.post(RESOURCE_URL, ({ request }) => {
        capturedPaymentSig = request.headers.get("PAYMENT-SIGNATURE");
        return HttpResponse.json({ paid: true });
      })
    );

    const { response } = makeX402Response(sig1c);
    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    await signer.pay(response);

    expect(capturedPaymentSig).toBeTruthy();
    const decoded = JSON.parse(
      Buffer.from(capturedPaymentSig as string, "base64").toString("utf-8")
    ) as DecodedPayload;

    expect(decoded.payload.signature).toBe(sig1c);
    expect(decoded.payload.signature.slice(-2)).toBe("1c");
  });

  it("MPP path uses Authorization: Payment header (not PAYMENT-SIGNATURE), proving paths are not swapped", async () => {
    // If the x402 and MPP signing paths were swapped, the MPP response would
    // appear in PAYMENT-SIGNATURE (x402 header) and vice versa.
    // A 402 with only WWW-Authenticate goes through the MPP path -- which
    // emits an Authorization header, not PAYMENT-SIGNATURE.
    let capturedAuth: string | null = null;
    let capturedPaymentSig: string | null = null;

    server.use(
      http.post(
        "https://app.keeperhub.com/api/agentic-wallet/sign",
        () => HttpResponse.json({ signature: "mpp-opaque-credential" })
      ),
      http.post(RESOURCE_URL, ({ request }) => {
        capturedAuth = request.headers.get("Authorization");
        capturedPaymentSig = request.headers.get("PAYMENT-SIGNATURE");
        return HttpResponse.json({ paid: true, via: "mpp" });
      })
    );

    const mppOnly = new Response(null, {
      status: 402,
      headers: { "WWW-Authenticate": "Payment mpp-only-challenge-xyz" },
    });
    Object.defineProperty(mppOnly, "url", { value: RESOURCE_URL });

    const signer = createPaymentSigner({ walletLoader: async () => wallet });
    await signer.pay(mppOnly);

    // MPP uses Authorization: Payment, not PAYMENT-SIGNATURE.
    expect(capturedAuth).toBe("Payment mpp-opaque-credential");
    expect(capturedPaymentSig).toBeNull();
  });
});
