// Idempotent skill installer for @keeperhub/wallet.
//
// Two public entry points:
//   - installSkill(options?) -- writes keeperhub-wallet.skill.md into every
//     detected agent's skills directory and, for Claude Code, registers a
//     PreToolUse hook pointing at `keeperhub-wallet-hook` in
//     ~/.claude/settings.json. For non-claude agents, emits a stderr notice.
//   - registerClaudeCodeHook(settingsPath) -- pure settings.json patcher
//     used internally; exported so tests can drive it directly.
//
// Idempotency rule: re-running the installer MUST NOT create a duplicate
// hook entry. We filter any existing array element whose serialised form
// contains `keeperhub-wallet-hook` before appending a single fresh record.
//
// Preservation rule: all top-level keys in settings.json other than
// hooks.PreToolUse MUST be byte-preserved. We only ever touch
// hooks.PreToolUse; any foreign hooks.PostToolUse entries survive verbatim.

import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentTarget, detectAgents } from "./agent-detect.js";

const HOOK_COMMAND = "keeperhub-wallet-hook";
// Match rule for de-dup: any existing PreToolUse entry whose JSON form
// mentions this string is considered "ours" and is removed before append.
const KEEPERHUB_HOOK_MARKER = "keeperhub-wallet-hook";

export type InstallResult = {
  skillWrites: Array<{
    agent: string;
    path: string;
    status: "written" | "skipped";
  }>;
  hookRegistrations: Array<{
    agent: string;
    status: "registered" | "notice" | "skipped";
    message?: string;
  }>;
};

export type InstallOptions = {
  homeOverride?: string;
  skillSourcePath?: string;
  onNotice?: (msg: string) => void;
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

function buildKeeperhubEntry(): ClaudeHookEntry {
  return {
    matcher: "*",
    hooks: [{ type: "command", command: HOOK_COMMAND }],
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
  settingsPath: string
): Promise<void> {
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
        `settings.json at ${settingsPath} is not valid JSON; aborting hook registration`
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

  // De-dup: drop any element that references keeperhub-wallet-hook in its
  // serialised form. Covers both exact-shape matches and any legacy
  // representations we may have written in earlier versions.
  const filtered: unknown[] = [];
  for (const entry of existingPreToolUse) {
    const serialised = JSON.stringify(entry);
    if (!serialised.includes(KEEPERHUB_HOOK_MARKER)) {
      filtered.push(entry);
    }
  }
  filtered.push(buildKeeperhubEntry());

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
  skillSource: string
): Promise<{ agent: string; path: string; status: "written" | "skipped" }> {
  await mkdir(agent.skillsDir, { recursive: true, mode: 0o755 });
  const target = join(agent.skillsDir, "keeperhub-wallet.skill.md");
  await copyFile(skillSource, target);
  await chmod(target, 0o644);
  return { agent: agent.agent, path: target, status: "written" };
}

function buildNoticeMessage(agent: AgentTarget): string {
  return `${agent.agent} does not support auto-registered PreToolUse hooks; run \`${HOOK_COMMAND}\` on every tool use via ${agent.agent}'s settings file at ${agent.settingsFile}`;
}

export async function installSkill(
  options: InstallOptions = {}
): Promise<InstallResult> {
  const agents = detectAgents(options.homeOverride);
  const skillSource = options.skillSourcePath ?? resolveDefaultSkillSource();
  const onNotice = options.onNotice ?? defaultNotice;

  const skillWrites: InstallResult["skillWrites"] = [];
  const hookRegistrations: InstallResult["hookRegistrations"] = [];

  for (const agent of agents) {
    const write = await writeSkillToAgent(agent, skillSource);
    skillWrites.push(write);

    if (agent.hookSupport === "claude-code") {
      await registerClaudeCodeHook(agent.settingsFile);
      hookRegistrations.push({
        agent: agent.agent,
        status: "registered",
      });
    } else {
      const message = buildNoticeMessage(agent);
      hookRegistrations.push({
        agent: agent.agent,
        status: "notice",
        message,
      });
      onNotice(message);
    }
  }

  return { skillWrites, hookRegistrations };
}
