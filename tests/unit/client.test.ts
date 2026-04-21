import { describe, expect, it, type Mock, vi } from "vitest";
import { KeeperHubClient } from "../../src/client.js";
import { KeeperHubError, type WalletConfig } from "../../src/types.js";

const wallet: WalletConfig = {
  subOrgId: "so_test",
  walletAddress: "0x0000000000000000000000000000000000000001",
  hmacSecret: "aa".repeat(32),
};

const SIG_HEX_64 = /^[0-9a-f]{64}$/;
const HEX_PREFIXED = /^0x[0-9a-f]+$/;

function mockFetch(status: number, body: unknown): typeof fetch {
  const fn: Mock = vi.fn(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
  );
  return fn as unknown as typeof fetch;
}

describe("KeeperHubClient", () => {
  it("signs requests with X-KH-* headers and sends JSON body", async () => {
    const fetchSpy = mockFetch(200, { signature: "0xdead" });
    const client = new KeeperHubClient(wallet, {
      baseUrl: "https://x.test",
      fetch: fetchSpy,
    });
    await client.request("POST", "/api/agentic-wallet/sign", { chain: "base" });
    const spy = fetchSpy as unknown as Mock;
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x.test/api/agentic-wallet/sign");
    const h = init.headers as Record<string, string>;
    expect(h["X-KH-Sub-Org"]).toBe("so_test");
    expect(h["X-KH-Signature"]).toMatch(SIG_HEX_64);
    expect(h["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ chain: "base" }));
  });

  it("maps 403 POLICY_BLOCKED to KeeperHubError", async () => {
    const fetchSpy = mockFetch(403, {
      error: "Policy blocked",
      code: "POLICY_BLOCKED",
    });
    const client = new KeeperHubClient(wallet, {
      baseUrl: "https://x.test",
      fetch: fetchSpy,
    });
    await expect(
      client.request("POST", "/api/agentic-wallet/sign", {})
    ).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  });

  it("maps 502 TURNKEY_UPSTREAM to KeeperHubError", async () => {
    const fetchSpy = mockFetch(502, {
      error: "Turnkey down",
      code: "TURNKEY_UPSTREAM",
    });
    const client = new KeeperHubClient(wallet, {
      baseUrl: "https://x.test",
      fetch: fetchSpy,
    });
    await expect(
      client.request("POST", "/api/agentic-wallet/sign", {})
    ).rejects.toBeInstanceOf(KeeperHubError);
  });

  it("maps 401 default code to HMAC_INVALID when server omits code field", async () => {
    const fetchSpy = mockFetch(401, { error: "Invalid signature" });
    const client = new KeeperHubClient(wallet, {
      baseUrl: "https://x.test",
      fetch: fetchSpy,
    });
    await expect(
      client.request("POST", "/api/agentic-wallet/sign", {})
    ).rejects.toMatchObject({ code: "HMAC_INVALID" });
  });

  it("surfaces 202 ask tier without throwing", async () => {
    const fetchSpy = mockFetch(202, {
      approvalRequestId: "ar_abc",
      status: "pending",
    });
    const client = new KeeperHubClient(wallet, {
      baseUrl: "https://x.test",
      fetch: fetchSpy,
    });
    const result = await client.request("POST", "/api/agentic-wallet/sign", {});
    expect(result).toEqual({ _status: 202, approvalRequestId: "ar_abc" });
  });

  it("resolves successful response body", async () => {
    const fetchSpy = mockFetch(200, { signature: `0x${"a".repeat(130)}` });
    const client = new KeeperHubClient(wallet, {
      baseUrl: "https://x.test",
      fetch: fetchSpy,
    });
    const result = await client.request<{ signature: string }>(
      "POST",
      "/api/agentic-wallet/sign",
      {}
    );
    expect((result as { signature: string }).signature).toMatch(HEX_PREFIXED);
  });

  it("baseUrl defaults to https://app.keeperhub.com when no env or opt", () => {
    const prior = process.env.KEEPERHUB_API_URL;
    delete process.env.KEEPERHUB_API_URL;
    const client = new KeeperHubClient(wallet);
    process.env.KEEPERHUB_API_URL = prior;
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(
      "https://app.keeperhub.com"
    );
  });
});
