import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { checkBalance } from "../../src/balance.js";
import { BASE_USDC, TEMPO_USDC_E } from "../../src/chains.js";
import type { WalletConfig } from "../../src/types.js";

const wallet: WalletConfig = {
  subOrgId: "so_balance_test",
  walletAddress: "0x0000000000000000000000000000000000000007",
  hmacSecret: "dd".repeat(32),
};

type ReadContractArgs = {
  address: string;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
};

/**
 * Build a viem-shaped mock client that captures every readContract call. The
 * `calls` array is inspected by the contract-address assertion tests to
 * prove Base leg hits BASE_USDC and Tempo leg hits TEMPO_USDC_E (different
 * contracts on different chains).
 */
function mockViemClient(balanceRawMicro: bigint): {
  client: PublicClient;
  calls: ReadContractArgs[];
} {
  const calls: ReadContractArgs[] = [];
  const client = {
    readContract: vi.fn((args: ReadContractArgs) => {
      calls.push(args);
      return Promise.resolve(balanceRawMicro);
    }),
  } as unknown as PublicClient;
  return { client, calls };
}

describe("checkBalance()", () => {
  it("returns Base + Tempo on-chain snapshot with correct contract addresses", async () => {
    // BigInt(...) constructor (not literals) because the root tsconfig target
    // is ES2017, following the Phase 33 Plan 03 precedent (019c52ef).
    const { client: baseClient, calls: baseCalls } = mockViemClient(
      BigInt(2_500_000)
    ); // 2.50 USDC
    const { client: tempoClient, calls: tempoCalls } = mockViemClient(
      BigInt(1_750_000)
    ); // 1.75 USDC.e

    const snap = await checkBalance(wallet, { baseClient, tempoClient });

    // Amount formatting: formatUnits(raw, 6) produces decimal strings.
    expect(snap.base).toEqual({
      chain: "base",
      token: "USDC",
      amount: "2.5",
      address: wallet.walletAddress,
    });
    expect(snap.tempo).toEqual({
      chain: "tempo",
      token: "USDC.e",
      amount: "1.75",
      address: wallet.walletAddress,
    });

    // Contract-address regression guard: Base leg must hit BASE_USDC and
    // Tempo leg must hit TEMPO_USDC_E. Swapping these would return Base
    // balance from the Tempo endpoint (bug class: "wrong chain/contract").
    expect(baseCalls).toHaveLength(1);
    expect(tempoCalls).toHaveLength(1);
    expect(baseCalls[0]?.address).toBe(BASE_USDC);
    expect(baseCalls[0]?.functionName).toBe("balanceOf");
    expect(baseCalls[0]?.args).toEqual([wallet.walletAddress]);
    expect(tempoCalls[0]?.address).toBe(TEMPO_USDC_E);
    expect(tempoCalls[0]?.functionName).toBe("balanceOf");
    expect(tempoCalls[0]?.args).toEqual([wallet.walletAddress]);
    // Sanity: the two contract addresses are not the same constant.
    expect(BASE_USDC).not.toBe(TEMPO_USDC_E);
  });

  it("completes in under 2s when both legs resolve quickly (SC-3)", async () => {
    const { client: baseClient } = mockViemClient(BigInt(1_000_000));
    const { client: tempoClient } = mockViemClient(BigInt(2_000_000));

    const start = Date.now();
    await checkBalance(wallet, { baseClient, tempoClient });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("issues the two reads in parallel (Promise.all)", async () => {
    // Each leg waits 50ms before resolving. Serial would total >=100ms;
    // parallel Promise.all should land under ~80ms.
    const LEG_DELAY_MS = 50;
    const PARALLEL_CEILING_MS = 80;

    const delayedBalance = (value: bigint): PublicClient =>
      ({
        readContract: vi.fn(
          () =>
            new Promise<bigint>((resolve) =>
              setTimeout(() => resolve(value), LEG_DELAY_MS)
            )
        ),
      }) as unknown as PublicClient;

    const baseClient = delayedBalance(BigInt(1_000_000));
    const tempoClient = delayedBalance(BigInt(2_000_000));

    const start = Date.now();
    const snap = await checkBalance(wallet, { baseClient, tempoClient });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(PARALLEL_CEILING_MS);
    expect(snap.base.amount).toBe("1");
    expect(snap.tempo.amount).toBe("2");
  });
});
