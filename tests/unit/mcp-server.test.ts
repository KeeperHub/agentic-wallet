// Unit tests for mcp-server.ts.
//
// We drive the tool handlers directly via the `__test__` export rather than
// reaching through the StdioServerTransport — easier to assert against and
// completely network-free. Each handler accepts a `McpServerDeps` argument
// containing the four boundary functions (readWalletConfig, provisionWallet,
// loadSafetyConfig, checkBalance) plus an injectable PaymentSigner and
// fetchImpl. Tests stub each boundary; no real HTTP, no real on-chain reads.
//
// Coverage:
//  - info: returns subOrgId + walletAddress; NEVER returns hmacSecret.
//  - balance: returns Base + Tempo amounts unchanged.
//  - call_workflow happy path: 402 -> paymentSigner.fetch -> 200; envelope
//    contains `paid:true`, `status:200`, `bodyText`, `executionId`.
//  - call_workflow POLICY_BLOCKED: x402 amount > block_threshold_usd; signer
//    is NOT invoked.
//  - call_workflow INSUFFICIENT_FUNDS: balance < amountMicro; envelope
//    carries funding_url, walletAddress, balance_usd, needed_usd.
//  - call_workflow PAYMENT_REQUIRED_UNPARSEABLE: 402 with no x402 / MPP
//    challenge; signer NOT called.
//  - Auto-provision on first call: missing wallet.json triggers
//    provisionWallet; subsequent call does NOT re-provision.
//  - Body cap: response body > 256KB sets `bodyTruncated:true` and bodyText
//    is exactly the cap byte length.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BalanceSnapshot } from "../../src/balance.js";
import { __test__, type McpServerDeps } from "../../src/mcp-server.js";
import type { FetchInit, PaymentSigner } from "../../src/payment-signer.js";
import { DEFAULT_SAFETY_CONFIG } from "../../src/safety-config.js";
import {
	type WalletConfig,
	WalletConfigCorruptError,
	WalletConfigMissingError,
} from "../../src/types.js";

const {
	handleCallWorkflow,
	handleSubmitFeedback,
	handleBalance,
	handleInfo,
	BODY_TEXT_CAP_BYTES,
	resetProvisionInflightForTests,
} = __test__;

const WALLET: WalletConfig = {
	subOrgId: "so_unit_mcp",
	walletAddress: "0x000000000000000000000000000000000000beef",
	hmacSecret: "ee".repeat(32),
};

const SLUG = "test-slug";
const RESOURCE_URL = `https://app.keeperhub.com/api/mcp/workflows/${SLUG}/call`;

const X402_CHALLENGE_BASE = {
	x402Version: 2 as const,
	accepts: [
		{
			scheme: "exact" as const,
			network: "eip155:8453",
			asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			amount: "1000000", // 1 USDC in micro-USDC
			payTo: "0x0000000000000000000000000000000000000099",
			maxTimeoutSeconds: 60,
			extra: {},
		},
	],
	resource: {
		url: RESOURCE_URL,
		description: "test",
		mimeType: "application/json",
	},
};

function buildBalance(amount: string): BalanceSnapshot {
	return {
		base: {
			chain: "base",
			token: "USDC",
			amount,
			address: WALLET.walletAddress,
		},
		tempo: {
			chain: "tempo",
			token: "USDC.e",
			amount: "0.0",
			address: WALLET.walletAddress,
		},
	};
}

function build402Probe(opts: {
	withChallenge?: "x402" | "mpp" | "none";
	amount?: string;
}): Response {
	const challenge = opts.withChallenge ?? "x402";
	if (challenge === "none") {
		return new Response("nothing here", {
			status: 402,
			headers: { "content-type": "text/plain" },
		});
	}
	if (challenge === "mpp") {
		return new Response("", {
			status: 402,
			headers: { "WWW-Authenticate": "Payment serialized-mpp-token" },
		});
	}
	const challengeBody = {
		...X402_CHALLENGE_BASE,
		accepts: [
			{
				...X402_CHALLENGE_BASE.accepts[0],
				amount: opts.amount ?? X402_CHALLENGE_BASE.accepts[0].amount,
			},
		],
	};
	const b64 = Buffer.from(JSON.stringify(challengeBody)).toString("base64");
	return new Response(JSON.stringify(challengeBody), {
		status: 402,
		headers: {
			"PAYMENT-REQUIRED": b64,
			"content-type": "application/json",
		},
	});
}

