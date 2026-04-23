import { randomBytes } from "node:crypto";
import { KeeperHubClient } from "./client.js";
import { type MppChallenge, parseMppChallenge } from "./mpp-detect.js";
import { readWalletConfig } from "./storage.js";
import { KeeperHubError, type WalletConfig } from "./types.js";
import { extractKeeperHubWorkflowSlug } from "./workflow-slug.js";
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

/**
 * Retry options threaded through `pay()` and `fetch()` into the post-sign
 * retry. Lets callers forward the original request body and headers so the
 * paid workflow receives the same payload on the retry as on the 402 attempt
 * -- otherwise a workflow whose input schema requires a body (e.g.
 * `{address}` on `/api/mcp/workflows/<slug>/call`) rejects the retry with
 * 400 "Invalid JSON body".
 */
export type PayRetryOptions = {
  /**
   * Body to re-send on the retry. Must be a type that can be sent twice --
   * string, ArrayBuffer, Uint8Array, FormData, URLSearchParams, or Blob.
   * ReadableStream bodies are NOT supported because the first fetch() already
   * consumed the stream; pass a string/Buffer instead.
   */
  body?: RequestInit["body"];
  /**
   * Additional request headers to merge onto the retry (e.g. Content-Type).
   * The payment auth header (PAYMENT-SIGNATURE or Authorization) is set by
   * the signer and overrides any same-named header in this map.
   */
  headers?: RequestInit["headers"];
  /** HTTP method for the retry. Defaults to "POST". */
  method?: string;
};

