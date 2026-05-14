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
			// gasLimit 10 * bufferedMaxFee ((10 * 120) / 100 = 12) = 120.
			expect(result.requiredWei).toBe("120");
		}
	});

	it("passes when mainnet ETH balance covers the estimated feedback gas", async () => {
		const result = await checkFeedbackGas(wallet, {
			gasLimit: 10n,
			client: {
				getBalance: () => Promise.resolve(120n),
				estimateFeesPerGas: () =>
					Promise.resolve({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
			} as never,
		});

		expect(result).toMatchObject({
			ok: true,
			availableWei: "120",
			// gasLimit 10 * bufferedMaxFee ((10 * 120) / 100 = 12) = 120.
			requiredWei: "120",
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
			// gasPrice 10 buffered to (10 * 120) / 100 = 12, * gasLimit 10 = 120.
			expect(result.requiredWei).toBe("120");
			expect(result.maxFeePerGasWei).toBe("12");
		}
	});

	it("returns INSUFFICIENT_GAS when balance covers the raw estimate but not the 20% buffer", async () => {
		// Regression guard for the EIP-1559 buffer: gasLimit 10 * raw maxFeePerGas
		// 10 = 100 wei raw, but the buffered requirement is gasLimit 10 *
		// ((10 * 120) / 100 = 12) = 120 wei. A balance of 110 covers the raw
		// estimate yet must still fail once the buffer is applied.
		const result = await checkFeedbackGas(wallet, {
			gasLimit: 10n,
			client: {
				getBalance: () => Promise.resolve(110n),
				estimateFeesPerGas: () =>
					Promise.resolve({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
			} as never,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INSUFFICIENT_GAS");
			expect(result.availableWei).toBe("110");
			expect(result.requiredWei).toBe("120");
			expect(result.maxFeePerGasWei).toBe("12");
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
