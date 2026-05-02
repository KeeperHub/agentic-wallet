// MCP server registration: writes a `keeperhub-wallet` entry into each
// detected agent's MCP config file. Mirrors the patterns in skill-install.ts
// (registerClaudeCodeHook), with two important divergences:
//
//   1. Idempotency is automatic. MCP entries are NAME-keyed objects
//      (`{ mcpServers: { "keeperhub-wallet": {...} } }`), not positional
//      arrays like PreToolUse. Re-running overwrites the existing entry; we
//      never need a de-dup matcher.
//
//   2. The opencode shape is divergent: instead of
//      `{command, args, env}` it stores
//      `{type:"local", command:[command,...args], enabled:true, environment}`
//      under a top-level `mcp` key. We branch on `target.mcpSupport` and
//      write the appropriate shape.
//
// Preservation rule: every other top-level key in the config file MUST be
// byte-preserved. We read the file, parse, mutate only our slot, and write
// back. Same chmod 0o600 semantics as registerClaudeCodeHook.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTarget } from "./agent-detect.js";
import { resolveBinCommand } from "./runtime-detect.js";

const MCP_BIN = "keeperhub-wallet-mcp";

/** The literal name our MCP server registers under. Stable across all agents. */
export const MCP_SERVER_NAME = "keeperhub-wallet";

export type McpCommand = {
	command: string;
	args: string[];
	/** Optional environment overrides. Currently unused but reserved for future flags. */
	env?: Record<string, string>;
};

/**
 * Resolve the MCP launch command. Returns the bare bin if it lives at a
 * stable PATH location, otherwise a version-pinned npx fallback. Identical
 * decision logic to {@link resolveHookCommand} — both flows go through
 * runtime-detect.ts.
 *
 * Override-able via `KEEPERHUB_WALLET_MCP_COMMAND` (env-var input is trusted
 * — it is written verbatim into the MCP config and executed by the agent).
 */
export function resolveMcpCommand(): McpCommand {
	const envOverride = process.env.KEEPERHUB_WALLET_MCP_COMMAND;
	if (envOverride && envOverride.length > 0) {
		// Env override is a single string; split on whitespace into command + args.
		const parts = envOverride.trim().split(/\s+/);
		const head = parts[0] ?? envOverride;
		return { command: head, args: parts.slice(1) };
	}
	const resolved = resolveBinCommand(MCP_BIN);
	return { command: resolved.command, args: resolved.args };
}

export type RegisterMcpServerOptions = {
	/** Override $HOME (tests). */
	homeOverride?: string;
	/** Override the launch command (tests, monorepo setups). */
	command?: McpCommand;
};

export type RegisterMcpServerResult = {
	/** Absolute path of the MCP config file that was written. */
	path: string;
	/** Server name written into the config. */
	name: typeof MCP_SERVER_NAME;
};

type StandardMcpEntry = {
	command: string;
	args: string[];
	env?: Record<string, string>;
};

type StandardMcpConfig = {
	mcpServers?: Record<string, unknown>;
	[k: string]: unknown;
};

type OpencodeMcpEntry = {
	type: "local";
	command: string[];
	enabled: true;
	environment: Record<string, string>;
};

type OpencodeMcpConfig = {
	mcp?: Record<string, unknown>;
	[k: string]: unknown;
};

function buildStandardEntry(cmd: McpCommand): StandardMcpEntry {
	const entry: StandardMcpEntry = {
		command: cmd.command,
		args: cmd.args,
	};
	if (cmd.env && Object.keys(cmd.env).length > 0) {
		entry.env = cmd.env;
	}
	return entry;
}

function buildOpencodeEntry(cmd: McpCommand): OpencodeMcpEntry {
	return {
		type: "local",
		command: [cmd.command, ...cmd.args],
		enabled: true,
		environment: cmd.env ?? {},
	};
}

async function readJsonOrEmpty<T>(path: string): Promise<T> {
	let raw: string | null = null;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw err;
		}
	}
	if (raw === null) {
		return {} as T;
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(
			`MCP config at ${path} is not valid JSON; aborting MCP registration`,
		);
	}
}

async function writeJsonAtomic(path: string, payload: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, payload, { mode: 0o600 });
	await chmod(path, 0o600);
}

async function writeStandardMcp(
	path: string,
	entry: StandardMcpEntry,
): Promise<void> {
	const config = await readJsonOrEmpty<StandardMcpConfig>(path);
	const servers: Record<string, unknown> =
		typeof config.mcpServers === "object" && config.mcpServers !== null
			? (config.mcpServers as Record<string, unknown>)
			: {};
	servers[MCP_SERVER_NAME] = entry;
	config.mcpServers = servers;
	const payload = `${JSON.stringify(config, null, 2)}\n`;
	await writeJsonAtomic(path, payload);
}

async function writeOpencodeMcp(
	path: string,
	entry: OpencodeMcpEntry,
): Promise<void> {
	const config = await readJsonOrEmpty<OpencodeMcpConfig>(path);
	const servers: Record<string, unknown> =
		typeof config.mcp === "object" && config.mcp !== null
			? (config.mcp as Record<string, unknown>)
			: {};
	servers[MCP_SERVER_NAME] = entry;
	config.mcp = servers;
	const payload = `${JSON.stringify(config, null, 2)}\n`;
	await writeJsonAtomic(path, payload);
}

/**
 * Register the keeperhub-wallet MCP server with one detected agent.
 *
 * Behavior by `target.mcpSupport`:
 *  - `claude-code` / `cursor` / `windsurf` — write the standard
 *    `{ mcpServers: { "keeperhub-wallet": {command, args, env?} } }` shape
 *    into the agent's MCP config file. All other top-level keys preserved.
 *  - `opencode` — write the divergent
 *    `{ mcp: { "keeperhub-wallet": {type:"local", command:[...], enabled,
 *    environment} } }` shape.
 *  - `notice` — throws. installSkill handles the notice path before calling
 *    this function.
 *
 * Idempotent by construction: the `keeperhub-wallet` slot is name-keyed, so
 * re-running overwrites rather than duplicates.
 */
export async function registerMcpServer(
	target: AgentTarget,
	options: RegisterMcpServerOptions = {},
): Promise<RegisterMcpServerResult> {
	if (target.mcpSupport === "notice") {
		throw new Error(
			`agent ${target.agent} does not support auto-registered MCP servers; surface a notice instead`,
		);
	}
	if (!target.mcpConfigRel) {
		throw new Error(
			`agent ${target.agent} has mcpSupport=${target.mcpSupport} but no mcpConfigRel path`,
		);
	}
	const home = options.homeOverride ?? homedir();
	const path = join(home, ...target.mcpConfigRel);
	const cmd = options.command ?? resolveMcpCommand();

	if (target.mcpSupport === "opencode") {
		await writeOpencodeMcp(path, buildOpencodeEntry(cmd));
	} else {
		await writeStandardMcp(path, buildStandardEntry(cmd));
	}

	return { path, name: MCP_SERVER_NAME };
}
