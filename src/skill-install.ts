// Idempotent skill installer for @keeperhub/wallet.
//
// Two public entry points:
//   - installSkill(options?) -- writes keeperhub-wallet.skill.md into every
//     detected agent's skills directory and, for Claude Code, registers a
//     PreToolUse hook pointing at `keeperhub-wallet-hook` in
//     ~/.claude/settings.json. For non-claude agents, emits a stderr notice.
//   - registerClaudeCodeHook(settingsPath, options?) -- pure settings.json
//     patcher used internally; exported so tests can drive it directly.
//
// Hook command resolution: the README's recommended install path is
// `npx @keeperhub/wallet skill install`, which does not put the bin on the
// system PATH. If we wrote a bare `keeperhub-wallet-hook` command in that
// case, the hook would fire `command not found` on every tool call. So at
// install time we probe PATH; if the bin resolves we keep the bare command
// (lowest startup latency), otherwise we fall back to an `npx` invocation
// that resolves regardless of where future shells run.
//
// Idempotency rule: re-running the installer MUST NOT create a duplicate
// hook entry. We filter any existing array element whose serialised form
// contains `keeperhub-wallet-hook` before appending a single fresh record.
// The marker substring is present in BOTH the bare and npx forms, so the
// de-dup survives a global-install → npx-install transition (and back).
//
// Preservation rule: all top-level keys in settings.json other than
// hooks.PreToolUse MUST be byte-preserved. We only ever touch
// hooks.PreToolUse; any foreign hooks.PostToolUse entries survive verbatim.

import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentTarget, detectAgents } from "./agent-detect.js";
import {
	type RegisterMcpServerOptions,
	registerMcpServer,
	resolveMcpCommand,
} from "./mcp-register.js";
import { resolveBinCommand } from "./runtime-detect.js";

const HOOK_BIN = "keeperhub-wallet-hook";

// Match rule for de-dup: any existing PreToolUse entry whose `command`
// string contains this substring is considered "ours" and is removed
// before append. The marker is present in BOTH the bare and pinned-npx
// forms, so the de-dup survives a global-install <-> npx-install
// transition (and across version bumps).
//
// Why match on the `command` field rather than JSON.stringify(entry):
// the wider marker would silently delete an unrelated hook whose args
// or matcher happen to mention the bin name (e.g. a logger). Scoping
// to `command` is narrower and equally idempotent for our writes since
// we always write the marker into `command`.
const KEEPERHUB_HOOK_MARKER = HOOK_BIN;

type PreToolUseLikeEntry = {
	hooks?: Array<{ command?: unknown }>;
};

/**
 * Drop only the `hooks[]` items that reference the keeperhub bin, leaving
 * sibling commands inside the same `PreToolUse` element intact. Returns
 * the (possibly modified) entry, or null when every `hooks[]` item was
 * keeperhub-related and the whole element should be removed.
 *
 * Why per-item: a user may merge our hook into a single `PreToolUse`
 * element alongside their own commands, e.g.:
 *
 *   { matcher: "*", hooks: [
 *       { type: "command", command: "/usr/local/bin/audit-logger" },
 *       { type: "command", command: "keeperhub-wallet-hook" } ] }
 *
 * Dropping the whole element on re-install would silently delete the
 * audit-logger sibling. Dropping only matching items preserves it.
 *
 * Non-object entries and entries without a `hooks[]` array are returned
 * unchanged — we never inspect or mutate shapes we don't recognise.
 */
function filterKeeperhubHooksFromEntry(entry: unknown): unknown {
	if (typeof entry !== "object" || entry === null) {
		return entry;
	}
	const candidate = entry as PreToolUseLikeEntry;
	if (!Array.isArray(candidate.hooks)) {
		return entry;
	}
	const survivors = candidate.hooks.filter((h) => {
		const cmd = h?.command;
		return !(typeof cmd === "string" && cmd.includes(KEEPERHUB_HOOK_MARKER));
	});
	if (survivors.length === candidate.hooks.length) {
		// No keeperhub hooks present in this entry — return original byte-for-byte.
		return entry;
	}
	if (survivors.length === 0) {
		// Every hook in this element was ours; drop the whole element so we
		// don't leave a `{matcher, hooks: []}` shell behind.
		return null;
	}
	return { ...candidate, hooks: survivors };
}

/**
 * Pick the hook command to write into settings.json.
 *
 * Returns the bare bin name if it resolves to a STABLE install on PATH
 * (global install, brew, distro pkg, dev-time `npm link`), otherwise a
 * version-pinned `npx` invocation that pulls the installer's own version
 * of `@keeperhub/wallet` on demand. Implementation lives in
 * runtime-detect.ts so the hook + MCP installers share a single decision.
 *
 * Override-able via the env var `KEEPERHUB_WALLET_HOOK_COMMAND` for test
 * fixtures and unusual deployments (env input is trusted — it is written
 * verbatim into settings.json and executed by the user's shell).
 */
