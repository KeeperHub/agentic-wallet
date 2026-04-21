import { randomBytes } from "node:crypto";
import { KeeperHubClient } from "./client.js";
import { type MppChallenge, parseMppChallenge } from "./mpp-detect.js";
import { readWalletConfig } from "./storage.js";
import { KeeperHubError, type WalletConfig } from "./types.js";
import { parseX402Challenge, type X402Challenge } from "./x402-detect.js";

// Tempo mainnet chain id. Forwarded to /sign so the server routes MPP
// challenges to the correct signer. Kept in sync with
// app/api/agentic-wallet/sign/route.ts::TEMPO_CHAIN_ID.
const TEMPO_CHAIN_ID = 4217;

// Approval polling: 2s * 150 = 5 minute ceiling on a human response.
// T-34-ps-04 mitigation (DoS via infinite loop).
const DEFAULT_APPROVAL_POLL = { intervalMs: 2000, maxAttempts: 150 };

// Small clock-drift buffer on validAfter. Mirrors the server's
// VALID_AFTER_FUTURE_SLACK_SECONDS in app/api/agentic-wallet/sign/route.ts.
const VALID_AFTER_PAST_SLACK_SECONDS = 60;

// x402 protocol nonce: 32-byte hex (bytes32).
const NONCE_BYTES = 32;

/**
 * Polymorphic /sign response. For `chain:"base"` the signature is a 132-char
 * 0x-prefixed EIP-712 hex string embedded inside the PAYMENT-SIGNATURE
 * base64-JSON payload. For `chain:"tempo"` it is a base64url-encoded MPP
 * credential produced by the server's mppx instance; the client forwards it
 * verbatim as the `Authorization: Payment <signature>` value. The client
 * never parses, decodes, or mutates the MPP credential -- opaque pass-through.
 */
type SignResponseOk = { signature: string };

type ApprovalStatus = "pending" | "approved" | "rejected";

type PaySignerOptions = {
  /** Override wallet loader (primarily for tests). */
  walletLoader?: () => Promise<WalletConfig>;
  /** Override KeeperHubClient factory (tests inject a mocked fetch). */
  clientFactory?: (wallet: WalletConfig) => KeeperHubClient;
  /** Replayed fetch (tests intercept the retry). */
  fetchImpl?: typeof fetch;
  /** Approval polling override: interval + max attempts. */
  approval?: { intervalMs: number; maxAttempts: number };
};

