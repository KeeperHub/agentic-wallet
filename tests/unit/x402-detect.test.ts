import { describe, expect, it } from "vitest";
import { parseX402Challenge } from "../../src/x402-detect.js";

function makeResponse(
  status: number,
  headers: Record<string, string>,
  body?: unknown
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers,
  });
}

const validX402 = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000000",
      payTo: "0x0000000000000000000000000000000000000002",
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
  resource: {
    url: "https://app.keeperhub.com/api/mcp/x/call",
    description: "test",
    mimeType: "application/json",
  },
};

describe("parseX402Challenge", () => {
  it("parses PAYMENT-REQUIRED header (base64 JSON)", async () => {
    const b64 = Buffer.from(JSON.stringify(validX402)).toString("base64");
    const resp = makeResponse(402, { "PAYMENT-REQUIRED": b64 });
    expect(await parseX402Challenge(resp)).toEqual(validX402);
  });

  it("falls back to body JSON when header absent", async () => {
    const resp = makeResponse(
      402,
      { "content-type": "application/json" },
      validX402
    );
    expect(await parseX402Challenge(resp)).toEqual(validX402);
  });

  it("returns null for x402Version=1", async () => {
    const bad = { ...validX402, x402Version: 1 };
    const resp = makeResponse(402, { "content-type": "application/json" }, bad);
    expect(await parseX402Challenge(resp)).toBeNull();
  });

  it("returns null for x402Version=3", async () => {
    const bad = { ...validX402, x402Version: 3 };
    const resp = makeResponse(402, { "content-type": "application/json" }, bad);
    expect(await parseX402Challenge(resp)).toBeNull();
  });

  it("returns null when accepts is not an array", async () => {
    const bad = { ...validX402, accepts: "not-an-array" };
    const resp = makeResponse(402, { "content-type": "application/json" }, bad);
    expect(await parseX402Challenge(resp)).toBeNull();
  });

  it("returns null when accepts is empty", async () => {
    const bad = { ...validX402, accepts: [] };
    const resp = makeResponse(402, { "content-type": "application/json" }, bad);
    expect(await parseX402Challenge(resp)).toBeNull();
  });

  it("returns null when scheme is not 'exact'", async () => {
    const bad = {
      ...validX402,
      accepts: [{ ...validX402.accepts[0], scheme: "upto" }],
    };
    const resp = makeResponse(402, { "content-type": "application/json" }, bad);
    expect(await parseX402Challenge(resp)).toBeNull();
  });

  it("returns null when PAYMENT-REQUIRED header is garbage base64", async () => {
    const resp = makeResponse(402, { "PAYMENT-REQUIRED": "not-base64!!!" });
    expect(await parseX402Challenge(resp)).toBeNull();
  });

  it("returns null for a plain 402 with no payment payload", async () => {
    const resp = makeResponse(402, {});
    expect(await parseX402Challenge(resp)).toBeNull();
  });
});