export function resolveHookCommand(): string {
	const envOverride = process.env.KEEPERHUB_WALLET_HOOK_COMMAND;
	if (envOverride && envOverride.length > 0) {
		return envOverride;
	}
	return resolveBinCommand(HOOK_BIN).commandString;
}

export type InstallResult = {
	skillWrites: Array<{
		agent: string;
		path: string;
		status: "written" | "skipped";
	}>;
	hookRegistrations: Array<{
		agent: string;
		status: "registered" | "notice" | "skipped" | "failed";
		message?: string;
	}>;
	mcpRegistrations: Array<{
		agent: string;
		status: "registered" | "notice" | "skipped" | "failed";
		path?: string;
		message?: string;
	}>;
};

export type InstallOptions = {
	homeOverride?: string;
	skillSourcePath?: string;
	onNotice?: (msg: string) => void;
	/**
	 * Hook command to write into settings.json (and reference in stderr
	 * notices for non-Claude agents). Defaults to {@link resolveHookCommand}.
	 * Override for tests, monorepo setups, or unusual deployments.
	 */
	hookCommand?: string;
	/**
	 * MCP command + args to register with each detected agent. Defaults to
	 * {@link resolveMcpCommand}. Tests pass an explicit value to pin
	 * assertions regardless of host PATH.
	 */
	mcpCommand?: RegisterMcpServerOptions["command"];
};

export type RegisterClaudeCodeHookOptions = {
	/**
	 * Hook command to write. Defaults to {@link resolveHookCommand}. Tests
	 * pass a deterministic value to keep assertions stable across host
	 * environments (CI may or may not have the bin on PATH).
	 */
	hookCommand?: string;
};

type ClaudeHookEntry = {
	matcher: string;
	hooks: Array<{ type: string; command: string }>;
};

type ClaudeSettings = {
	hooks?: {
		PreToolUse?: unknown[];
		[k: string]: unknown;
	};
	[k: string]: unknown;
};

function buildKeeperhubEntry(command: string): ClaudeHookEntry {
	return {
		matcher: "*",
		hooks: [{ type: "command", command }],
	};
}

function resolveDefaultSkillSource(): string {
	// Resolve the module's own directory in a way that works in both ESM
	// (import.meta.url) and CJS (__dirname shim emitted by tsup). At runtime
	// the module lives inside dist/, so `../skill/` points at the sibling
	// skill/ directory shipped via pkg.files. During vitest tests the module
	// executes from src/, and `../skill/` resolves to packages/wallet/skill/.
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "skill", "keeperhub-wallet.skill.md");
}

function defaultNotice(msg: string): void {
	process.stderr.write(`${msg}\n`);
}

export async function registerClaudeCodeHook(
	settingsPath: string,
	options: RegisterClaudeCodeHookOptions = {},
): Promise<void> {
	const command = options.hookCommand ?? resolveHookCommand();

	let raw: string | null = null;
	try {
		raw = await readFile(settingsPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw err;
		}
	}

	let config: ClaudeSettings = {};
	if (raw !== null) {
		try {
			config = JSON.parse(raw) as ClaudeSettings;
		} catch {
			throw new Error(
				`settings.json at ${settingsPath} is not valid JSON; aborting hook registration`,
			);
		}
	}

	const hooks: Record<string, unknown> =
		typeof config.hooks === "object" && config.hooks !== null
			? (config.hooks as Record<string, unknown>)
			: {};

	const existingPreToolUse = Array.isArray(hooks.PreToolUse)
		? (hooks.PreToolUse as unknown[])
		: [];

	// De-dup: drop only the hooks[] items whose `command` field references
	// the keeperhub-wallet-hook bin, leaving sibling commands within the
	// same PreToolUse element untouched. Scoped to the `command` field (not
	// the full serialised entry) so an unrelated hook that mentions the bin
	// name in its matcher or args isn't silently deleted. Covers both the
	// bare-bin and version-pinned npx forms, and older versions of this
	// installer.
	const filtered: unknown[] = [];
	for (const entry of existingPreToolUse) {
		const survivor = filterKeeperhubHooksFromEntry(entry);
		if (survivor !== null) {
			filtered.push(survivor);
		}
	}
	filtered.push(buildKeeperhubEntry(command));

	hooks.PreToolUse = filtered;
	config.hooks = hooks as ClaudeSettings["hooks"];

	await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 });
	const payload = `${JSON.stringify(config, null, 2)}\n`;
	await writeFile(settingsPath, payload, { mode: 0o600 });
	// Reassert mode in case the file already existed with looser perms.
	await chmod(settingsPath, 0o600);
}

