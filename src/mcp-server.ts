// stdio MCP server exposing 3 tools backed by @keeperhub/wallet:
//
//   - call_workflow : pay-and-invoke a KeeperHub marketplace workflow
//   - balance       : on-chain balance snapshot (Base USDC + Tempo USDC.e)
//   - info          : public wallet metadata (subOrgId, walletAddress)
//
// Design intent: the user wants to install one package (`@keeperhub/wallet`)
// and immediately call paid workflows from Claude Code without writing a Node
// script. The `call_workflow` tool wraps the same `paymentSigner.fetch` flow
// that the README documents for direct use, with two safety augments:
//
//   1. block_threshold_usd from ~/.keeperhub/safety.json is enforced inline
//      BEFORE the payment signs. The PreToolUse hook cannot see the 402
//      challenge (it fires on the MCP tool call, where there is no payment
//      shape yet — see hook.ts:hasPaymentShape), so the gate that would
//      normally fire there is replicated here.
//   2. Auto-provisioning: on first tool call, if ~/.keeperhub/wallet.json is
//      missing we run the same provision flow as `keeperhub-wallet add` so
//      the user does not need to run a CLI ceremony. The provisioned wallet
//      starts with zero balance; the next 402 round-trip will surface
//      INSUFFICIENT_FUNDS with a Coinbase Onramp URL.
//
// Stdio transport: stdin/stdout are reserved for the MCP protocol. ALL
// diagnostic output (`mcp.tool.called/completed/error` events) goes to
// stderr — writing to stdout would corrupt the JSON-RPC stream.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkBalance } from "./balance.js";
import { fund } from "./fund.js";
import { parseMppChallenge } from "./mpp-detect.js";
import { paymentSigner } from "./payment-signer.js";
import { provisionWallet } from "./provision.js";
import { loadSafetyConfig, type SafetyConfig } from "./safety-config.js";
import { readWalletConfig } from "./storage.js";
import { KeeperHubError, WalletConfigMissingError } from "./types.js";
import { parseX402Challenge, type X402Challenge } from "./x402-detect.js";

// 256 KB ceiling on bodyText returned to the model. Larger bodies are
// truncated with `bodyTruncated: true`. Prevents single-tool responses from
// torching context windows.
const BODY_TEXT_CAP_BYTES = 256 * 1024;
const USDC_DECIMALS = 1_000_000;

// Sanitise upstream-supplied strings before rendering them to the agent.
// Pattern copied verbatim from KeeperHub server lib/mcp/tools.ts
// ACCEPT_CONTROL_CHARS_RE — strips C0/C1 control chars, line/paragraph
// separators, zero-width chars, and bidi-overrides. Defends against
// log-injection / hidden-text vectors when echoing 402 messages.
const ACCEPT_CONTROL_CHARS_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching control chars + Unicode separators + bidi-overrides to neutralise log-injection / hidden-text vectors before rendering upstream-supplied strings
	/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e]/g;

const KEEPERHUB_BASE_URL_TRAILING = /\/$/;

function resolveKeeperhubBaseUrl(): string {
	const candidate =
		process.env.KEEPERHUB_API_URL ?? "https://app.keeperhub.com";
	return candidate.replace(KEEPERHUB_BASE_URL_TRAILING, "");
}

function readPackageVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const pkgPath = join(here, "..", "package.json");
		const raw = readFileSync(pkgPath, "utf-8");
		const parsed = JSON.parse(raw) as { version?: string };
		if (typeof parsed.version === "string" && parsed.version.length > 0) {
			return parsed.version;
		}
	} catch {
		// fall through
	}
	return "0.0.0";
}

function sanitise(input: string): string {
	return input.replace(ACCEPT_CONTROL_CHARS_RE, "");
}

// ---- Structured logging (stderr-only) -------------------------------------

function logEvent(event: string, data: Record<string, unknown>): void {
	const entry = {
		level: "info",
		event,
		ts: new Date().toISOString(),
		...data,
	};
	// stderr is mandatory: stdout carries the MCP JSON-RPC stream.
	process.stderr.write(`${JSON.stringify(entry)}\n`);
}

async function withToolLogging<T>(
	toolName: string,
	fn: () => Promise<T>,
): Promise<T> {
	const startMs = Date.now();
	logEvent("mcp.tool.called", { tool: toolName });
	try {
		const result = await fn();
		logEvent("mcp.tool.completed", {
			tool: toolName,
			duration_ms: Date.now() - startMs,
			success: true,
		});
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logEvent("mcp.tool.error", {
			tool: toolName,
			duration_ms: Date.now() - startMs,
			success: false,
			error: message,
		});
		throw error;
	}
}

