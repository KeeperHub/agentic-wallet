import { describe, expect, it } from "vitest";
import { checkFeedbackGas } from "../../src/feedback-gas.js";
import type { WalletConfig } from "../../src/types.js";

const wallet: WalletConfig = {
	subOrgId: "so_feedback_gas",
	walletAddress: "0x0000000000000000000000000000000000000001",
	hmacSecret: "aa".repeat(32),
};

describe("checkFeedbackGas", () => {
	it("returns INSUFFICIENT_GAS when mainnet ETH balance is below estimated feedback gas", async () => {
		const result = await checkFeedbackGas(wallet, {
			gasLimit: 10n,
			client: {
				getBalance: () => Promise.resolve(99n),
				estimateFeesPerGas: () =>
					Promise.resolve({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
			} as never,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INSUFFICIENT_GAS");
			expect(result.availableWei).toBe("99");
			expect(result.requiredWei).toBe("100");
		}
	});

	it("passes when mainnet ETH balance covers the estimated feedback gas", async () => {
		const result = await checkFeedbackGas(wallet, {
			gasLimit: 10n,
			client: {
				getBalance: () => Promise.resolve(100n),
				estimateFeesPerGas: () =>
					Promise.resolve({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
			} as never,
		});

		expect(result).toMatchObject({
			ok: true,
			availableWei: "100",
			requiredWei: "100",
		});
	});

	it("falls back to gasPrice when maxFeePerGas is unavailable", async () => {
		const result = await checkFeedbackGas(wallet, {
			gasLimit: 10n,
			client: {
				getBalance: () => Promise.resolve(99n),
				estimateFeesPerGas: () => Promise.resolve({ gasPrice: 10n }),
			} as never,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.requiredWei).toBe("100");
			expect(result.maxFeePerGasWei).toBe("10");
		}
	});

	it("returns FEEDBACK_GAS_CHECK_FAILED when the RPC preflight fails", async () => {
		const result = await checkFeedbackGas(wallet, {
			client: {
				getBalance: () => Promise.reject(new Error("RPC down")),
				estimateFeesPerGas: () =>
					Promise.resolve({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
			} as never,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("FEEDBACK_GAS_CHECK_FAILED");
			expect(result.message).toContain("RPC down");
		}
	});
});
