// Cross-agent skill/settings directory discovery.
//
// Probes canonical paths under $HOME and returns one AgentTarget record per
// agent whose parent directory exists. The `skills/` leaf may be absent --
// installSkill() creates it.
//
// NOTE: `homedir()` is called per-invocation (via `homeOverride ?? homedir()`)
// and NEVER hoisted to a module-level constant. Tests override
// `process.env.HOME` in `beforeEach`; hoisting would freeze the harness's
// original HOME at import time and detection would run against the real $HOME.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentTarget = {
	agent: "claude-code" | "cursor" | "cline" | "windsurf" | "opencode";
	skillsDir: string;
	settingsFile: string;
	hookSupport: "claude-code" | "notice";
	/**
	 * Path-segments under $HOME where the agent stores its MCP server registry.
	 * `undefined` for agents without a known MCP config location (cline today
	 * stores per-VS-Code-variant globalStorage state that is too fragile to
	 * auto-detect, so we ship "notice" instead).
	 */
	mcpConfigRel?: string[];
	/**
	 * Which MCP config shape to write. `claude-code`, `cursor`, and `windsurf`
	 * all use the standard `{ mcpServers: { name: { command, args, env } } }`
	 * shape. `opencode` uses a divergent `{ mcp: { name: { type:"local",
	 * command:[...], enabled, environment } } }` shape. `notice` agents get
	 * a copy-paste hint instead of an auto-registered entry.
	 */
	mcpSupport: "claude-code" | "cursor" | "windsurf" | "opencode" | "notice";
};

type AgentSpec = {
	agent: AgentTarget["agent"];
	skillsRel: string[];
	settingsRel: string[];
	hookSupport: AgentTarget["hookSupport"];
	mcpConfigRel?: string[];
	mcpSupport: AgentTarget["mcpSupport"];
	/**
	 * Optional extra path segments — when present, the agent is detected only
	 * if AT LEAST ONE of `[skillsRel.dirname, ...extraDetect]` exists under
	 * $HOME. Used by windsurf, which keeps state under both `.windsurf/` and
	 * the legacy `.codeium/windsurf/`.
	 */
	extraDetect?: Array<string[]>;
};

// Deterministic order: claude-code first (only agent with hook support),
// then cursor, cline, windsurf, opencode.
const AGENT_SPECS: readonly AgentSpec[] = [
	{
		agent: "claude-code",
		skillsRel: [".claude", "skills"],
		settingsRel: [".claude", "settings.json"],
		hookSupport: "claude-code",
		// ~/.claude.json is at HOME root (not under .claude/) and is large
		// (100+KB on real installs). registerMcpServer reads/parses/rewrites it
		// while preserving every other top-level key byte-for-byte.
		mcpConfigRel: [".claude.json"],
		mcpSupport: "claude-code",
	},
	{
		agent: "cursor",
		skillsRel: [".cursor", "skills"],
		settingsRel: [".cursor", "settings.json"],
		hookSupport: "notice",
		mcpConfigRel: [".cursor", "mcp.json"],
		mcpSupport: "cursor",
	},
	{
		agent: "cline",
		skillsRel: [".cline", "skills"],
		settingsRel: [".cline", "settings.json"],
		hookSupport: "notice",
		// Cline keeps MCP state in a per-VS-Code-variant globalStorage path
		// (e.g. ~/Library/Application Support/Code/User/globalStorage/
		// saoudrizwan.claude-dev/settings/cline_mcp_settings.json) that is too
		// fragile to auto-detect. Ship "notice" with a copy-paste entry shape
		// instead of guessing the variant.
		mcpSupport: "notice",
	},
	{
		agent: "windsurf",
		skillsRel: [".windsurf", "skills"],
		settingsRel: [".windsurf", "settings.json"],
		hookSupport: "notice",
		mcpConfigRel: [".codeium", "windsurf", "mcp_config.json"],
		mcpSupport: "windsurf",
		// Windsurf historically ships under both `.windsurf/` and the legacy
		// `.codeium/windsurf/`; detect either.
		extraDetect: [[".codeium", "windsurf"]],
	},
	{
		agent: "opencode",
		skillsRel: [".config", "opencode", "skills"],
		settingsRel: [".config", "opencode", "settings.json"],
		hookSupport: "notice",
		mcpConfigRel: [".config", "opencode", "opencode.json"],
		mcpSupport: "opencode",
	},
];

export function detectAgents(homeOverride?: string): AgentTarget[] {
	const home = homeOverride ?? homedir();
	const results: AgentTarget[] = [];
	for (const spec of AGENT_SPECS) {
		const skillsDir = join(home, ...spec.skillsRel);
		const settingsFile = join(home, ...spec.settingsRel);
		// "Detected" iff the parent of skills/ exists (e.g. ~/.claude/) OR any
		// of the spec's extra-detect paths exist (windsurf's legacy location).
		let detected = existsSync(dirname(skillsDir));
		if (!detected && spec.extraDetect) {
			for (const seg of spec.extraDetect) {
				if (existsSync(join(home, ...seg))) {
					detected = true;
					break;
				}
			}
		}
		if (!detected) {
			continue;
		}
		results.push({
			agent: spec.agent,
			skillsDir,
			settingsFile,
			hookSupport: spec.hookSupport,
			mcpConfigRel: spec.mcpConfigRel,
			mcpSupport: spec.mcpSupport,
		});
	}
	return results;
}
