import { describe, expect, it } from "vitest";
import { fund } from "../../src/fund.js";

// Address literal used across the six assertions. Chosen deliberately to be
// all zeros with a trailing 6 so the regex accepts it (length 42, 0x-prefixed,
// hex-only).
const ADDR = "0x0000000000000000000000000000000000000006";

// Hosts and paths are asserted as string constants so a future refactor that
// accidentally drops the hard-coded value will surface as a specific mismatch
// rather than a fuzzy regex miss.
const COINBASE_HOST = "pay.coinbase.com";
const COINBASE_PATH = "/buy/select-asset";

// ASCII-only range covers space (0x20) through tilde (0x7E) inclusive.
// Anything outside (emoji, non-breaking spaces, smart quotes) fails the
// CLAUDE.md "no emojis" rule this test enforces at the wallet-package level.
const ASCII_PRINTABLE = /^[\x20-\x7E]+$/;
const INVALID_ADDR_ERROR = /Invalid EVM wallet address/;

describe("fund()", () => {
  it("returns a valid URL with pay.coinbase.com host and /buy/select-asset path", () => {
    const { coinbaseOnrampUrl } = fund(ADDR);
    const url = new URL(coinbaseOnrampUrl);
    expect(url.host).toBe(COINBASE_HOST);
    expect(url.pathname).toBe(COINBASE_PATH);
  });

  it("includes defaultNetwork=base and defaultAsset=USDC in query params", () => {
    const { coinbaseOnrampUrl } = fund(ADDR);
    const url = new URL(coinbaseOnrampUrl);
    expect(url.searchParams.get("defaultNetwork")).toBe("base");
    expect(url.searchParams.get("defaultAsset")).toBe("USDC");
  });

  it("embeds the wallet address inside the addresses query parameter", () => {
    const { coinbaseOnrampUrl } = fund(ADDR);
    const url = new URL(coinbaseOnrampUrl);
    const raw = url.searchParams.get("addresses") ?? "{}";
    const addresses = JSON.parse(raw) as Record<string, string[]>;
    expect(addresses[ADDR]).toEqual(["base"]);
  });

  it("returns tempoAddress equal to the input walletAddress (EVM-shared)", () => {
    const result = fund(ADDR);
    expect(result.tempoAddress).toBe(ADDR);
  });

  it("throws on an invalid EVM address", () => {
    expect(() => fund("not-an-address")).toThrow(INVALID_ADDR_ERROR);
  });

  it("does not include emojis or non-ASCII characters in disclaimer (CLAUDE.md rule)", () => {
    const { disclaimer } = fund(ADDR);
    expect(disclaimer).toMatch(ASCII_PRINTABLE);
    expect(disclaimer.length).toBeGreaterThan(20);
  });
});
