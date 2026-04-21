// Source: 34-RESEARCH Pattern 5 + Pitfall 5.
// Coinbase deprecated the query-param pay.coinbase.com flow in favour of
// sessionToken URLs on 2025-07-31, but the legacy endpoint still returns a
// working Onramp page (it just may not pre-fill the asset/network/address
// fields). We print the legacy URL for zero-dependency ergonomics and a
// follow-up disclaimer so users know to paste manually if prefill is dropped.
//
// fund() is a pure string-build: no HTTP, no process spawn, no browser
// invocation. Callers (the CLI `keeperhub-wallet fund` subcommand, the
// `check_balance` skill in Phase 35) decide how to display the result.
//
// T-34-fund-01 mitigation: the host is hard-coded (pay.coinbase.com) and the
// only user-supplied input is the wallet address, which is regex-validated
// against the canonical 0x-prefixed 40-hex-char EVM format before any string
// interpolation.

export type FundInstructions = {
  /** Coinbase Onramp deeplink (legacy query-param form). */
  coinbaseOnrampUrl: string;
  /** Tempo deposit address — same as the input wallet (EVM address shared). */
  tempoAddress: `0x${string}`;
  /** Plain-ASCII guidance string; no emojis (CLAUDE.md rule). */
  disclaimer: string;
};

// 0x followed by exactly 40 hex chars, case-insensitive. Kept at module scope
// so the regex literal is compiled once (biome/ultracite useTopLevelRegex).
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Coinbase Onramp legacy deeplink. The host + path pair is the documented
// entry point for query-param-style Onramp sessions.
const COINBASE_HOST = "pay.coinbase.com";
const COINBASE_PATH = "/buy/select-asset";

/**
 * Build Coinbase Onramp URL + Tempo deposit address for the given wallet.
 *
 * No HTTP calls are performed. The caller is expected to either print the
 * resulting URL (CLI) or render it in a chat bubble (skill). The returned
 * `disclaimer` explains the Onramp deprecation + the Tempo external-transfer
 * fallback in plain ASCII so terminal clients with ASCII-only fonts render
 * identically to emoji-capable clients.
 *
 * @throws if `walletAddress` does not match /^0x[0-9a-fA-F]{40}$/.
 */
export function fund(walletAddress: string): FundInstructions {
  if (!EVM_ADDRESS_RE.test(walletAddress)) {
    throw new Error(`Invalid EVM wallet address: ${walletAddress}`);
  }

  // addresses is a JSON-encoded map {walletAddress: ["base"]} per Coinbase
  // Onramp docs. Encoding into URLSearchParams guarantees the colon,
  // brackets, and quotes are percent-escaped correctly.
  const params = new URLSearchParams({
    defaultNetwork: "base",
    defaultAsset: "USDC",
    addresses: JSON.stringify({ [walletAddress]: ["base"] }),
    presetCryptoAmount: "5",
  });

  const coinbaseOnrampUrl = `https://${COINBASE_HOST}${COINBASE_PATH}?${params.toString()}`;

  const disclaimer =
    "If the Coinbase page does not pre-fill, paste your address manually. " +
    "For Tempo USDC.e, transfer from an exchange or another wallet to the " +
    "address above -- Onramp does not support Tempo directly. Coinbase " +
    "sessionToken URLs are the 2025+ canonical form; legacy query-param " +
    "URLs may drop prefill on some accounts.";

  return {
    coinbaseOnrampUrl,
    tempoAddress: walletAddress as `0x${string}`,
    disclaimer,
  };
}
