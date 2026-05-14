// CLI dispatcher for `npx @keeperhub/wallet <cmd>`. Ships 4 subcommands:
// add (provision -- NO auth), fund (pure string-build Coinbase Onramp +
// Tempo address), balance (Base USDC + Tempo USDC.e), info (print subOrgId
// + walletAddress from ~/.keeperhub/wallet.json).
//
// v0.1.4 removed the `link` subcommand. /api/agentic-wallet/link still
// exists server-side but the UX (copy-paste session cookie) was not fit
// for real users; the server-approval ask tier that required linking
// also collapsed into an inline ask in this release. See KEEP-307 and
// KEEP-308 for the long-term design decisions.
//
// @security The HMAC secret written to wallet.json is NEVER printed to stdout
// or stderr. `add` prints only subOrgId + walletAddress + the config path so
// users can inspect perms. `info` never references the secret at all. Grep
// rule: no process.stdout/process.stderr line in this file should include
// wallet.hmacSecret or data.hmacSecret.
//
// Exit codes: 0 on success, 1 on any error (WalletConfigMissingError,
// HTTP failure, validation error). Uncaught errors are written to stderr.

import { Command } from "commander";
import { checkBalance } from "./balance.js";
import { checkFeedbackGas } from "./feedback-gas.js";
import { fund } from "./fund.js";
import { buildHmacHeaders } from "./hmac.js";
import { ProvisionHttpError, provisionWallet } from "./provision.js";
import { installSkill } from "./skill-install.js";
import { getWalletConfigPath, readWalletConfig } from "./storage.js";
import { WalletConfigMissingError } from "./types.js";

async function cmdAdd(opts: { baseUrl?: string } = {}): Promise<void> {
	try {
		const data = await provisionWallet({ baseUrl: opts.baseUrl });
		// Intentionally print only public fields. The hmacSecret is written to
		// wallet.json (chmod 0o600) but never printed -- T-34-cli-02 mitigation.
		process.stdout.write(`subOrgId: ${data.subOrgId}\n`);
		process.stdout.write(`walletAddress: ${data.walletAddress}\n`);
		process.stdout.write(`config written to ${getWalletConfigPath()}\n`);
	} catch (err) {
		if (err instanceof ProvisionHttpError) {
			process.stderr.write(
				`[keeperhub-wallet] provision failed: HTTP ${err.status}: ${err.body}\n`,
			);
			process.exit(1);
		}
		throw err;
	}
}

async function cmdFund(): Promise<void> {
	const wallet = await readWalletConfig();
	const out = fund(wallet.walletAddress);
	process.stdout.write(`${out.coinbaseOnrampUrl}\n`);
	process.stdout.write(`Tempo address: ${out.tempoAddress}\n`);
	process.stdout.write(`${out.disclaimer}\n`);
}

async function cmdBalance(): Promise<void> {
	const wallet = await readWalletConfig();
	const snap = await checkBalance(wallet);
	process.stdout.write(`Base USDC:    ${snap.base.amount}\n`);
	process.stdout.write(`Tempo USDC.e: ${snap.tempo.amount}\n`);
}

async function cmdInfo(): Promise<void> {
	const wallet = await readWalletConfig();
	process.stdout.write(`subOrgId: ${wallet.subOrgId}\n`);
	process.stdout.write(`walletAddress: ${wallet.walletAddress}\n`);
}

type FeedbackOpts = {
	executionId: string;
	value: string;
	decimals?: string;
	comment?: string;
	agentId?: string;
	chainId?: string;
	baseUrl?: string;
	forceBroadcast?: boolean;
};

const FEEDBACK_DEFAULT_BASE_URL = "https://app.keeperhub.com";

