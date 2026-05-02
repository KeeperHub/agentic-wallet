// Wallet provisioning: shared between `keeperhub-wallet add` (CLI) and the
// MCP server's auto-provision-on-first-call path.
//
// Why a shared module: the user-facing UX target is "install the wallet
// package and start calling paid workflows" — manual `keeperhub-wallet add`
// ceremony is an unnecessary speed bump. The MCP server therefore reuses
// this exact provision flow on the first tool call when ~/.keeperhub/wallet.json
// is missing. Keeping the call site in one module avoids the obvious
// drift hazard of two divergent provision implementations.
//
// @security The HMAC secret minted by /api/agentic-wallet/provision is
// returned to the caller AND written to ~/.keeperhub/wallet.json (chmod 0o600
// via writeWalletConfig). Callers MUST NOT log the returned secret to stdout
// or stderr. The CLI's `cmdAdd` and the MCP server's auto-provision branch
// both honour this — every printed/serialised path uses only `subOrgId` and
// `walletAddress`.

import { writeWalletConfig } from "./storage.js";
import type { WalletConfig } from "./types.js";

const TRAILING_SLASH = /\/$/;
const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export type ProvisionOptions = {
	/** Override KEEPERHUB_API_URL. Defaults to env var or app.keeperhub.com. */
	baseUrl?: string;
	/** Injectable fetch for tests. */
	fetchImpl?: typeof fetch;
};

export class ProvisionResponseInvalidError extends Error {
	readonly code = "PROVISION_RESPONSE_INVALID" as const;

	constructor(message: string) {
		super(message);
		this.name = "ProvisionResponseInvalidError";
	}
}

export class ProvisionHttpError extends Error {
	readonly code = "PROVISION_HTTP_ERROR" as const;
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`provision failed: HTTP ${status}: ${body}`);
		this.name = "ProvisionHttpError";
		this.status = status;
		this.body = body;
	}
}

function resolveBaseUrl(override: string | undefined): string {
	const candidate =
		override ?? process.env.KEEPERHUB_API_URL ?? "https://app.keeperhub.com";
	return candidate.replace(TRAILING_SLASH, "");
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validateProvisionResponse(data: unknown): WalletConfig {
	if (typeof data !== "object" || data === null) {
		throw new ProvisionResponseInvalidError(
			"provision response is not an object",
		);
	}
	const { subOrgId, walletAddress, hmacSecret } = data as Record<
		string,
		unknown
	>;
	if (
		!(
			isNonEmptyString(subOrgId) &&
			isNonEmptyString(walletAddress) &&
			isNonEmptyString(hmacSecret)
		)
	) {
		throw new ProvisionResponseInvalidError(
			"provision response missing subOrgId, walletAddress, or hmacSecret",
		);
	}
	if (!WALLET_ADDRESS_PATTERN.test(walletAddress)) {
		throw new ProvisionResponseInvalidError(
			`provision response walletAddress is not a valid 0x-prefixed 40-hex address: ${walletAddress}`,
		);
	}
	return {
		subOrgId,
		walletAddress: walletAddress as `0x${string}`,
		hmacSecret,
	};
}

/**
 * Mint a new agentic wallet via POST /api/agentic-wallet/provision and
 * persist the result to ~/.keeperhub/wallet.json (chmod 0o600). Returns the
 * provisioned WalletConfig. Throws ProvisionHttpError on non-2xx and
 * ProvisionResponseInvalidError on malformed payloads.
 *
 * Used by:
 *  - `keeperhub-wallet add` (manual provisioning).
 *  - The MCP server's auto-provision-on-first-call path (no manual ceremony).
 */
export async function provisionWallet(
	options: ProvisionOptions = {},
): Promise<WalletConfig> {
	const baseUrl = resolveBaseUrl(options.baseUrl);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const response = await fetchImpl(`${baseUrl}/api/agentic-wallet/provision`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	if (!response.ok) {
		const text = await response.text();
		throw new ProvisionHttpError(response.status, text);
	}
	const raw = (await response.json()) as unknown;
	const data = validateProvisionResponse(raw);
	await writeWalletConfig(data);
	return data;
}
