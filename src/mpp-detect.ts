// Source: lib/payments/router.ts:152-175 -- MPP WWW-Authenticate emission.
// We forward the raw serialized challenge to /api/agentic-wallet/sign; the server
// has mppx in its deps. Keeps client runtime dep list minimal (supply-chain T-34-02).

export type MppChallenge = { serialized: string };

const MPP_PREFIX = "Payment ";

export function parseMppChallenge(response: Response): MppChallenge | null {
  const header = response.headers.get("WWW-Authenticate");
  if (!header) {
    return null;
  }
  if (!header.startsWith(MPP_PREFIX)) {
    return null;
  }
  const serialized = header.slice(MPP_PREFIX.length).trim();
  if (serialized.length === 0) {
    return null;
  }
  return { serialized };
}