type StubFetchPlan = ReadonlyArray<Response>;

function buildStubFetch(plan: StubFetchPlan): {
	fn: typeof fetch;
	calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	let i = 0;
	const impl = (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		const next = plan[i];
		i += 1;
		if (!next) {
			throw new Error(`stub fetch ran out of planned responses at call ${i}`);
		}
		return Promise.resolve(next);
	};
	return { fn: impl as unknown as typeof fetch, calls };
}

type SignerStub = {
	signer: PaymentSigner;
	calls: Array<{ url: string; init: FetchInit | undefined }>;
};

function buildSignerStub(response: Response | (() => Response)): SignerStub {
	const calls: Array<{ url: string; init: FetchInit | undefined }> = [];
	const fetchFn = (
		input: string | URL,
		init?: FetchInit,
	): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		return Promise.resolve(
			typeof response === "function" ? response() : response,
		);
	};
	const signer: PaymentSigner = {
		pay: async (resp): Promise<Response> => resp,
		fetch: fetchFn,
	};
	return { signer, calls };
}

function buildDeps(overrides: Partial<McpServerDeps>): McpServerDeps {
	const stubFetch = buildStubFetch([]);
	const stubSigner = buildSignerStub(new Response("{}", { status: 200 }));
	return {
		readWalletConfig: () => Promise.resolve(WALLET),
		provisionWallet: () => Promise.resolve(WALLET),
		loadSafetyConfig: () => Promise.resolve(DEFAULT_SAFETY_CONFIG),
		checkBalance: () => Promise.resolve(buildBalance("100.0")),
		checkFeedbackGas: () =>
			Promise.resolve({
				ok: true,
				availableWei: "10000000000000000",
				requiredWei: "5000000000000000",
			}),
		paymentSigner: stubSigner.signer,
		fetchImpl: stubFetch.fn,
		...overrides,
	};
}

function parseToolJson(content: string): Record<string, unknown> {
	return JSON.parse(content) as Record<string, unknown>;
}

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	fakeHome = await mkdtemp(join(tmpdir(), "kh-mcp-server-"));
	process.env.HOME = fakeHome;
	// Silence stderr probes from logEvent during tests; assertions inspect
	// tool result envelopes, not log lines.
	vi.spyOn(process.stderr, "write").mockImplementation((): boolean => true);
	// In-process provision-race cache is module-level state; clear between
	// tests so a previous test's in-flight provision can never leak.
	resetProvisionInflightForTests();
});

afterEach(async () => {
	process.env.HOME = originalHome;
	await rm(fakeHome, { recursive: true, force: true });
	vi.restoreAllMocks();
	resetProvisionInflightForTests();
});

describe("info tool", () => {
	it("returns subOrgId + walletAddress and NEVER includes hmacSecret", async () => {
		const deps = buildDeps({});
		const result = await handleInfo(deps);
		expect(result.isError).toBeUndefined();
		const text = result.content[0]?.text ?? "";
		const parsed = parseToolJson(text);
		expect(parsed.subOrgId).toBe(WALLET.subOrgId);
		expect(parsed.walletAddress).toBe(WALLET.walletAddress);
		// CRITICAL invariant: the hmacSecret must never appear in the tool
		// response. We assert both the parsed shape AND raw text — the latter
		// catches any nested or stringified leaks.
		expect(parsed.hmacSecret).toBeUndefined();
		expect(text).not.toContain(WALLET.hmacSecret);
	});
});

describe("balance tool", () => {
	it("returns Base + Tempo amounts as strings", async () => {
		const deps = buildDeps({
			checkBalance: () =>
				Promise.resolve({
					base: {
						chain: "base",
						token: "USDC",
						amount: "12.5",
						address: WALLET.walletAddress,
					},
					tempo: {
						chain: "tempo",
						token: "USDC.e",
						amount: "3.7",
						address: WALLET.walletAddress,
					},
				}),
		});
		const result = await handleBalance(deps);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		const base = parsed.base as Record<string, unknown>;
		const tempo = parsed.tempo as Record<string, unknown>;
		expect(base.amount).toBe("12.5");
		expect(base.address).toBe(WALLET.walletAddress);
		expect(tempo.amount).toBe("3.7");
		expect(tempo.address).toBe(WALLET.walletAddress);
	});
});

