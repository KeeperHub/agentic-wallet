import {
	createPublicClient,
	formatEther,
	http,
	type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import type { WalletConfig } from "./types.js";

const FEEDBACK_GAS_LIMIT_ESTIMATE = 250_000n;
const DEFAULT_MAX_FEE_PER_GAS_WEI = 30_000_000_000n;

export type FeedbackGasCheckResult =
	| {
			ok: true;
			availableWei: string;
			requiredWei: string;
			gasLimit?: string;
			maxFeePerGasWei?: string;
	  }
	| {
			ok: false;
			code: "INSUFFICIENT_GAS" | "FEEDBACK_GAS_CHECK_FAILED";
			message: string;
			availableWei?: string;
			requiredWei?: string;
			gasLimit?: string;
			maxFeePerGasWei?: string;
	  };

export type FeedbackGasCheckOptions = {
	client?: PublicClient;
	gasLimit?: bigint;
};

function buildMainnetClient(): PublicClient {
	const rpcUrl = process.env.ETHEREUM_RPC_URL ?? process.env.MAINNET_RPC_URL;
	return createPublicClient({
		chain: mainnet,
		transport: rpcUrl ? http(rpcUrl) : http(),
	}) as unknown as PublicClient;
}

export async function checkFeedbackGas(
	wallet: WalletConfig,
	options: FeedbackGasCheckOptions = {},
): Promise<FeedbackGasCheckResult> {
	const client = options.client ?? buildMainnetClient();
	const gasLimit = options.gasLimit ?? FEEDBACK_GAS_LIMIT_ESTIMATE;

	try {
		const [availableWei, fees] = await Promise.all([
			client.getBalance({ address: wallet.walletAddress }),
			client.estimateFeesPerGas(),
		]);
		const maxFeePerGasWei =
			fees.maxFeePerGas ?? fees.gasPrice ?? DEFAULT_MAX_FEE_PER_GAS_WEI;
		// 20% buffer: the basefee can rise between this preflight and the
		// server-side broadcast, so a raw maxFeePerGas estimate would
		// under-report the gas the wallet actually needs.
		const bufferedMaxFeePerGasWei = (maxFeePerGasWei * 120n) / 100n;
		const requiredWei = gasLimit * bufferedMaxFeePerGasWei;

		if (availableWei < requiredWei) {
			return {
				ok: false,
				code: "INSUFFICIENT_GAS",
				message: `Wallet has ${formatEther(availableWei)} ETH on Ethereum mainnet; feedback requires about ${formatEther(requiredWei)} ETH for gas.`,
				availableWei: availableWei.toString(),
				requiredWei: requiredWei.toString(),
				gasLimit: gasLimit.toString(),
				maxFeePerGasWei: bufferedMaxFeePerGasWei.toString(),
			};
		}

		return {
			ok: true,
			availableWei: availableWei.toString(),
			requiredWei: requiredWei.toString(),
			gasLimit: gasLimit.toString(),
			maxFeePerGasWei: bufferedMaxFeePerGasWei.toString(),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			code: "FEEDBACK_GAS_CHECK_FAILED",
			message: `Unable to check Ethereum mainnet gas balance before feedback submission: ${message}`,
		};
	}
}