export type PaymentSigner = {
  /**
   * Pays a 402 response and returns the post-payment retry Response.
   * Non-402 responses are returned unchanged.
   *
   * Pass `options.body` (and usually `options.headers`) if the paid
   * workflow's input schema requires a body -- `pay()` does not have access
   * to the original request otherwise.
   *
   * For most agent code, prefer `signer.fetch(url, init)` which threads the
   * body/headers automatically.
   */
  pay: (response: Response, options?: PayRetryOptions) => Promise<Response>;
  /**
   * `fetch(url, init)` wrapper: does the initial fetch, and on 402 calls
   * `pay()` with `init.body` + `init.headers` so the retry carries the
   * original payload. Returns whatever the retry (or first response, if not
   * 402) returns. No-op for non-402 responses.
   */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
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
    wallet: WalletConfig,
    retry: PayRetryOptions | undefined
  ): Promise<Response> {
    const slug = extractKeeperHubWorkflowSlug(response.url);
    if (!slug.ok) {
      throw new KeeperHubError(
        "UNSUPPORTED_RECIPIENT",
        `This wallet only signs payments for KeeperHub workflows. The 402 came from a URL that does not match /api/mcp/workflows/<slug>/call (reason: ${slug.reason}). See KEEP-311 for generic x402 support.`
      );
    }
    const client = clientFactory(wallet);
    const signature = await signOrPoll(client, {
      chain: "tempo",
      workflowSlug: slug.slug,
      paymentChallenge: {
        kind: "mpp",
        serialized: mpp.serialized,
        chainId: TEMPO_CHAIN_ID,
      },
    });
    const headers = new Headers(retry?.headers);
    headers.set("Authorization", `Payment ${signature}`);
    return fetchImpl(response.url, {
      method: retry?.method ?? "POST",
      headers,
      body: retry?.body ?? undefined,
    });
  }

  async function payViaX402(
    response: Response,
    x402: X402Challenge,
    wallet: WalletConfig,
    retry: PayRetryOptions | undefined
  ): Promise<Response> {
    const accept = x402.accepts[0];
    if (!accept) {
      throw new KeeperHubError(
        "X402_EMPTY_ACCEPTS",
        "x402 challenge has no accepts entries"
      );
    }

    const slug = extractKeeperHubWorkflowSlug(x402.resource.url || response.url);
    if (!slug.ok) {
      throw new KeeperHubError(
        "UNSUPPORTED_RECIPIENT",
        `This wallet only signs payments for KeeperHub workflows. The 402 came from a URL that does not match /api/mcp/workflows/<slug>/call (reason: ${slug.reason}). See KEEP-311 for generic x402 support.`
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - VALID_AFTER_PAST_SLACK_SECONDS;
    const validBefore = now + accept.maxTimeoutSeconds;
    const nonce = `0x${randomBytes(NONCE_BYTES).toString("hex")}`;

    const client = clientFactory(wallet);
    const signature = await signOrPoll(client, {
      chain: "base",
      workflowSlug: slug.slug,
      paymentChallenge: {
        kind: "x402",
        payTo: accept.payTo,
        amount: accept.amount,
        validAfter,
        validBefore,
        nonce,
      },
    });

    // x402 v2 PaymentPayload per @x402/core mechanisms-* d.ts:
    //   { x402Version: 2, accepted: PaymentRequirements, payload: {...} }
    // The server's findMatchingRequirements does a deepEqual between
    // `paymentPayload.accepted` and each challenge `accepts[]` entry, so we
    // mirror the exact accept object we signed against.
    //
    // EIP-3009 inner payload: authorization.value/validAfter/validBefore/nonce
    // must be STRINGS at the wire format (per @x402/evm ExactEIP3009Payload).
    // /sign takes them as numbers; we stringify on the way out.
    const paymentSigPayload = {
      x402Version: 2,
      accepted: accept,
      payload: {
        signature,
        authorization: {
          from: wallet.walletAddress,
          to: accept.payTo,
          value: accept.amount,
          validAfter: String(validAfter),
          validBefore: String(validBefore),
          nonce,
        },
      },
    };
    const paymentSigHeader = Buffer.from(
      JSON.stringify(paymentSigPayload)
    ).toString("base64");

    const retryUrl = x402.resource.url || response.url;
    const headers = new Headers(retry?.headers);
    headers.set("PAYMENT-SIGNATURE", paymentSigHeader);
    return fetchImpl(retryUrl, {
      method: retry?.method ?? "POST",
      headers,
      body: retry?.body ?? undefined,
    });
  }

  async function pay(
    response: Response,
    options?: PayRetryOptions
  ): Promise<Response> {
    if (response.status !== 402) {
      return response;
    }

    const x402 = await parseX402Challenge(response);
    const mpp = parseMppChallenge(response);
    if (!(x402 || mpp)) {
      return response;
    }

    const wallet = await walletLoader();

    // Prefer x402 (Base USDC) when both challenges are offered. Submit
    // EXACTLY ONE credential (T-34-ps-02: no dual-protocol submission).
    //
    // MPP on Tempo currently supports proof-mode only (zero-amount
    // challenges); transaction-mode (non-zero charge intents) is not yet
    // implemented on the KeeperHub server, so prefer-MPP would fail against
    // every paid workflow that offers both. x402-first keeps auto-pay
    // working for charge-intent workflows; MPP is still used when a 402
    // offers MPP alone (e.g. future zero-amount gating).
    if (x402) {
      return payViaX402(response, x402, wallet, options);
    }
    if (mpp) {
      return payViaMpp(response, mpp, wallet, options);
    }
    return response;
  }

  return {
    pay,
    async fetch(
      input: string | URL,
      init?: RequestInit
    ): Promise<Response> {
      const first = await fetchImpl(input, init);
      if (first.status !== 402) {
        return first;
      }
      // Forward the caller's body + headers + method to the post-sign retry
      // so the paid workflow receives the same payload on the retry as on
      // the 402 attempt. Fixes the dropped-body bug that made any workflow
      // with a required-input schema reject the retry with 400.
      return pay(first, {
        body: init?.body ?? undefined,
        headers: init?.headers,
        method: init?.method,
      });
    },
  };
}

// Default instance backed by the real fetch + storage.
export const paymentSigner: PaymentSigner = createPaymentSigner();
