import { buildHmacHeaders } from "./hmac.js";
import { KeeperHubError, type WalletConfig } from "./types.js";

export type ClientOptions = {
  /** Defaults to process.env.KEEPERHUB_API_URL ?? "https://app.keeperhub.com" */
  baseUrl?: string;
  /** Injected for tests; defaults to global fetch */
  fetch?: typeof fetch;
};

/**
 * 202 ask-tier envelope returned by /sign and /approval-request when the
 * risk classifier routes a request to the ask queue. Callers poll
 * `/api/agentic-wallet/approval-request/:id` until status !== "pending".
 */
export type AskTierResponse = {
  _status: 202;
  approvalRequestId: string;
};

const TRAILING_SLASH = /\/$/;

function defaultCodeForStatus(status: number): string {
  if (status === 401) {
    return "HMAC_INVALID";
  }
  if (status === 403) {
    return "POLICY_BLOCKED";
  }
  if (status === 404) {
    return "NOT_FOUND";
  }
  if (status === 502) {
    return "TURNKEY_UPSTREAM";
  }
  return `HTTP_${status}`;
}

/**
 * HMAC-signed HTTP client for the KeeperHub agentic-wallet API surface.
 * Every request to /api/agentic-wallet/* (except /provision, which uses
 * the session cookie) flows through this class.
 *
 * @security No logging of headers, body, or response bodies. Any stdout
 *   emitter (the global console object or util.inspect) added to this
 *   file is a T-34-08 violation (grep-enforced in CI).
 */
export class KeeperHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly wallet: WalletConfig;

  constructor(wallet: WalletConfig, opts: ClientOptions = {}) {
    this.wallet = wallet;
    const envBase = process.env.KEEPERHUB_API_URL;
    this.baseUrl = (
      opts.baseUrl ??
      envBase ??
      "https://app.keeperhub.com"
    ).replace(TRAILING_SLASH, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  /**
   * HMAC-signed POST/GET to any /api/agentic-wallet/* route except
   * /provision. Path MUST start with a leading slash. Body is
   * JSON.stringify'd (or the empty string for GET).
   *
   * Error mapping: non-2xx/non-202 surface as `KeeperHubError(code,
   * message)` where `code` is the server-supplied field or the default
   * taxonomy (`HMAC_INVALID`, `POLICY_BLOCKED`, `NOT_FOUND`,
   * `TURNKEY_UPSTREAM`, `HTTP_<status>`). 202 ask-tier surfaces as an
   * AskTierResponse envelope.
   */
  async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T | AskTierResponse> {
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    const hmacHeaders = buildHmacHeaders(
      this.wallet.hmacSecret,
      method,
      path,
      this.wallet.subOrgId,
      bodyStr
    );
    const headers: Record<string, string> =
      method === "POST"
        ? { ...hmacHeaders, "content-type": "application/json" }
        : { ...hmacHeaders };
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: method === "POST" ? bodyStr : undefined,
    });

    if (response.status === 202) {
      const data = (await response.json()) as {
        approvalRequestId: string;
        status: string;
      };
      return { _status: 202, approvalRequestId: data.approvalRequestId };
    }

    if (!response.ok) {
      let code = "UNKNOWN";
      let message = `HTTP ${response.status}`;
      try {
        const data = (await response.json()) as {
          code?: string;
          error?: string;
        };
        code = data.code ?? defaultCodeForStatus(response.status);
        message = data.error ?? message;
      } catch {
        // body is not JSON -- keep the default code + message
      }
      throw new KeeperHubError(code, message);
    }

    return (await response.json()) as T;
  }
}
