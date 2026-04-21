// checkBalance() unified view (PAY-05):
//   - Base USDC balanceOf  (viem publicClient on Base)
//   - Tempo USDC.e balanceOf (viem publicClient on Tempo)
//   - off-chain KeeperHub credit (HMAC-signed GET /api/agentic-wallet/credit)
//
// All three legs are fetched in parallel via Promise.all. The two on-chain
// reads touch only the canonical USDC contract on their respective chains
// (read-only ERC-20 balanceOf with no state mutation).
//
// @security balance.ts does not emit balance data to stdout/stderr via the
// global console object or util.inspect (T-34-bal-02 mitigation). Any
// stdout emitter added here is a privacy regression; grep-enforced in
// acceptance criteria.
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  type PublicClient,
} from "viem";
import { BASE_USDC, base, TEMPO_USDC_E, tempo } from "./chains.js";
import { KeeperHubClient } from "./client.js";
import type { WalletConfig } from "./types.js";

// USDC and USDC.e both use 6 decimals on Base + Tempo respectively.
const USDC_DECIMALS = 6;

export type BalanceSnapshot = {
  base: {
    chain: "base";
    token: "USDC";
    amount: string;
    address: `0x${string}`;
  };
  tempo: {
    chain: "tempo";
    token: "USDC.e";
    amount: string;
    address: `0x${string}`;
  };
  offChainCredit: { amount: string; currency: "USD" };
};

export type CheckBalanceOptions = {
  /** Injectable viem client for Base (tests mock readContract). */
  baseClient?: PublicClient;
  /** Injectable viem client for Tempo (tests mock readContract). */
  tempoClient?: PublicClient;
  /** Injectable KeeperHubClient (tests inject a mocked fetch). */
  khClient?: KeeperHubClient;
};

type CreditResponse = { amount: string; currency: string; subOrgId: string };

/**
 * Read the wallet's balance across Base + Tempo + off-chain KeeperHub credit
 * in parallel. All three legs must resolve; any single failure rejects the
 * Promise.
 *
 * Amounts are formatted as decimal strings (6-decimal USDC precision) so the
 * caller can render them without BigInt math.
 */
export async function checkBalance(
  wallet: WalletConfig,
  opts: CheckBalanceOptions = {}
): Promise<BalanceSnapshot> {
  const baseClient =
    opts.baseClient ??
    (createPublicClient({
      chain: base,
      transport: http(),
    }) as unknown as PublicClient);
  const tempoClient =
    opts.tempoClient ??
    (createPublicClient({
      chain: tempo,
      transport: http(),
    }) as unknown as PublicClient);
  const khClient = opts.khClient ?? new KeeperHubClient(wallet);

  // Promise.all fires all three reads concurrently. Total elapsed ~= max(leg)
  // rather than sum(leg); SC-3 (<2s) test asserts this.
  const [baseRaw, tempoRaw, credit] = await Promise.all([
    baseClient.readContract({
      address: BASE_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet.walletAddress],
    }) as Promise<bigint>,
    tempoClient.readContract({
      address: TEMPO_USDC_E,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet.walletAddress],
    }) as Promise<bigint>,
    khClient.request<CreditResponse>("GET", "/api/agentic-wallet/credit"),
  ]);

  // /credit is a read-only route and does not enter the ask-tier flow; the
  // server never returns 202 here. Guard anyway so the discriminated union
  // collapses to CreditResponse for the return-shape below.
  if ("_status" in credit) {
    throw new Error("Unexpected 202 response from /api/agentic-wallet/credit");
  }

  return {
    base: {
      chain: "base",
      token: "USDC",
      amount: formatUnits(baseRaw, USDC_DECIMALS),
      address: wallet.walletAddress,
    },
    tempo: {
      chain: "tempo",
      token: "USDC.e",
      amount: formatUnits(tempoRaw, USDC_DECIMALS),
      address: wallet.walletAddress,
    },
    offChainCredit: {
      amount: credit.amount,
      currency: "USD",
    },
  };
}
