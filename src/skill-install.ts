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

import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentTarget, detectAgents } from "./agent-detect.js";

const HOOK_BIN = "keeperhub-wallet-hook";
const HOOK_COMMAND_BARE = HOOK_BIN;
const PACKAGE_NAME = "@keeperhub/wallet";

/**
 * Read the installer's own version from package.json so the npx command
 * pins to it. Pinning matters because `npx -y` would otherwise pull
 * `latest` on every PreToolUse hook fire — any future compromise of the
 * `@keeperhub/wallet` scope on the npm registry would be executed on
 * every tool call by every npx-installed user. Pinning to the version
 * shipped at install time makes upgrades explicit (re-run skill install)
 * and bounds the supply-chain blast radius to "code that was already
 * trusted enough to install".
 *
 * Falls back to "latest" only if package.json cannot be located, which
 * should never happen in published builds (dist/ sits next to package.json
 * via pkg.files). The fallback exists so test runs from src/ — where the
 * resolution path is `here/../package.json` — never crash the installer.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Module lives in dist/ at runtime and src/ during tests; in both cases
    // package.json is one level up.
    const pkgPath = join(here, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through.
  }
  return "latest";
}

function buildNpxCommand(version: string): string {
  return `npx -y -p ${PACKAGE_NAME}@${version} ${HOOK_BIN}`;
}

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

function entryReferencesKeeperhubHook(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const candidate = entry as PreToolUseLikeEntry;
  const hooks = Array.isArray(candidate.hooks) ? candidate.hooks : [];
  for (const h of hooks) {
    const cmd = h?.command;
    if (typeof cmd === "string" && cmd.includes(KEEPERHUB_HOOK_MARKER)) {
      return true;
    }
  }
  return false;
}

/**
 * Pick the hook command to write into settings.json.
 *
 * Returns the bare bin name if it resolves on PATH (global install or a
 * dev-time `npm link`), otherwise a version-pinned `npx` invocation that
 * pulls the installer's own version of `@keeperhub/wallet` on demand.
 * Override-able via the env var `KEEPERHUB_WALLET_HOOK_COMMAND` for
 * test fixtures and unusual deployments (env input is trusted — it is
 * written verbatim into settings.json and executed by the user's shell).
 */
export function resolveHookCommand(): string {
  const envOverride = process.env.KEEPERHUB_WALLET_HOOK_COMMAND;
  if (envOverride && envOverride.length > 0) {
    return envOverride;
  }
  try {
    // `command -v` is POSIX and avoids spawning a full shell; stdio is
    // ignored because we only care about the exit code.
    execFileSync("/bin/sh", ["-c", `command -v ${HOOK_BIN}`], {
      stdio: "ignore",
    });
    return HOOK_COMMAND_BARE;
  } catch {
    return buildNpxCommand(readPackageVersion());
  }
}

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
  /**
   * Hook command to write into settings.json (and reference in stderr
   * notices for non-Claude agents). Defaults to {@link resolveHookCommand}.
   * Override for tests, monorepo setups, or unusual deployments.
   */
  hookCommand?: string;
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
  options: RegisterClaudeCodeHookOptions = {}
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

  // De-dup: drop any element whose command field references the
  // keeperhub-wallet-hook bin. Scoped to the `command` field (not the full
  // serialised entry) so an unrelated hook that mentions the bin name in
  // its matcher or args isn't silently deleted. Covers both the bare-bin
  // and version-pinned npx forms, and older versions of this installer.
  const filtered: unknown[] = [];
  for (const entry of existingPreToolUse) {
    if (!entryReferencesKeeperhubHook(entry)) {
      filtered.push(entry);
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
  skillSource: string
): Promise<{ agent: string; path: string; status: "written" | "skipped" }> {
  await mkdir(agent.skillsDir, { recursive: true, mode: 0o755 });
  const target = join(agent.skillsDir, "keeperhub-wallet.skill.md");
  await copyFile(skillSource, target);
  await chmod(target, 0o644);
  return { agent: agent.agent, path: target, status: "written" };
}

function buildNoticeMessage(agent: AgentTarget, command: string): string {
  return `${agent.agent} does not support auto-registered PreToolUse hooks; run \`${command}\` on every tool use via ${agent.agent}'s settings file at ${agent.settingsFile}`;
}

export async function installSkill(
  options: InstallOptions = {}
): Promise<InstallResult> {
  const agents = detectAgents(options.homeOverride);
  const skillSource = options.skillSourcePath ?? resolveDefaultSkillSource();
  const onNotice = options.onNotice ?? defaultNotice;
  // Resolve once per install run so the bare-vs-npx decision stays
  // consistent across every detected agent. Tests pass an explicit value to
  // pin the assertion shape regardless of host PATH.
  const hookCommand = options.hookCommand ?? resolveHookCommand();

  const skillWrites: InstallResult["skillWrites"] = [];
  const hookRegistrations: InstallResult["hookRegistrations"] = [];

  for (const agent of agents) {
    const write = await writeSkillToAgent(agent, skillSource);
    skillWrites.push(write);

    if (agent.hookSupport === "claude-code") {
      await registerClaudeCodeHook(agent.settingsFile, { hookCommand });
      hookRegistrations.push({
        agent: agent.agent,
        status: "registered",
      });
    } else {
      const message = buildNoticeMessage(agent, hookCommand);
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
