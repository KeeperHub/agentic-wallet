// Source: lib/payments/router.ts:48-62 (PaymentRequiredV2 server-side shape).
// Strict parsing per 34-RESEARCH Pitfall 4 -- false-positive 402 detection is a
// wasted /sign HMAC roundtrip and a potential agent-loop trigger.

export type X402Challenge = {
  x402Version: 2;
  accepts: Array<{
    scheme: "exact";
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  }>;
  resource: { url: string; description: string; mimeType: string };
};

function isX402Shape(value: unknown): value is X402Challenge {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.x402Version !== 2) {
    return false;
  }
  if (!Array.isArray(v.accepts) || v.accepts.length === 0) {
    return false;
  }
  const first = v.accepts[0] as Record<string, unknown>;
  if (first.scheme !== "exact") {
    return false;
  }
  return true;
}

export async function parseX402Challenge(
  response: Response
): Promise<X402Challenge | null> {
  // Header path (preferred -- matches lib/payments/router.ts's PAYMENT-REQUIRED emit).
  const headerB64 = response.headers.get("PAYMENT-REQUIRED");
  if (headerB64) {
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(headerB64, "base64").toString("utf-8")
      );
      if (isX402Shape(decoded)) {
        return decoded;
      }
    } catch {
      // fall through to body
    }
  }

  // Body path (lib/payments/router.ts also emits the PaymentRequired as the 402 body).
  try {
    const clone = response.clone();
    const body: unknown = await clone.json();
    if (isX402Shape(body)) {
      return body;
    }
  } catch {
    // not JSON
  }
  return null;
}