// ---- Tool result envelopes -----------------------------------------------

type StructuredErrorPayload = {
	code: string;
	message: string;
	[k: string]: unknown;
};

type ToolContent = { type: "text"; text: string };

type ToolResult = {
	content: ToolContent[];
	isError?: boolean;
};

function structuredError(payload: StructuredErrorPayload): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		isError: true,
	};
}

function structuredOk(payload: Record<string, unknown>): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
	};
}

// ---- Auto-provisioning ----------------------------------------------------

type EnsureWalletResult = {
	provisioned: boolean;
	walletAddress: `0x${string}`;
	subOrgId: string;
	hmacSecret: string;
};

/**
 * Read ~/.keeperhub/wallet.json; if missing, mint a new wallet via the same
 * provision endpoint as `keeperhub-wallet add`. Returns the wallet config
 * plus a `provisioned` flag so callers can surface "I created a wallet at
 * 0xABC; here's how to fund it" guidance to the user on the first call.
 */
async function ensureWallet(): Promise<EnsureWalletResult> {
	try {
		const wallet = await readWalletConfig();
		return {
			provisioned: false,
			walletAddress: wallet.walletAddress,
			subOrgId: wallet.subOrgId,
			hmacSecret: wallet.hmacSecret,
		};
	} catch (err) {
		if (!(err instanceof WalletConfigMissingError)) {
			throw err;
		}
		const wallet = await provisionWallet();
		logEvent("mcp.wallet.provisioned", {
			walletAddress: wallet.walletAddress,
		});
		return {
			provisioned: true,
			walletAddress: wallet.walletAddress,
			subOrgId: wallet.subOrgId,
			hmacSecret: wallet.hmacSecret,
		};
	}
}

// ---- Payment-amount parsing for safety check -----------------------------

function microUsdcToUsd(microUsdc: bigint): number {
	// 6-decimal USDC. Convert via Number for rendering only — the threshold
	// check itself stays in bigint.
	return Number(microUsdc) / USDC_DECIMALS;
}

/**
 * Extract the per-call payment amount in micro-USDC from a 402 challenge.
 * Returns null when no challenge is present (caller will fall through and
 * let paymentSigner handle the no-protocol case).
 *
 * For x402: amount comes from accepts[0].amount (string of integer micro-USDC).
 * For MPP: the serialised mppx credential includes amount fields, but the
 * client never decodes it — we let the server enforce the cap there. We
 * therefore only block on x402 amount; MPP amounts pass through to the
 * server's policy hard cap, which is the authoritative gate (GUARD-06).
 */
function extractX402AmountMicro(x402: X402Challenge | null): bigint | null {
	const first = x402?.accepts[0];
	if (!first) {
		return null;
	}
	if (!/^\d+$/.test(first.amount)) {
		return null;
	}
	return BigInt(first.amount);
}

// Convert "1.234567" decimal-USDC string from balance.checkBalance into
// micro-USDC bigint. Returns null when the input is not a parseable number.
function parseUsdcAmount(decimal: string): bigint | null {
	const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
	if (!match) {
		return null;
	}
	const whole = match[1] ?? "0";
	const fracRaw = match[2] ?? "";
	const fracPadded = `${fracRaw}000000`.slice(0, 6);
	try {
		return BigInt(whole) * BigInt(USDC_DECIMALS) + BigInt(fracPadded);
	} catch {
		return null;
	}
}

function pickResponseFormat(
	requested: "text" | "base64" | "json" | undefined,
	contentType: string,
): "text" | "base64" | "json" {
	if (requested) {
		return requested;
	}
	const ct = contentType.toLowerCase();
	if (
		ct.startsWith("text/") ||
		ct.includes("json") ||
		ct.includes("xml") ||
		ct.includes("yaml")
	) {
		return "text";
	}
	return "base64";
}

// ---- Tool handlers --------------------------------------------------------

const callWorkflowInputSchema = {
	slug: z.string().min(1).describe("KeeperHub workflow slug"),
	body: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("JSON body forwarded to the workflow's input schema"),
	paymentHint: z
		.enum(["auto", "x402", "mpp"])
		.optional()
		.describe(
			"Payment protocol preference. 'auto' (default) prefers x402 when offered, MPP otherwise.",
		),
	responseFormat: z
		.enum(["text", "base64", "json"])
		.optional()
		.describe(
			"How to render the response body. Defaults to 'text'. Non-text content-types force base64.",
		),
};