describe("call_workflow tool — happy path", () => {
	it("402 then 200: envelope has paid:true, status:200, bodyText, executionId", async () => {
		const probe = build402Probe({ withChallenge: "x402" });
		const stubFetch = buildStubFetch([probe]);

		const finalBody = JSON.stringify({ ok: true, value: 42 });
		const finalResp = new Response(finalBody, {
			status: 200,
			headers: {
				"content-type": "application/json",
				"x-execution-id": "exec_abc",
				"x402-protocol": "x402",
			},
		});
		const signerStub = buildSignerStub(finalResp);

		const deps = buildDeps({
			fetchImpl: stubFetch.fn,
			paymentSigner: signerStub.signer,
			checkBalance: () => Promise.resolve(buildBalance("100.0")),
		});

		const result = await handleCallWorkflow({ slug: SLUG }, deps);
		expect(result.isError).toBeUndefined();

		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.paid).toBe(true);
		expect(parsed.status).toBe(200);
		expect(parsed.bodyText).toBe(finalBody);
		expect(parsed.executionId).toBe("exec_abc");
		expect(parsed.protocolUsed).toBe("x402");
		// Probe was fired exactly once.
		expect(stubFetch.calls).toHaveLength(1);
		expect(stubFetch.calls[0]?.url).toBe(RESOURCE_URL);
		// Signer was invoked with the same URL + the original body.
		expect(signerStub.calls).toHaveLength(1);
		expect(signerStub.calls[0]?.url).toBe(RESOURCE_URL);
	});
});

describe("call_workflow tool — POLICY_BLOCKED", () => {
	it("blocks when x402 amount exceeds block_threshold_usd; signer is NOT called", async () => {
		// safety.block_threshold_usd = 1 USD; amount in challenge = 5 USDC.
		const probe = build402Probe({
			withChallenge: "x402",
			amount: "5000000",
		});
		const stubFetch = buildStubFetch([probe]);
		const signerStub = buildSignerStub(
			new Response("should not be called", { status: 200 }),
		);

		const deps = buildDeps({
			fetchImpl: stubFetch.fn,
			paymentSigner: signerStub.signer,
			loadSafetyConfig: () =>
				Promise.resolve({
					...DEFAULT_SAFETY_CONFIG,
					auto_approve_max_usd: 0.5,
					ask_threshold_usd: 1,
					block_threshold_usd: 1,
				}),
			checkBalance: () => Promise.resolve(buildBalance("100.0")),
		});

		const result = await handleCallWorkflow({ slug: SLUG }, deps);
		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("POLICY_BLOCKED");
		expect(parsed.threshold_usd).toBe(1);
		expect(parsed.attempted_usd).toBe(5);
		// Signer must NOT be invoked when policy blocks the call.
		expect(signerStub.calls).toHaveLength(0);
	});
});

describe("call_workflow tool — INSUFFICIENT_FUNDS", () => {
	it("returns INSUFFICIENT_FUNDS with funding_url + walletAddress when balance < needed", async () => {
		// challenge amount = 0.05 USDC (50000 micro), balance = 0.0 Base USDC.
		const probe = build402Probe({ withChallenge: "x402", amount: "50000" });
		const stubFetch = buildStubFetch([probe]);
		const signerStub = buildSignerStub(
			new Response("should not be called", { status: 200 }),
		);

		const deps = buildDeps({
			fetchImpl: stubFetch.fn,
			paymentSigner: signerStub.signer,
			checkBalance: () => Promise.resolve(buildBalance("0.0")),
		});

		const result = await handleCallWorkflow({ slug: SLUG }, deps);
		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("INSUFFICIENT_FUNDS");
		expect(parsed.walletAddress).toBe(WALLET.walletAddress);
		expect(typeof parsed.funding_url).toBe("string");
		expect(parsed.funding_url).toMatch(/pay\.coinbase\.com/);
		expect(parsed.balance_usd).toBe(0);
		expect(parsed.needed_usd).toBe(0.05);
		// Signer NOT called.
		expect(signerStub.calls).toHaveLength(0);
	});
});

