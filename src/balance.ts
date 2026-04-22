// checkBalance() unified view (PAY-05):
//   - Base USDC balanceOf  (viem publicClient on Base)
//   - Tempo USDC.e balanceOf (viem publicClient on Tempo)
//
// Both legs are fetched in parallel via Promise.all. The on-chain reads
// touch only the canonical USDC contract on their respective chains
// (read-only ERC-20 balanceOf with no state mutation).
//
// The /api/agentic-wallet/credit ledger is intentionally NOT read here:
// the server endpoint exists but no debit path is wired, so surfacing the
// balance to users implied a capability that has not shipped. Restore the
// leg here when KEEP-305/306 lands.
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
};

export type CheckBalanceOptions = {
  /** Injectable viem client for Base (tests mock readContract). */
  baseClient?: PublicClient;
  /** Injectable viem client for Tempo (tests mock readContract). */
  tempoClient?: PublicClient;
};

/**
 * Read the wallet's on-chain balance across Base + Tempo in parallel. Both
 * legs must resolve; any single failure rejects the Promise.
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

  // Promise.all fires both reads concurrently. Total elapsed ~= max(leg)
  // rather than sum(leg); SC-3 (<2s) test asserts this.
  const [baseRaw, tempoRaw] = await Promise.all([
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
  ]);

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
  };
}