type CallWorkflowArgs = {
	slug: string;
	body?: Record<string, unknown>;
	paymentHint?: "auto" | "x402" | "mpp";
	responseFormat?: "text" | "base64" | "json";
};

async function handleCallWorkflow(args: CallWorkflowArgs): Promise<ToolResult> {
	const safety: SafetyConfig = await loadSafetyConfig();
	const ensured = await ensureWallet();
	const baseUrl = resolveKeeperhubBaseUrl();
	const url = `${baseUrl}/api/mcp/workflows/${encodeURIComponent(args.slug)}/call`;
	const bodyJson = JSON.stringify(args.body ?? {});

	// Initial fetch: lets us inspect the 402 challenge and enforce the
	// block_threshold + insufficient-funds checks BEFORE handing off to
	// paymentSigner. paymentSigner re-issues its own internal probe in
	// `.fetch()`, which is fine — the second probe is the same shape.
	const probe = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: bodyJson,
	});

	if (probe.status === 402) {
		const x402 = await parseX402Challenge(probe);
		const mpp = parseMppChallenge(probe);

		// block_threshold check: only enforced for x402 because the MPP
		// serialised credential is opaque on the client. The server-side
		// Turnkey policy is the authoritative cap for MPP (GUARD-06).
		const amountMicro = extractX402AmountMicro(x402);
		if (amountMicro !== null) {
			const blockMicro = BigInt(
				Math.round(safety.block_threshold_usd * USDC_DECIMALS),
			);
			if (amountMicro > blockMicro) {
				const attemptedUsd = microUsdcToUsd(amountMicro);
				return structuredError({
					code: "POLICY_BLOCKED",
					message: sanitise(
						`Payment of ${attemptedUsd} USD exceeds local safety cap of ${safety.block_threshold_usd} USD (block_threshold_usd in ~/.keeperhub/safety.json).`,
					),
					threshold_usd: safety.block_threshold_usd,
					attempted_usd: attemptedUsd,
					...(ensured.provisioned
						? {
								provisioned: true,
								walletAddress: ensured.walletAddress,
								fundingUrl: fund(ensured.walletAddress).coinbaseOnrampUrl,
							}
						: {}),
				});
			}

			// Insufficient on-chain balance check (x402 only — MPP credential is
			// opaque). Surface a structured error pointing the user at funding
			// instructions instead of letting the retry burn through to a 4xx.
			const balanceSnap = await checkBalance({
				subOrgId: ensured.subOrgId,
				walletAddress: ensured.walletAddress,
				hmacSecret: ensured.hmacSecret,
			});
			const baseBalance = parseUsdcAmount(balanceSnap.base.amount);
			if (baseBalance !== null && baseBalance < amountMicro) {
				const fundInfo = fund(ensured.walletAddress);
				return structuredError({
					code: "INSUFFICIENT_FUNDS",
					message: sanitise(
						`Wallet ${ensured.walletAddress} has ${balanceSnap.base.amount} Base USDC; payment requires ${microUsdcToUsd(amountMicro)} USD.`,
					),
					needed_usd: microUsdcToUsd(amountMicro),
					balance_usd: Number(balanceSnap.base.amount),
					funding_url: fundInfo.coinbaseOnrampUrl,
					walletAddress: ensured.walletAddress,
					...(ensured.provisioned ? { provisioned: true } : {}),
				});
			}
		}

		// No challenge at all — bail with a structured error rather than
		// passing the empty 402 through to paymentSigner.
		if (!(x402 || mpp)) {
			const text = await probe.text();
			return structuredError({
				code: "PAYMENT_REQUIRED_UNPARSEABLE",
				message: sanitise(
					`Upstream returned 402 with no parseable x402 or MPP challenge. Body: ${text.slice(0, 512)}`,
				),
			});
		}
	}

	// Hand off to the canonical signer. paymentSigner.fetch internally
	// re-fires the original request, handles 402 -> /sign -> retry-with-
	// PAYMENT-SIGNATURE, and returns the post-payment Response.
	let final: Response;
	try {
		final = await paymentSigner.fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: bodyJson,
			paymentHint: args.paymentHint ?? "auto",
		});
	} catch (err) {
		if (err instanceof KeeperHubError) {
			return structuredError({
				code: err.code,
				message: sanitise(err.message),
				...(ensured.provisioned
					? {
							provisioned: true,
							walletAddress: ensured.walletAddress,
							fundingUrl: fund(ensured.walletAddress).coinbaseOnrampUrl,
						}
					: {}),
			});
		}
		throw err;
	}

	const paid = probe.status === 402 && final.status !== 402;
	const protocolUsed = paid
		? (final.headers.get("x402-protocol") ?? "x402")
		: undefined;

	const headersOut: Record<string, string> = {};
	for (const [k, v] of final.headers.entries()) {
		headersOut[k] = v;
	}
	const executionId =
		final.headers.get("x-execution-id") ?? final.headers.get("execution-id");

	const contentType = final.headers.get("content-type") ?? "";
	const responseFormat = pickResponseFormat(args.responseFormat, contentType);

	const buf = Buffer.from(await final.arrayBuffer());
	const truncated = buf.byteLength > BODY_TEXT_CAP_BYTES;
	const sliced = truncated ? buf.subarray(0, BODY_TEXT_CAP_BYTES) : buf;
	let bodyOut: string;
	if (responseFormat === "base64") {
		bodyOut = sliced.toString("base64");
	} else {
		bodyOut = sliced.toString("utf-8");
		if (responseFormat === "json") {
			try {
				const reparsed: unknown = JSON.parse(bodyOut);
				bodyOut = JSON.stringify(reparsed);
			} catch {
				// fall through with raw text
			}
		}
	}

	const result: Record<string, unknown> = {
		status: final.status,
		headers: headersOut,
		bodyText: bodyOut,
		paid,
		responseFormat,
	};
	if (truncated) {
		result.bodyTruncated = true;
	}
	if (protocolUsed) {
		result.protocolUsed = protocolUsed;
	}
	if (executionId) {
		result.executionId = executionId;
	}
	if (ensured.provisioned) {
		result.provisioned = true;
		result.walletAddress = ensured.walletAddress;
		result.fundingUrl = fund(ensured.walletAddress).coinbaseOnrampUrl;
	}
	return structuredOk(result);
}

