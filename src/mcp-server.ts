// stdio MCP server exposing 4 tools backed by @keeperhub/wallet:
//
//   - call_workflow   : pay-and-invoke a KeeperHub marketplace workflow
//   - balance         : on-chain balance snapshot (Base USDC + Tempo USDC.e)
//   - info            : public wallet metadata (subOrgId, walletAddress)
//   - submit_feedback : submit ERC-8004 ReputationRegistry feedback for a
//                       workflow execution the wallet paid for. Signs and
//                       broadcasts a giveFeedback() tx on Ethereum mainnet
//                       via the server-side proxy. Caller wallet pays gas
//                       natively (~$3-10 USD per call); future improvement
//                       is gas sponsorship via Pimlico or Turnkey native.
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
import { type BalanceSnapshot, checkBalance } from "./balance.js";
import { fund } from "./fund.js";
import { buildHmacHeaders } from "./hmac.js";
import { parseMppChallenge } from "./mpp-detect.js";
import {
	paymentSigner as defaultPaymentSigner,
	type PaymentSigner,
} from "./payment-signer.js";
import {
	checkFeedbackGas,
	type FeedbackGasCheckResult,
} from "./feedback-gas.js";
import { provisionWallet } from "./provision.js";
import { loadSafetyConfig, type SafetyConfig } from "./safety-config.js";
import { readWalletConfig } from "./storage.js";
import {
	KeeperHubError,
	type WalletConfig,
	WalletConfigCorruptError,
	WalletConfigMissingError,
} from "./types.js";
import { parseX402Challenge, type X402Challenge } from "./x402-detect.js";

// 256 KB ceiling on bodyText returned to the model. Larger bodies are
// truncated with `bodyTruncated: true`. Prevents single-tool responses from
// torching context windows.
const BODY_TEXT_CAP_BYTES = 256 * 1024;
const USDC_DECIMALS = 1_000_000;

// Abort outbound HTTP after this long. Picked to comfortably exceed normal
// Cloudflare-fronted KH response time (typically <2s) but bound the
// "wallet tool is hanging" failure mode users would otherwise see when
// upstream is wedged (TCP open, no response). Hits BOTH the 402 probe and
// the paymentSigner round-trip so neither leg can hang indefinitely.
const HTTP_TIMEOUT_MS = 30_000;

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readResponseBodyOnce(
	response: Response,
): Promise<{ json: unknown; text: string }> {
	const text = await response.text();
	if (text.length === 0) {
		return { json: null, text };
	}
	try {
		return { json: JSON.parse(text) as unknown, text };
	} catch {
		return { json: null, text };
	}
}

function copyFeedbackErrorFields(
	source: Record<string, unknown>,
): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const key of [
		"feedbackId",
		"txHash",
		"availableWei",
		"requiredWei",
		"gasLimit",
		"maxFeePerGasWei",
		"retryable",
		"retryAfterSeconds",
	]) {
		const value = source[key];
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			fields[key] = typeof value === "string" ? sanitise(value) : value;
		}
	}
	return fields;
}

// ---- Dependency injection (test seam) -------------------------------------

/**
 * Test seam: every external boundary the handlers touch is collected here so
 * `tests/unit/mcp-server.test.ts` can inject mocks without monkey-patching
 * module globals. Production code passes nothing — defaults bind to the real
 * implementations and the public API of `buildMcpServer()` does not change.
 */
export type McpServerDeps = {
	readWalletConfig: () => Promise<WalletConfig>;
	provisionWallet: () => Promise<WalletConfig>;
	loadSafetyConfig: () => Promise<SafetyConfig>;
	checkBalance: (wallet: WalletConfig) => Promise<BalanceSnapshot>;
	checkFeedbackGas: (wallet: WalletConfig) => Promise<FeedbackGasCheckResult>;
	paymentSigner: PaymentSigner;
	fetchImpl: typeof fetch;
};