async function writeSkillToAgent(
	agent: AgentTarget,
	skillSource: string,
): Promise<{ agent: string; path: string; status: "written" | "skipped" }> {
	await mkdir(agent.skillsDir, { recursive: true, mode: 0o755 });
	const target = join(agent.skillsDir, "keeperhub-wallet.skill.md");
	await copyFile(skillSource, target);
	await chmod(target, 0o644);
	return { agent: agent.agent, path: target, status: "written" };
}

function buildHookNoticeMessage(agent: AgentTarget, command: string): string {
	return `${agent.agent} does not support auto-registered PreToolUse hooks; run \`${command}\` on every tool use via ${agent.agent}'s settings file at ${agent.settingsFile}`;
}

function buildMcpNoticeMessage(
	agent: AgentTarget,
	command: { command: string; args: string[] },
): string {
	const cmd = [command.command, ...command.args].join(" ");
	return `${agent.agent} does not support auto-registered MCP servers; add an entry named \`keeperhub-wallet\` running \`${cmd}\` to your MCP config manually`;
}

/**
 * Install the keeperhub-wallet skill plus the PreToolUse safety hook plus
 * the keeperhub-wallet MCP server into every detected agent.
 *
 * Per-agent flow:
 *  1. Copy `keeperhub-wallet.skill.md` into the agent's `skills/` dir.
 *  2. If the agent supports PreToolUse hooks (claude-code), register the
 *     safety hook in `settings.json`. Otherwise print a stderr notice.
 *  3. If the agent supports MCP server registration (claude-code, cursor,
 *     windsurf, opencode), register the keeperhub-wallet MCP server in the
 *     agent's MCP config file (claude.json / mcp.json / opencode.json).
 *     Otherwise print a stderr notice.
 *
 * MCP idempotency is automatic: each agent's MCP config keys servers by name,
 * so a re-run overwrites the existing `keeperhub-wallet` entry rather than
 * appending a duplicate. All other keys are byte-preserved.
 */
export async function installSkill(
	options: InstallOptions = {},
): Promise<InstallResult> {
	const agents = detectAgents(options.homeOverride);
	const skillSource = options.skillSourcePath ?? resolveDefaultSkillSource();
	const onNotice = options.onNotice ?? defaultNotice;
	// Resolve once per install run so the bare-vs-npx decision stays
	// consistent across every detected agent. Tests pass an explicit value to
	// pin the assertion shape regardless of host PATH.
	const hookCommand = options.hookCommand ?? resolveHookCommand();
	const mcpCommand = options.mcpCommand ?? resolveMcpCommand();

	const skillWrites: InstallResult["skillWrites"] = [];
	const hookRegistrations: InstallResult["hookRegistrations"] = [];
	const mcpRegistrations: InstallResult["mcpRegistrations"] = [];

	// Per-agent error isolation. A single agent's settings file being
	// permission-locked or otherwise unwritable used to abort the whole
	// install loop with a raw stack trace, leaving the user in a partial
	// state (skill copied, hook maybe registered, MCP maybe not) and
	// without a returned `InstallResult` to inspect. Catch at the per-step
	// boundary so the loop completes for every agent and the caller gets
	// a structured `failed` entry with the error message.
	for (const agent of agents) {
		try {
			const write = await writeSkillToAgent(agent, skillSource);
			skillWrites.push(write);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			skillWrites.push({
				agent: agent.agent,
				path: "",
				status: "skipped",
			});
			onNotice(`${agent.agent}: skill copy failed (${message})`);
			// If we couldn't even write the skill, the rest of the agent's
			// install is meaningless. Skip to the next agent.
			continue;
		}

		if (agent.hookSupport === "claude-code") {
			try {
				await registerClaudeCodeHook(agent.settingsFile, { hookCommand });
				hookRegistrations.push({
					agent: agent.agent,
					status: "registered",
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				hookRegistrations.push({
					agent: agent.agent,
					status: "failed",
					message,
				});
				onNotice(`${agent.agent}: hook registration failed (${message})`);
			}
		} else {
			const noticeMessage = buildHookNoticeMessage(agent, hookCommand);
			hookRegistrations.push({
				agent: agent.agent,
				status: "notice",
				message: noticeMessage,
			});
			onNotice(noticeMessage);
		}

		if (agent.mcpSupport === "notice") {
			const noticeMessage = buildMcpNoticeMessage(agent, mcpCommand);
			mcpRegistrations.push({
				agent: agent.agent,
				status: "notice",
				message: noticeMessage,
			});
			onNotice(noticeMessage);
			continue;
		}
		try {
			const mcpResult = await registerMcpServer(agent, {
				homeOverride: options.homeOverride,
				command: mcpCommand,
			});
			mcpRegistrations.push({
				agent: agent.agent,
				status: "registered",
				path: mcpResult.path,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			mcpRegistrations.push({
				agent: agent.agent,
				status: "failed",
				message,
			});
			onNotice(`${agent.agent}: MCP registration failed (${message})`);
		}
	}

	return { skillWrites, hookRegistrations, mcpRegistrations };
}
