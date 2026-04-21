// Sources (truth):
// - lib/agentic-wallet/sign.ts:56  -- Base USDC at
//   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (chainId 8453).
// - lib/mpp/server.ts:3            -- Tempo USDC.e at
//   0x20c000000000000000000000b9537d11c60e8b50 (chainId 4217).
//
// Tempo is not in viem/chains core as of viem 2.48.1 (the version pinned in
// this package). Define it inline via defineChain so the only dependency is
// viem itself. TEMPO_RPC_URL overrides the default RPC for heavy readers who
// want to point at their own node (T-34-bal-01 mitigation).
import { defineChain } from "viem";

export { base } from "viem/chains";

export const tempo = defineChain({
  id: 4217,
  name: "Tempo",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: {
    default: {
      http: [process.env.TEMPO_RPC_URL ?? "https://rpc.tempo.xyz"],
    },
  },
  blockExplorers: {
    default: { name: "Tempo Explorer", url: "https://explorer.tempo.xyz" },
  },
});

/** Circle-issued USDC on Base mainnet. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/** Bridged USDC (USDC.e) on Tempo mainnet. NOT the same contract as BASE_USDC. */
export const TEMPO_USDC_E =
  "0x20c000000000000000000000b9537d11c60e8b50" as const;