function defaultDeps(): McpServerDeps {
	return {
		readWalletConfig,
		provisionWallet: () => provisionWallet(),
		loadSafetyConfig,
		checkBalance: (wallet) => checkBalance(wallet),
		checkFeedbackGas: (wallet) => checkFeedbackGas(wallet),
		paymentSigner: defaultPaymentSigner,
		fetchImpl: globalThis.fetch,
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
 * In-process gate against the concurrent-provision race. Without this, two
 * tool calls hitting an empty `~/.keeperhub/wallet.json` simultaneously
 * (`info` + `balance` from a single Claude session is enough — the SDK
 * dispatches them in parallel) both see WalletConfigMissingError, both POST
 * `/api/agentic-wallet/provision`, the server mints two distinct
 * (subOrgId, hmacSecret) triples, and last-rename-wins on
 * writeWalletConfig leaves disk holding wallet B while the loser's
 * envelope already showed wallet A's address to the user. Subsequent
 * calls then sign with B's HMAC against A's subOrgId and 401 forever,
 * with funds potentially trapped in the orphaned wallet A.
 *
 * The cache is scoped to a single in-flight provision attempt; on settle
 * (success or failure) it clears, so callers after the first successful
 * provision read the on-disk config via the normal `readWalletConfig`
 * path and never enter the provision branch again.
 */
let provisionInflight: Promise<WalletConfig> | null = null;

async function ensureWallet(deps: McpServerDeps): Promise<EnsureWalletResult> {
	try {
		const wallet = await deps.readWalletConfig();
		return {
			provisioned: false,
			walletAddress: wallet.walletAddress,
			subOrgId: wallet.subOrgId,
			hmacSecret: wallet.hmacSecret,
		};
	} catch (err) {
		// Fail-closed for corrupt configs: the file's PRESENCE means the user
		// (or a prior install) intentionally created a wallet there. Auto-
		// minting a replacement would silently abandon any funds held by the
		// existing wallet. Surface a structured error with the path so the
		// user can repair or delete the file deliberately.
		if (err instanceof WalletConfigCorruptError) {
			throw err;
		}
		if (!(err instanceof WalletConfigMissingError)) {
			throw err;
		}
		// Coalesce concurrent provision attempts onto a single in-flight
		// promise. The first caller to enter the catch sets the slot;
		// subsequent callers await the same promise rather than firing a
		// second provision request. On settle the slot clears so any later
		// invocation (e.g. user manually deleted wallet.json again) goes
		// through a fresh provision.
		if (provisionInflight === null) {
			provisionInflight = (async (): Promise<WalletConfig> => {
				try {
					const minted = await deps.provisionWallet();
					logEvent("mcp.wallet.provisioned", {
						walletAddress: minted.walletAddress,
					});
					return minted;
				} finally {
					provisionInflight = null;
				}
			})();
		}
		const wallet = await provisionInflight;
		return {
			provisioned: true,
			walletAddress: wallet.walletAddress,
			subOrgId: wallet.subOrgId,
			hmacSecret: wallet.hmacSecret,
		};
	}
}

/** Test-only: clear the in-process provision cache between test cases. */
function resetProvisionInflightForTests(): void {
	provisionInflight = null;
}

// ---- Payment-amount parsing for safety check -----------------------------

function microUsdcToUsd(microUsdc: bigint): number {
	// 6-decimal USDC. Convert via Number for rendering only — the threshold
	// check itself stays in bigint.
	return Number(microUsdc) / USDC_DECIMALS;
}

/**
 * Extract the lowest per-call payment amount in micro-USDC from a 402
 * challenge. Returns null when no challenge is present (caller will fall
 * through and let paymentSigner handle the no-protocol case).
 *
 * For x402: scan ALL `accepts[]` entries and pick the cheapest parseable
 * amount. Spec doesn't guarantee `accepts[0]` is the cheapest — it's just
 * the first offered. paymentSigner will pick whatever it picks for its
 * own protocol-preference reasons; if even the minimum exceeds our cap
 * we know we'd over-pay regardless. Conversely, blocking on `[0]` when
 * `[1]` is cheaper would over-block calls the user actually wants to make.
 *
 * For MPP: the serialised mppx credential includes amount fields, but the
 * client never decodes it — we let the server enforce the cap there. We
 * therefore only block on x402 amount; MPP amounts pass through to the
 * server's policy hard cap, which is the authoritative gate (GUARD-06).
 */
function extractX402AmountMicro(x402: X402Challenge | null): bigint | null {
	if (!x402) {
		return null;
	}
	let min: bigint | null = null;
	for (const accept of x402.accepts) {
		if (!/^\d+$/.test(accept.amount)) {
			continue;
		}
		const candidate = BigInt(accept.amount);
		if (min === null || candidate < min) {
			min = candidate;
		}
	}
	return min;
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

/**
 * Load the user's safety thresholds, returning null if the config file is
 * present-but-broken. Fail-CLOSED on a load error: the caller surfaces a
 * structured `SAFETY_CONFIG_INVALID` envelope so the user can repair the
 * file. Without this, a malformed safety.json throws past the structured-
 * error contract and the model sees a JSON-RPC transport explosion with
 * no path to recover. Missing-file is the safe default elsewhere — only
 * malformed bytes hit this path.
 */
async function loadSafetyOrError(
	deps: McpServerDeps,
): Promise<{ safety: SafetyConfig } | { error: ToolResult }> {
	try {
		return { safety: await deps.loadSafetyConfig() };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			error: structuredError({
				code: "SAFETY_CONFIG_INVALID",
				message: sanitise(
					`~/.keeperhub/safety.json is unreadable: ${message}. Repair the file by hand or delete it to fall back to defaults.`,
				),
			}),
		};
	}
}

/**
 * Map exceptions raised inside any tool handler into the structured-error
 * envelope contract. Throwing past this would surface as a JSON-RPC
 * transport error which the calling agent cannot programmatically recover
 * from. Specifically: corrupt wallet config, KeeperHubError-coded
 * failures, and provision/HTTP errors should all become `isError:true`
 * envelopes so Claude can read `code` and act.
 */
/**
 * Categorise a thrown fetch failure. AbortError fires on `AbortSignal.timeout`
 * (our own timeout cap) and on transport disconnects (Claude Code shutting
 * down the MCP process mid-request). `TypeError: fetch failed` is Node's
 * undici error for DNS/TCP/TLS failures — distinct from a successful HTTP
 * response with a 4xx/5xx status. Both deserve their own envelope so models
 * can branch programmatically (retry vs surface vs give up).
 */
function classifyFetchError(err: unknown): {
	code: "UPSTREAM_TIMEOUT" | "UPSTREAM_UNREACHABLE";
	message: string;
} | null {
	if (err instanceof Error) {
		if (err.name === "AbortError" || err.name === "TimeoutError") {
			return {
				code: "UPSTREAM_TIMEOUT",
				message: `Upstream request exceeded ${HTTP_TIMEOUT_MS}ms (${err.message}). Try again, or check https://status.keeperhub.com.`,
			};
		}
		if (err instanceof TypeError && err.message.includes("fetch failed")) {
			const cause =
				typeof (err as { cause?: { code?: string } }).cause?.code === "string"
					? (err as { cause: { code: string } }).cause.code
					: undefined;
			return {
				code: "UPSTREAM_UNREACHABLE",
				message: `Could not reach KeeperHub upstream (${cause ?? err.message}). Check your network connectivity, then retry.`,
			};
		}
	}
	return null;
}

function toolErrorEnvelope(err: unknown): ToolResult {
	if (err instanceof WalletConfigCorruptError) {
		return structuredError({
			code: "WALLET_CONFIG_CORRUPT",
			message: sanitise(err.message),
			path: err.path,
		});
	}
	if (err instanceof KeeperHubError) {
		return structuredError({
			code: err.code,
			message: sanitise(err.message),
		});
	}
	const fetchClassification = classifyFetchError(err);
	if (fetchClassification) {
		return structuredError({
			code: fetchClassification.code,
			message: sanitise(fetchClassification.message),
		});
	}
	const message = err instanceof Error ? err.message : String(err);
	return structuredError({
		code: "INTERNAL_ERROR",
		message: sanitise(message),
	});
}

async function handleCallWorkflow(
	args: CallWorkflowArgs,
	deps: McpServerDeps,
): Promise<ToolResult> {
	const safetyResult = await loadSafetyOrError(deps);
	if ("error" in safetyResult) {
		return safetyResult.error;
	}
	const { safety } = safetyResult;

	let ensured: EnsureWalletResult;
	try {
		ensured = await ensureWallet(deps);
	} catch (err) {
		return toolErrorEnvelope(err);
	}
	const baseUrl = resolveKeeperhubBaseUrl();
	const url = `${baseUrl}/api/mcp/workflows/${encodeURIComponent(args.slug)}/call`;
	const bodyJson = JSON.stringify(args.body ?? {});

	// Initial fetch: lets us inspect the 402 challenge and enforce the
	// block_threshold + insufficient-funds checks BEFORE handing off to
	// paymentSigner. paymentSigner re-issues its own internal probe in
	// `.fetch()`, which is fine — the second probe is the same shape.
	let probe: Response;
	try {
		probe = await deps.fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: bodyJson,
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		});
	} catch (err) {
		return toolErrorEnvelope(err);
	}

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
			const balanceSnap = await deps.checkBalance({
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
		final = await deps.paymentSigner.fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: bodyJson,
			paymentHint: args.paymentHint ?? "auto",
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		});
	} catch (err) {
		// Use the unified envelope path so KeeperHubError, AbortError, and
		// network failures all surface as `isError:true` structured envelopes
		// the calling agent can introspect — never raw transport errors.
		const env = toolErrorEnvelope(err);
		// Decorate with `provisioned`/`walletAddress`/`fundingUrl` when this
		// was the first call so the model can tell the user about the new
		// wallet even if the call failed.
		if (ensured.provisioned && env.isError) {
			const parsed = JSON.parse(env.content[0]?.text ?? "{}") as Record<
				string,
				unknown
			>;
			return structuredError({
				...(parsed as { code: string; message: string }),
				provisioned: true,
				walletAddress: ensured.walletAddress,
				fundingUrl: fund(ensured.walletAddress).coinbaseOnrampUrl,
			});
		}
		return env;
	}

	const paid = probe.status === 402 && final.status !== 402;
	const protocolUsed = paid
		? (final.headers.get("x402-protocol") ?? "x402")
		: undefined;

	// Allowlist of upstream response headers we surface to the agent. We
	// deliberately drop everything else: (1) Cloudflare/CDN noise (cf-ray,
	// nel, alt-svc) wastes context-window space, (2) reflected request
	// auth headers like X-KH-Signature/X-KH-Sub-Org could leak HMAC
	// material if a misconfigured/compromised upstream ever echoed them
	// (defence in depth — current upstream never does), (3) Set-Cookie
	// would expose session state from a compromised upstream. The fields
	// kept are the ones a model needs to interpret + retry: protocol,
	// content shape, rate-limit headroom, execution lookup.
	const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
		"content-type",
		"content-length",
		"x402-protocol",
		"x-execution-id",
		"execution-id",
		"x-ratelimit-limit",
		"x-ratelimit-remaining",
		"x-ratelimit-reset",
		"retry-after",
	]);
	const headersOut: Record<string, string> = {};
	for (const [k, v] of final.headers.entries()) {
		if (HEADER_ALLOWLIST.has(k.toLowerCase())) {
			headersOut[k] = v;
		}
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

async function handleBalance(deps: McpServerDeps): Promise<ToolResult> {
	let ensured: EnsureWalletResult;
	try {
		ensured = await ensureWallet(deps);
	} catch (err) {
		return toolErrorEnvelope(err);
	}
	const snap = await deps.checkBalance({
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

async function handleInfo(deps: McpServerDeps): Promise<ToolResult> {
	// CRITICAL: never include hmacSecret. Same rule as src/cli.ts cmdAdd at
	// lines 113-115 (T-34-cli-02 mitigation). The CLI prints only public
	// fields; the MCP server mirrors that exactly.
	let ensured: EnsureWalletResult;
	try {
		ensured = await ensureWallet(deps);
	} catch (err) {
		return toolErrorEnvelope(err);
	}
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

// ---- submit_feedback -----------------------------------------------------

const submitFeedbackInputSchema = {
	executionId: z
		.string()
		.min(1)
		.describe(
			"Workflow execution id returned in the `executionId` field of a previous successful call_workflow response.",
		),
	value: z
		.number()
		.int()
		.describe(
			"Rating value as a raw int128. With valueDecimals=0 this is a 1-5 star score; with valueDecimals=1 it is 0.1-step score. Server validates int128 range.",
		),
	valueDecimals: z
		.number()
		.int()
		.min(0)
		.max(18)
		.describe(
			"Decimals for value. Use 0 for an integer 1-5 score, 1 for a 0.1-step 0-50 score, etc.",
		),
	comment: z
		.string()
		.max(2000)
		.optional()
		.describe(
			"Optional plain-text comment included in the feedbackURI JSON.",
		),
	agentChainId: z
		.number()
		.int()
		.optional()
		.describe(
			"Chain id where the rated agent NFT lives. Defaults to 1 (Ethereum mainnet); only 1 is supported today.",
		),
	agentId: z
		.string()
		.optional()
		.describe(
			"Rated agent NFT id (uint256, decimal string). Defaults to KeeperHub's own ERC-8004 agent (31875).",
		),
};

type SubmitFeedbackArgs = {
	executionId: string;
	value: number;
	valueDecimals: number;
	comment?: string;
	agentChainId?: number;
	agentId?: string;
};

async function handleSubmitFeedback(
	args: SubmitFeedbackArgs,
	deps: McpServerDeps,
): Promise<ToolResult> {
	let ensured: EnsureWalletResult;
	try {
		ensured = await ensureWallet(deps);
	} catch (err) {
		return toolErrorEnvelope(err);
	}
	const gasCheck = await deps.checkFeedbackGas(ensured);
	if (!gasCheck.ok) {
		return structuredError({
			code: gasCheck.code,
			message: sanitise(gasCheck.message),
			...(gasCheck.availableWei ? { availableWei: gasCheck.availableWei } : {}),
			...(gasCheck.requiredWei ? { requiredWei: gasCheck.requiredWei } : {}),
			...(gasCheck.gasLimit ? { gasLimit: gasCheck.gasLimit } : {}),
			...(gasCheck.maxFeePerGasWei
				? { maxFeePerGasWei: gasCheck.maxFeePerGasWei }
				: {}),
		});
	}
	const baseUrl = resolveKeeperhubBaseUrl();
	const path = "/api/agentic-wallet/feedback";
	const url = `${baseUrl}${path}`;

	// Stringify the args as the request body. The server enforces input
	// validation -- we forward verbatim so any future schema additions on
	// the server propagate without client-side changes.
	const body = JSON.stringify({
		executionId: args.executionId,
		value: args.value,
		valueDecimals: args.valueDecimals,
		...(args.comment !== undefined ? { comment: args.comment } : {}),
		...(args.agentChainId !== undefined
			? { agentChainId: args.agentChainId }
			: {}),
		...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
	});

	const hmacHeaders = buildHmacHeaders(
		ensured.hmacSecret,
		"POST",
		path,
		ensured.subOrgId,
		body,
	);

	let response: Response;
	try {
		response = await deps.fetchImpl(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...hmacHeaders,
			},
			body,
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		});
	} catch (err) {
		return toolErrorEnvelope(err);
	}

	let responseBody: { json: unknown; text: string };
	try {
		responseBody = await readResponseBodyOnce(response);
	} catch (err) {
		return toolErrorEnvelope(err);
	}

	if (!response.ok) {
		if (!isRecord(responseBody.json)) {
			return structuredError({
				code: `FEEDBACK_HTTP_${response.status}`,
				message: sanitise(
					responseBody.text.length > 0
						? responseBody.text.slice(0, 512)
						: `HTTP ${response.status}`,
				),
			});
		}
		const errBody = responseBody.json;
		const code =
			typeof errBody.code === "string"
				? errBody.code
				: `FEEDBACK_HTTP_${response.status}`;
		const message =
			typeof errBody.error === "string"
				? errBody.error
				: typeof errBody.message === "string"
					? errBody.message
					: `HTTP ${response.status}`;
		return structuredError({
			code,
			message: sanitise(message),
			...copyFeedbackErrorFields(errBody),
		});
	}

	if (!isRecord(responseBody.json)) {
		return structuredError({
			code: "FEEDBACK_UNPARSEABLE_RESPONSE",
			message: sanitise(
				`Server returned non-JSON ${response.status}: ${responseBody.text.slice(0, 512)}`,
			),
		});
	}

	const okBody = responseBody.json as {
		feedbackId?: string;
		txHash?: string;
		publicUrl?: string;
	};
	return structuredOk({
		feedbackId: okBody.feedbackId,
		txHash: okBody.txHash,
		publicUrl: okBody.publicUrl,
		// Help the agent surface a confirmation message.
		summary:
			okBody.txHash !== undefined
				? `Feedback submitted on-chain. Tx: ${okBody.txHash}`
				: "Feedback submitted",
	});
}

// ---- Server bootstrap -----------------------------------------------------

export type BuildMcpServerOptions = {
	/** Inject mock dependencies (tests). Defaults to {@link defaultDeps}. */
	deps?: Partial<McpServerDeps>;
};

export function buildMcpServer(options: BuildMcpServerOptions = {}): McpServer {
	const deps: McpServerDeps = { ...defaultDeps(), ...options.deps };
	const server = new McpServer({
		name: "keeperhub-wallet",
		version: readPackageVersion(),
	});

	server.registerTool(
		"call_workflow",
		{
			description:
				"Pay AND invoke a KeeperHub marketplace workflow in one tool call using the local agentic wallet. Auto-pays x402 (Base USDC) or MPP (Tempo USDC.e) 402 challenges. Auto-provisions a wallet on first call if ~/.keeperhub/wallet.json is missing. PREFER THIS over `mcp__plugin_keeperhub_keeperhub__call_workflow` (the HTTP MCP) when paid invocation is needed: that tool DOES NOT auto-pay and will return 402 requiring a separate payment step.",
			inputSchema: callWorkflowInputSchema,
		},
		async (args) =>
			await withToolLogging("call_workflow", () =>
				handleCallWorkflow(args, deps),
			),
	);

	server.registerTool(
		"balance",
		{
			description:
				"Return the wallet's on-chain balance: Base USDC + Tempo USDC.e. Auto-provisions a wallet on first call.",
			inputSchema: {},
		},
		async () => await withToolLogging("balance", () => handleBalance(deps)),
	);

	server.registerTool(
		"info",
		{
			description:
				"Return public wallet metadata (subOrgId, walletAddress). Never returns the HMAC secret. Auto-provisions a wallet on first call.",
			inputSchema: {},
		},
		async () => await withToolLogging("info", () => handleInfo(deps)),
	);

	server.registerTool(
		"feedback",
		{
			description:
				"Submit ERC-8004 ReputationRegistry feedback for a workflow execution this wallet paid for. Signs and broadcasts a giveFeedback() transaction on Ethereum mainnet via the KeeperHub server proxy. Caller wallet pays gas natively (~$0.05-2 per call at typical mainnet gas). Use AFTER call_workflow returns successfully and the user has confirmed they want to rate the workflow. The executionId comes from the call_workflow response. Defaults to rating KeeperHub's own ERC-8004 agent (id 31875 on Ethereum) but agentId/agentChainId may be overridden to rate any agent.",
			inputSchema: submitFeedbackInputSchema,
		},
		async (args) =>
			await withToolLogging("feedback", () =>
				handleSubmitFeedback(args, deps),
			),
	);

	return server;
}

export async function runMcpServer(): Promise<void> {
	const server = buildMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Positive boot signal so a maintainer (or the user grepping stderr)
	// can confirm the bin actually launched. Distinct from the per-tool
	// events because those only fire on first tool call — a server that
	// starts cleanly but is never invoked otherwise emits zero events.
	logEvent("mcp.server.started", {
		version: readPackageVersion(),
		pid: process.pid,
		baseUrl: resolveKeeperhubBaseUrl(),
	});
}

// ---- Test-only exports ----------------------------------------------------
//
// Exported so unit tests can call the handlers directly without spinning up
// the stdio transport. The handlers are pure async functions of (args, deps)
// and (deps) — they never reach for module globals after this refactor.

export const __test__ = {
	handleCallWorkflow,
	handleSubmitFeedback,
	handleBalance,
	handleInfo,
	defaultDeps,
	resetProvisionInflightForTests,
	BODY_TEXT_CAP_BYTES,
};
