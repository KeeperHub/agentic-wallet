// Unit tests for provision.ts — the shared wallet-provisioning module used
// by both `keeperhub-wallet add` (CLI) and the MCP server's
// auto-provision-on-first-call path.
//
// Coverage:
//   1. Happy path: the server returns a valid {subOrgId, walletAddress,
//      hmacSecret}; the function persists wallet.json with mode 0o600 and
//      returns the parsed config.
//   2. Malformed body: missing fields → ProvisionResponseInvalidError.
//   3. Non-2xx response: ProvisionHttpError preserves status + body.
//   4. Invalid walletAddress format → ProvisionResponseInvalidError.

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ProvisionHttpError,
	ProvisionResponseInvalidError,
	provisionWallet,
} from "../../src/provision.js";

const VALID_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const VALID_SUBORG = "so_unit_test";
const VALID_HMAC = "ab".repeat(32);

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	fakeHome = await mkdtemp(join(tmpdir(), "kh-provision-"));
	process.env.HOME = fakeHome;
});

afterEach(async () => {
	process.env.HOME = originalHome;
	await rm(fakeHome, { recursive: true, force: true });
});

type StubFetchOptions = {
	status?: number;
	body: unknown;
	bodyIsString?: boolean;
};

function stubFetch(opts: StubFetchOptions): typeof fetch {
	const status = opts.status ?? 200;
	const payload =
		opts.bodyIsString === true
			? (opts.body as string)
			: JSON.stringify(opts.body);
	const impl = (
		_input: RequestInfo | URL,
		_init?: RequestInit,
	): Promise<Response> =>
		Promise.resolve(
			new Response(payload, {
				status,
				headers: { "content-type": "application/json" },
			}),
		);
	return impl as unknown as typeof fetch;
}

describe("provisionWallet()", () => {
	it("happy path: writes wallet.json with mode 0o600 and returns the parsed config", async () => {
		const result = await provisionWallet({
			baseUrl: "https://test.local",
			fetchImpl: stubFetch({
				body: {
					subOrgId: VALID_SUBORG,
					walletAddress: VALID_WALLET,
					hmacSecret: VALID_HMAC,
				},
			}),
		});

		expect(result.subOrgId).toBe(VALID_SUBORG);
		expect(result.walletAddress).toBe(VALID_WALLET);
		expect(result.hmacSecret).toBe(VALID_HMAC);

		const walletPath = join(fakeHome, ".keeperhub", "wallet.json");
		const st = await stat(walletPath);
		// 0o600: file owner R/W, group/other = no permissions. Same rule as
		// safety.json's 0o644 except wallet.json holds the HMAC secret so we
		// hard-deny group/other reads.
		expect(st.mode & 0o777).toBe(0o600);

		const raw = await readFile(walletPath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect(parsed.subOrgId).toBe(VALID_SUBORG);
		expect(parsed.walletAddress).toBe(VALID_WALLET);
		expect(parsed.hmacSecret).toBe(VALID_HMAC);
	});

	it("throws ProvisionResponseInvalidError when the server returns a malformed body (missing fields)", async () => {
		await expect(
			provisionWallet({
				baseUrl: "https://test.local",
				fetchImpl: stubFetch({
					body: { subOrgId: VALID_SUBORG, walletAddress: VALID_WALLET },
				}),
			}),
		).rejects.toBeInstanceOf(ProvisionResponseInvalidError);
	});

	it("throws ProvisionResponseInvalidError when the server returns a non-object body", async () => {
		await expect(
			provisionWallet({
				baseUrl: "https://test.local",
				fetchImpl: stubFetch({ body: "not an object" }),
			}),
		).rejects.toBeInstanceOf(ProvisionResponseInvalidError);
	});

	it("throws ProvisionHttpError preserving status + body on non-2xx", async () => {
		try {
			await provisionWallet({
				baseUrl: "https://test.local",
				fetchImpl: stubFetch({
					status: 503,
					body: "upstream is on fire",
					bodyIsString: true,
				}),
			});
			throw new Error("expected provisionWallet to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ProvisionHttpError);
			const e = err as ProvisionHttpError;
			expect(e.status).toBe(503);
			expect(e.body).toBe("upstream is on fire");
			expect(e.code).toBe("PROVISION_HTTP_ERROR");
		}
	});

	it("throws ProvisionResponseInvalidError when walletAddress fails the 0x40-hex check", async () => {
		await expect(
			provisionWallet({
				baseUrl: "https://test.local",
				fetchImpl: stubFetch({
					body: {
						subOrgId: VALID_SUBORG,
						walletAddress: "0xnothex",
						hmacSecret: VALID_HMAC,
					},
				}),
			}),
		).rejects.toBeInstanceOf(ProvisionResponseInvalidError);
	});
});