describe("call_workflow tool — PAYMENT_REQUIRED_UNPARSEABLE", () => {
	it("returns PAYMENT_REQUIRED_UNPARSEABLE on 402 with no x402/MPP challenge; signer NOT called", async () => {
		const probe = build402Probe({ withChallenge: "none" });
		const stubFetch = buildStubFetch([probe]);
		const signerStub = buildSignerStub(
			new Response("should not be called", { status: 200 }),
		);

		const deps = buildDeps({
			fetchImpl: stubFetch.fn,
			paymentSigner: signerStub.signer,
		});

		const result = await handleCallWorkflow({ slug: SLUG }, deps);
		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("PAYMENT_REQUIRED_UNPARSEABLE");
		expect(signerStub.calls).toHaveLength(0);
	});
});

describe("call_workflow tool — UPSTREAM_TIMEOUT / UPSTREAM_UNREACHABLE", () => {
	it("AbortError on the probe surfaces UPSTREAM_TIMEOUT (signer NOT called)", async () => {
		const abortErr = new Error("The operation was aborted due to timeout");
		abortErr.name = "TimeoutError";
		const fetchImpl: typeof fetch = () => Promise.reject(abortErr);
		const signerStub = buildSignerStub(new Response("unreached"));

		const deps = buildDeps({
			fetchImpl,
			paymentSigner: signerStub.signer,
		});

		const result = await handleCallWorkflow({ slug: SLUG }, deps);
		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("UPSTREAM_TIMEOUT");
		expect(signerStub.calls).toHaveLength(0);
	});

	it("Network failure on probe surfaces UPSTREAM_UNREACHABLE (signer NOT called)", async () => {
		const dnsErr = new TypeError("fetch failed");
		(dnsErr as { cause?: { code?: string } }).cause = { code: "ENOTFOUND" };
		const fetchImpl: typeof fetch = () => Promise.reject(dnsErr);
		const signerStub = buildSignerStub(new Response("unreached"));

		const deps = buildDeps({
			fetchImpl,
			paymentSigner: signerStub.signer,
		});

		const result = await handleCallWorkflow({ slug: SLUG }, deps);
		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("UPSTREAM_UNREACHABLE");
		// Cause code is included so the model can see DNS-vs-TLS-vs-reset.
		expect(parsed.message).toContain("ENOTFOUND");
		expect(signerStub.calls).toHaveLength(0);
	});

	it("paymentSigner.fetch network failure also surfaces UPSTREAM_UNREACHABLE (not raw rethrow)", async () => {
		// Regression guard for the M-OPS-5 fix: previously a non-KeeperHubError
		// thrown by paymentSigner.fetch escaped past the structured-error
		// envelope and surfaced as a transport explosion. Now it lands as a
		// classified envelope.
		const probe = build402Probe({ withChallenge: "x402" });
		const stubFetch = buildStubFetch([probe]);
		const dnsErr = new TypeError("fetch failed");
		(dnsErr as { cause?: { code?: string } }).cause = { code: "ECONNRESET" };
		const signer: PaymentSigner = {
			fetch: () => Promise.reject(dnsErr),
			pay: () =>
				Promise.reject(new Error("pay should not be reached in this test")),
		};

		const deps = buildDeps({
			fetchImpl: stubFetch.fn,
			paymentSigner: signer,
		});

		const result = await handleCallWorkflow({ slug: SLUG }, deps);
		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("UPSTREAM_UNREACHABLE");
	});
});