async function handleBalance(): Promise<ToolResult> {
	const ensured = await ensureWallet();
	const snap = await checkBalance({
		subOrgId: ensured.subOrgId,
		walletAddress: ensured.walletAddress,
		hmacSecret: ensured.hmacSecret,
	});
	return structuredOk({
		base: { amount: snap.base.amount, address: snap.base.address },
		tempo: { amount: snap.tempo.amount, address: snap.tempo.address },
		...(ensured.provisioned
			? {
					provisioned: true,
					fundingUrl: fund(ensured.walletAddress).coinbaseOnrampUrl,
				}
			: {}),
	});
}

async function handleInfo(): Promise<ToolResult> {
	// CRITICAL: never include hmacSecret. Same rule as src/cli.ts cmdAdd at
	// lines 113-115 (T-34-cli-02 mitigation). The CLI prints only public
	// fields; the MCP server mirrors that exactly.
	const ensured = await ensureWallet();
	return structuredOk({
		subOrgId: ensured.subOrgId,
		walletAddress: ensured.walletAddress,
		...(ensured.provisioned
			? {
					provisioned: true,
					fundingUrl: fund(ensured.walletAddress).coinbaseOnrampUrl,
				}
			: {}),
	});
}

// ---- Server bootstrap -----------------------------------------------------

export function buildMcpServer(): McpServer {
	const server = new McpServer({
		name: "keeperhub-wallet",
		version: readPackageVersion(),
	});

	server.registerTool(
		"call_workflow",
		{
			description:
				"Pay-and-invoke a KeeperHub marketplace workflow. Auto-pays x402 (Base USDC) or MPP (Tempo USDC.e) 402 challenges. Auto-provisions a wallet on first call if ~/.keeperhub/wallet.json is missing.",
			inputSchema: callWorkflowInputSchema,
		},
		async (args) =>
			await withToolLogging("call_workflow", () => handleCallWorkflow(args)),
	);

	server.registerTool(
		"balance",
		{
			description:
				"Return the wallet's on-chain balance: Base USDC + Tempo USDC.e. Auto-provisions a wallet on first call.",
			inputSchema: {},
		},
		async () => await withToolLogging("balance", () => handleBalance()),
	);

	server.registerTool(
		"info",
		{
			description:
				"Return public wallet metadata (subOrgId, walletAddress). Never returns the HMAC secret. Auto-provisions a wallet on first call.",
			inputSchema: {},
		},
		async () => await withToolLogging("info", () => handleInfo()),
	);

	return server;
}

export async function runMcpServer(): Promise<void> {
	const server = buildMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