async function cmdFeedback(opts: FeedbackOpts): Promise<void> {
	const wallet = await readWalletConfig();
	const gasCheck = await checkFeedbackGas(wallet);
	if (!gasCheck.ok) {
		process.stderr.write(`${JSON.stringify(gasCheck)}\n`);
		process.exit(1);
	}
	const baseUrl = (opts.baseUrl ?? FEEDBACK_DEFAULT_BASE_URL).replace(
		/\/$/,
		"",
	);
	const path = "/api/agentic-wallet/feedback";

	// Build the request body. Server validates int128 range + 0..18 decimals
	// + executionId payment ownership; we forward verbatim and let it speak.
	const body: Record<string, unknown> = {
		executionId: opts.executionId,
		value: Number.parseInt(opts.value, 10),
		valueDecimals: Number.parseInt(opts.decimals ?? "0", 10),
	};
	if (opts.comment !== undefined) {
		body.comment = opts.comment;
	}
	if (opts.agentId !== undefined) {
		body.agentId = opts.agentId;
	}
	if (opts.chainId !== undefined) {
		body.agentChainId = Number.parseInt(opts.chainId, 10);
	}
	if (opts.forceBroadcast) {
		body.forceBroadcast = true;
	}
	const bodyJson = JSON.stringify(body);

	const headers = buildHmacHeaders(
		wallet.hmacSecret,
		"POST",
		path,
		wallet.subOrgId,
		bodyJson,
	);

	const response = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...headers,
		},
		body: bodyJson,
	});
	const text = await response.text();
	if (!response.ok) {
		process.stderr.write(`HTTP ${response.status}: ${text}\n`);
		process.exit(1);
	}
	const parsed = JSON.parse(text) as {
		feedbackId?: string;
		txHash?: string;
		publicUrl?: string;
	};
	process.stdout.write(`feedbackId: ${parsed.feedbackId ?? ""}\n`);
	process.stdout.write(`txHash: ${parsed.txHash ?? ""}\n`);
	process.stdout.write(`publicUrl: ${parsed.publicUrl ?? ""}\n`);
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
	const program = new Command();
	program
		.name("keeperhub-wallet")
		.description(
			"KeeperHub agentic wallet CLI (auto-pay x402 + MPP 402 responses)",
		)
		.version("0.1.3");

	program
		.command("add")
		.description("Provision a new agentic wallet (no account required)")
		.option("--base-url <url>", "KeeperHub API base URL")
		.action(async (opts: { baseUrl?: string }) => {
			await cmdAdd(opts);
		});

	program
		.command("fund")
		.description(
			"Print Coinbase Onramp URL (Base USDC) and Tempo deposit address",
		)
		.action(async () => {
			await cmdFund();
		});

	program
		.command("balance")
		.description("Print on-chain balance: Base USDC + Tempo USDC.e")
		.action(async () => {
			await cmdBalance();
		});

	program
		.command("info")
		.description("Print subOrgId and walletAddress from local config")
		.action(async () => {
			await cmdInfo();
		});

	program
		.command("feedback")
		.description(
			"Submit ERC-8004 ReputationRegistry feedback for a workflow execution this wallet paid for. Signs giveFeedback() via Turnkey and broadcasts on Ethereum mainnet. Caller wallet pays gas natively.",
		)
		.requiredOption(
			"--execution-id <id>",
			"workflow execution id to leave feedback for",
		)
		.requiredOption(
			"--value <int>",
			"raw int128 rating value (e.g. 5 with --decimals 0 for a 5-star rating)",
		)
		.option(
			"--decimals <int>",
			"decimals for value (0..18); 0 for integer scores, 1 for 0.1-step",
			"0",
		)
		.option("--comment <text>", "optional plaintext comment")
		.option(
			"--agent-id <id>",
			"rated agent NFT id (uint256 decimal); defaults to KeeperHub agent 31875",
		)
		.option(
			"--chain-id <int>",
			"agent chain id; defaults to 1 (Ethereum mainnet, only chain supported today)",
		)
		.option("--base-url <url>", "KeeperHub API base URL")
		.option(
			"--force-broadcast",
			"re-broadcast giveFeedback() for an executionId stuck with no txHash (requires server support)",
		)
		.action(async (opts: FeedbackOpts) => {
			await cmdFeedback(opts);
		});

	program
		.command("skill")
		.description(
			"Install the KeeperHub skill file into detected agent directories",
		)
		.addCommand(
			new Command("install")
				.description(
					"Write skill file + register PreToolUse hook in all detected agents",
				)
				.action(async () => {
					const result = await installSkill();
					for (const write of result.skillWrites) {
						process.stdout.write(
							`skill: ${write.agent} -> ${write.path} (${write.status})\n`,
						);
					}
					for (const reg of result.hookRegistrations) {
						if (reg.status === "registered") {
							process.stdout.write(
								`hook: ${reg.agent} -> PreToolUse registered\n`,
							);
						} else if (reg.status === "notice") {
							process.stderr.write(
								`notice: ${reg.agent} -> ${reg.message ?? ""}\n`,
							);
						} else if (reg.status === "failed") {
							process.stderr.write(
								`hook: ${reg.agent} -> FAILED (${reg.message ?? "unknown error"})\n`,
							);
						}
					}
					for (const reg of result.mcpRegistrations) {
						if (reg.status === "registered") {
							process.stdout.write(
								`mcp: ${reg.agent} -> registered at ${reg.path ?? "(unknown path)"}\n`,
							);
						} else if (reg.status === "notice") {
							process.stderr.write(
								`notice: ${reg.agent} mcp -> ${reg.message ?? ""}\n`,
							);
						} else if (reg.status === "failed") {
							process.stderr.write(
								`mcp: ${reg.agent} -> FAILED (${reg.message ?? "unknown error"})\n`,
							);
						}
					}
					if (result.skillWrites.length === 0) {
						process.stderr.write(
							"No supported agent skill directories detected under $HOME. Create ~/.claude/, ~/.cursor/, ~/.cline/, ~/.windsurf/, or ~/.config/opencode/ and re-run.\n",
						);
					}
				}),
		);

	try {
		await program.parseAsync(argv);
	} catch (err) {
		if (err instanceof WalletConfigMissingError) {
			process.stderr.write(`[keeperhub-wallet] ${err.message}\n`);
			process.exit(1);
		}
		process.stderr.write(
			`[keeperhub-wallet] ${(err as Error).message ?? String(err)}\n`,
		);
		process.exit(1);
	}
}