describe("auto-provision on first call", () => {
	it("missing wallet.json triggers provisionWallet, returns provisioned:true; second call does NOT re-provision", async () => {
		let provisionCount = 0;
		let walletPresent = false;

		const deps = buildDeps({
			readWalletConfig: () => {
				if (walletPresent) {
					return Promise.resolve(WALLET);
				}
				return Promise.reject(new WalletConfigMissingError());
			},
			provisionWallet: () => {
				provisionCount += 1;
				walletPresent = true;
				return Promise.resolve(WALLET);
			},
		});

		const first = await handleInfo(deps);
		const firstParsed = parseToolJson(first.content[0]?.text ?? "");
		expect(firstParsed.provisioned).toBe(true);
		expect(firstParsed.walletAddress).toBe(WALLET.walletAddress);
		expect(typeof firstParsed.fundingUrl).toBe("string");
		expect(provisionCount).toBe(1);

		const second = await handleInfo(deps);
		const secondParsed = parseToolJson(second.content[0]?.text ?? "");
		expect(secondParsed.provisioned).toBeUndefined();
		expect(secondParsed.fundingUrl).toBeUndefined();
		expect(provisionCount).toBe(1);
	});

	it("concurrent first calls coalesce onto a single provision (race fix)", async () => {
		// Regression guard for the H1 race the correctness reviewer flagged:
		// the SDK dispatches `info` + `balance` + `call_workflow` in parallel
		// when an agent loads. Without the in-process promise cache, all
		// three would enter the catch branch simultaneously, all three would
		// POST /provision, and last-rename-wins on disk would leave two
		// orphaned wallets — the loser's address shown to the user but its
		// HMAC discarded. Assert the cache collapses N concurrent callers
		// onto exactly one provisionWallet invocation.
		let provisionCount = 0;
		let walletPresent = false;
		// Hold the provision promise open until all three callers have entered.
		let releaseProvision: (() => void) | null = null;
		const provisionGate = new Promise<void>((resolve) => {
			releaseProvision = resolve;
		});

		const deps = buildDeps({
			readWalletConfig: () => {
				if (walletPresent) {
					return Promise.resolve(WALLET);
				}
				return Promise.reject(new WalletConfigMissingError());
			},
			provisionWallet: async () => {
				provisionCount += 1;
				await provisionGate;
				walletPresent = true;
				return WALLET;
			},
		});

		const a = handleInfo(deps);
		const b = handleBalance(deps);
		const c = handleInfo(deps);
		// Let them all enter the catch+inflight slot before we release.
		await Promise.resolve();
		releaseProvision?.();
		const [ra, rb, rc] = await Promise.all([a, b, c]);

		expect(provisionCount).toBe(1);
		// Every caller sees the same minted wallet.
		const pa = parseToolJson(ra.content[0]?.text ?? "");
		const pc = parseToolJson(rc.content[0]?.text ?? "");
		expect(pa.walletAddress).toBe(WALLET.walletAddress);
		expect(pc.walletAddress).toBe(WALLET.walletAddress);
		// balance() doesn't surface walletAddress at the top level — assert
		// it didn't error and that the call was satisfied by the same wallet.
		expect(rb.isError).not.toBe(true);
	});

	it("corrupt wallet.json fails closed with WALLET_CONFIG_CORRUPT (does NOT silently re-provision)", async () => {
		// H2 fix: the file's PRESENCE means the user (or a prior install)
		// intentionally created a wallet there. Auto-minting a replacement
		// would silently abandon any funds held in the existing wallet.
		// Surface a structured error with the path so the user can repair
		// or delete the file deliberately.
		let provisionCount = 0;
		const deps = buildDeps({
			readWalletConfig: () =>
				Promise.reject(
					new WalletConfigCorruptError(
						"/fake/.keeperhub/wallet.json",
						"missing required fields",
					),
				),
			provisionWallet: () => {
				provisionCount += 1;
				return Promise.resolve(WALLET);
			},
		});

		const result = await handleInfo(deps);
		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("WALLET_CONFIG_CORRUPT");
		expect(parsed.path).toBe("/fake/.keeperhub/wallet.json");
		// The critical safety property: provisionWallet was NEVER called.
		expect(provisionCount).toBe(0);
	});
});

describe("call_workflow tool — SAFETY_CONFIG_INVALID", () => {
	it("malformed safety.json returns structured error (not transport explosion)", async () => {
		// H3 fix: loadSafetyConfig errors used to escape past the structured-
		// error contract and surface as a JSON-RPC transport error which the
		// calling agent could not programmatically recover from. Wrap and
		// return SAFETY_CONFIG_INVALID so the model can read `code` and
		// guide the user to repair ~/.keeperhub/safety.json.
		const deps = buildDeps({
			loadSafetyConfig: () =>
				Promise.reject(new Error("Unexpected token } in JSON at position 42")),
		});

		const result = await handleCallWorkflow(
			{ slug: "any-slug", body: {} },
			deps,
		);
		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("SAFETY_CONFIG_INVALID");
		expect(typeof parsed.message).toBe("string");
		// The reason from the underlying error is preserved (sanitised) so
		// the user can act on it.
		expect(parsed.message).toContain("Unexpected token");
	});
});