export type PaymentSigner = {
  pay: (response: Response) => Promise<Response>;
};

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createPaymentSigner(
  opts: PaySignerOptions = {}
): PaymentSigner {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const walletLoader = opts.walletLoader ?? readWalletConfig;
  const clientFactory =
    opts.clientFactory ??
    ((wallet: WalletConfig): KeeperHubClient =>
      new KeeperHubClient(wallet, { fetch: fetchImpl }));
  const pollCfg = opts.approval ?? DEFAULT_APPROVAL_POLL;

  async function signOrPoll(
    client: KeeperHubClient,
    body: Record<string, unknown>
  ): Promise<string> {
    const result = await client.request<SignResponseOk>(
      "POST",
      "/api/agentic-wallet/sign",
      body
    );
    if ("_status" in result && result._status === 202) {
      const approvalRequestId = result.approvalRequestId;
      // Poll approval-request until status !== "pending" or timeout.
      for (let attempt = 0; attempt < pollCfg.maxAttempts; attempt++) {
        await sleep(pollCfg.intervalMs);
        const status = await client.request<{ status: ApprovalStatus }>(
          "GET",
          `/api/agentic-wallet/approval-request/${approvalRequestId}`
        );
        if ("status" in status && status.status !== "pending") {
          if (status.status === "rejected") {
            throw new KeeperHubError(
              "APPROVAL_REJECTED",
              "User rejected the operation"
            );
          }
          // approved -- retry the sign call (which should now return 200).
          const retry = await client.request<SignResponseOk>(
            "POST",
            "/api/agentic-wallet/sign",
            body
          );
          if ("_status" in retry) {
            throw new KeeperHubError(
              "APPROVAL_LOOP",
              "Sign returned 202 again after approval"
            );
          }
          return retry.signature;
        }
      }
      throw new KeeperHubError(
        "APPROVAL_TIMEOUT",
        `No human response within ${pollCfg.intervalMs * pollCfg.maxAttempts}ms`
      );
    }
    return (result as SignResponseOk).signature;
  }

  async function payViaMpp(
    response: Response,
    mpp: MppChallenge,
    wallet: WalletConfig
  ): Promise<Response> {
    const client = clientFactory(wallet);
    const signature = await signOrPoll(client, {
      chain: "tempo",
      paymentChallenge: {
        kind: "mpp",
        serialized: mpp.serialized,
        chainId: TEMPO_CHAIN_ID,
      },
    });
    // POST is correct for v0.1.0 target (KeeperHub paid workflows per
    // 34-CONTEXT scope). Custom HTTP methods can be added via retryOptions in
    // a later release; do NOT read X-Replay-Method here.
    return fetchImpl(response.url, {
      method: "POST",
      headers: { Authorization: `Payment ${signature}` },
    });
  }

  async function payViaX402(
    response: Response,
    x402: X402Challenge,
    wallet: WalletConfig
  ): Promise<Response> {
    const accept = x402.accepts[0];
    if (!accept) {
      throw new KeeperHubError(
        "X402_EMPTY_ACCEPTS",
        "x402 challenge has no accepts entries"
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - VALID_AFTER_PAST_SLACK_SECONDS;
    const validBefore = now + accept.maxTimeoutSeconds;
    const nonce = `0x${randomBytes(NONCE_BYTES).toString("hex")}`;

    const client = clientFactory(wallet);
    const signature = await signOrPoll(client, {
      chain: "base",
      paymentChallenge: {
        kind: "x402",
        payTo: accept.payTo,
        amount: accept.amount,
        validAfter,
        validBefore,
        nonce,
      },
    });

    // Build the PAYMENT-SIGNATURE header: base64(JSON({payload.authorization:
    // {from,to,value,validAfter,validBefore,nonce},signature})) in the exact
    // shape lib/x402/payment-gate.ts::extractPayerAddress decodes.
    const paymentSigPayload = {
      payload: {
        authorization: {
          from: wallet.walletAddress,
          to: accept.payTo,
          value: accept.amount,
          validAfter,
          validBefore,
          nonce,
        },
        signature,
      },
    };
    const paymentSigHeader = Buffer.from(
      JSON.stringify(paymentSigPayload)
    ).toString("base64");

    const retryUrl = x402.resource.url || response.url;
    // POST is correct for v0.1.0 target (KeeperHub paid workflows). Custom
    // methods can be added via retryOptions in a later release; do NOT read
    // X-Replay-Method here.
    return fetchImpl(retryUrl, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": paymentSigHeader },
    });
  }

  return {
    async pay(response: Response): Promise<Response> {
      if (response.status !== 402) {
        return response;
      }

      const x402 = await parseX402Challenge(response);
      const mpp = parseMppChallenge(response);
      if (!(x402 || mpp)) {
        return response;
      }

      const wallet = await walletLoader();

      // PAY-03: prefer MPP when both present. Submit EXACTLY ONE credential.
      // Early return on the MPP branch guarantees payViaX402 is unreachable
      // when both challenges are offered (T-34-ps-02 mitigation).
      // Semantic rule: `if (mpp) return payViaMpp(...)` takes precedence
      // over `if (x402) return payViaX402(...)` -- no dual-protocol submission.
      if (mpp) {
        return payViaMpp(response, mpp, wallet);
      }
      if (x402) {
        return payViaX402(response, x402, wallet);
      }
      return response;
    },
  };
}

// Default instance backed by the real fetch + storage.
export const paymentSigner: PaymentSigner = createPaymentSigner();
