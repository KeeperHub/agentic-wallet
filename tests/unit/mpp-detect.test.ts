import { describe, expect, it } from "vitest";
import { parseMppChallenge } from "../../src/mpp-detect.js";

describe("parseMppChallenge", () => {
  it("returns null when WWW-Authenticate header absent", () => {
    const resp = new Response(null, { status: 402 });
    expect(parseMppChallenge(resp)).toBeNull();
  });

  it("returns null when WWW-Authenticate is not Payment scheme", () => {
    const resp = new Response(null, {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
    expect(parseMppChallenge(resp)).toBeNull();
  });

  it("strips 'Payment ' prefix and returns the serialized remainder", () => {
    const resp = new Response(null, {
      status: 402,
      headers: { "WWW-Authenticate": "Payment abc123.def456" },
    });
    expect(parseMppChallenge(resp)).toEqual({ serialized: "abc123.def456" });
  });

  it("returns null for bare 'Payment' with no serialized payload", () => {
    const resp = new Response(null, {
      status: 402,
      headers: { "WWW-Authenticate": "Payment " },
    });
    expect(parseMppChallenge(resp)).toBeNull();
  });
});