describe("call_workflow tool — body cap", () => {
	it("response > 256KB is truncated and flagged with bodyTruncated:true", async () => {
		const probe = build402Probe({ withChallenge: "x402" });
		const stubFetch = buildStubFetch([probe]);

		// Build a body 1 byte larger than the cap. Use ASCII so utf-8 byteLength
		// equals the string length and the cap maps cleanly.
		const oversize = "a".repeat(BODY_TEXT_CAP_BYTES + 1);
		const finalResp = new Response(oversize, {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
		const signerStub = buildSignerStub(finalResp);

		const deps = buildDeps({
			fetchImpl: stubFetch.fn,
			paymentSigner: signerStub.signer,
			checkBalance: () => Promise.resolve(buildBalance("100.0")),
		});

		const result = await handleCallWorkflow({ slug: SLUG }, deps);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.bodyTruncated).toBe(true);
		const bodyText = parsed.bodyText as string;
		// utf-8 byteLength of the string == length here because everything is
		// 1-byte ASCII.
		expect(Buffer.byteLength(bodyText, "utf-8")).toBe(BODY_TEXT_CAP_BYTES);
	});
});

describe("feedback tool", () => {
	it("preflights mainnet gas before POSTing feedback to the server", async () => {
		const fetchImpl = vi.fn(() =>
			Promise.resolve(new Response("should not be called", { status: 200 })),
		) as unknown as typeof fetch;

		const deps = buildDeps({
			fetchImpl,
			checkFeedbackGas: () =>
				Promise.resolve({
					ok: false,
					code: "INSUFFICIENT_GAS",
					message:
						"Wallet has 0 wei on Ethereum mainnet; feedback requires about 5000000000000000 wei for gas.",
					availableWei: "0",
					requiredWei: "5000000000000000",
				}),
		});

		const result = await handleSubmitFeedback(
			{ executionId: "exec_low_gas", value: 5, valueDecimals: 0 },
			deps,
		);

		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("INSUFFICIENT_GAS");
		expect(parsed.availableWei).toBe("0");
		expect(parsed.requiredWei).toBe("5000000000000000");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("surfaces feedback gas preflight RPC failures without mutating server state", async () => {
		const fetchImpl = vi.fn(() =>
			Promise.resolve(new Response("should not be called", { status: 200 })),
		) as unknown as typeof fetch;

		const deps = buildDeps({
			fetchImpl,
			checkFeedbackGas: () =>
				Promise.resolve({
					ok: false,
					code: "FEEDBACK_GAS_CHECK_FAILED",
					message: "Unable to check Ethereum mainnet gas balance: RPC down",
				}),
		});

		const result = await handleSubmitFeedback(
			{ executionId: "exec_rpc_down", value: 5, valueDecimals: 0 },
			deps,
		);

		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("FEEDBACK_GAS_CHECK_FAILED");
		expect(parsed.message).toContain("RPC down");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("does not double-read non-JSON feedback error responses", async () => {
		const deps = buildDeps({
			checkFeedbackGas: () =>
				Promise.resolve({
					ok: true,
					availableWei: "10000000000000000",
					requiredWei: "5000000000000000",
				}),
			fetchImpl: () =>
				Promise.resolve(
					new Response("upstream broadcast failed before tx submission", {
						status: 502,
						headers: { "content-type": "text/plain" },
					}),
				),
		});

		const result = await handleSubmitFeedback(
			{ executionId: "exec_rpc_error", value: 5, valueDecimals: 0 },
			deps,
		);

		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("FEEDBACK_HTTP_502");
		expect(parsed.message).toContain("upstream broadcast failed");
		expect(parsed.message).not.toContain("Body is unusable");
	});

	it("preserves structured insufficient-gas fields from the feedback API", async () => {
		const deps = buildDeps({
			checkFeedbackGas: () =>
				Promise.resolve({
					ok: true,
					availableWei: "10000000000000000",
					requiredWei: "5000000000000000",
				}),
			fetchImpl: () =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							code: "INSUFFICIENT_GAS",
							error: "Wallet needs more ETH for mainnet gas",
							availableWei: "0",
							requiredWei: "5000000000000000",
						}),
						{
							status: 402,
							headers: { "content-type": "application/json" },
						},
					),
				),
		});

		const result = await handleSubmitFeedback(
			{ executionId: "exec_server_low_gas", value: 5, valueDecimals: 0 },
			deps,
		);

		expect(result.isError).toBe(true);
		const parsed = parseToolJson(result.content[0]?.text ?? "");
		expect(parsed.code).toBe("INSUFFICIENT_GAS");
		expect(parsed.availableWei).toBe("0");
		expect(parsed.requiredWei).toBe("5000000000000000");
		expect(parsed.feedbackId).toBeUndefined();
	});
});
