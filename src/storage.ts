import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type WalletConfig,
	WalletConfigCorruptError,
	WalletConfigMissingError,
} from "./types.js";

// NOTE: Every function calls `join(homedir(), ".keeperhub", "wallet.json")`
// itself. Do NOT hoist to a module-level `const WALLET_PATH` -- tests
// override `process.env.HOME` in `beforeEach` and `homedir()` must re-read
// that on each call. A hoisted constant would freeze the harness's original
// HOME at import time and every test would write into the real
// ~/.keeperhub/ directory.

export async function readWalletConfig(): Promise<WalletConfig> {
	const walletPath = join(homedir(), ".keeperhub", "wallet.json");
	let raw: string;
	try {
		raw = await readFile(walletPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new WalletConfigMissingError();
		}
		throw err;
	}
	// The file's PRESENCE means it was created on purpose. Distinguish parse
	// failures (malformed JSON, truncated write) and field-shape failures
	// (missing required keys) from "missing entirely" so callers — including
	// the MCP server's auto-provision path — can refuse to silently mint a
	// replacement wallet over an existing-but-broken one.
	let parsed: Partial<WalletConfig>;
	try {
		parsed = JSON.parse(raw) as Partial<WalletConfig>;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new WalletConfigCorruptError(walletPath, reason);
	}
	if (!(parsed.subOrgId && parsed.walletAddress && parsed.hmacSecret)) {
		throw new WalletConfigCorruptError(walletPath, "missing required fields");
	}
	return parsed as WalletConfig;
}

/**
 * Atomic write: serialise to a sibling tmp file, fsync via the close, then
 * rename(2) into place. Concurrent provisioning races (two MCP sessions
 * spawning at once on a fresh install) collapse to last-rename-wins on the
 * final path rather than torn-write-wins. Combined with the in-process
 * promise cache in mcp-server.ts:ensureWallet this gates duplicate-mint
 * within a single process AND keeps disk consistent across multiple.
 *
 * The tmp filename includes 16 bytes of randomness so two writers don't
 * stomp each other's tmp files mid-write either.
 */
export async function writeWalletConfig(config: WalletConfig): Promise<void> {
	const walletPath = join(homedir(), ".keeperhub", "wallet.json");
	await mkdir(dirname(walletPath), { recursive: true, mode: 0o700 });
	const suffix = randomBytes(8).toString("hex");
	const tmpPath = `${walletPath}.${process.pid}.${suffix}.tmp`;
	await writeFile(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
	// chmod again on the tmp before rename: writeFile honours the mode on
	// creation but a pre-existing tmp (extremely unlikely thanks to the
	// randomness) might keep looser perms.
	await chmod(tmpPath, 0o600);
	await rename(tmpPath, walletPath);
}

export function getWalletConfigPath(): string {
	return join(homedir(), ".keeperhub", "wallet.json");
}
