// Shared runtime / environment detection used by skill-install (hook
// command resolution) and mcp-register (MCP command resolution).
//
// Why split out: both flows need to decide whether the package's bin lives
// at a stable PATH location (global install, brew, distro pkg, npm link) or
// inside a transient package-runner cache (npx _npx, pnpm dlx, yarn dlx,
// bun x). The bare-bin-vs-npx decision is identical between hook and MCP
// registrations — keep one source of truth so hook and MCP cannot drift.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@keeperhub/wallet";

/**
 * Read this package's own version from package.json. Both the hook and
 * MCP installers pin npx invocations to the installer's version so that
 * upgrades are explicit (re-run skill install) and the supply-chain blast
 * radius is bounded to "code that was already trusted enough to install".
 *
 * Falls back to "latest" only when package.json cannot be located, which
 * should never happen in published builds (dist/ sits next to package.json
 * via pkg.files).
 */
export function readPackageVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
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

/**
 * Detect whether the current process is being driven by `npx`. npm/npx set
 * `npm_execpath` to the path of the CLI binary that spawned the process; for
 * `npx` invocations that path ends in `npx-cli.js` (or, on Windows, an `npx`
 * shim in node_modules/.bin).
 *
 * Why this matters: when the user runs `npx @keeperhub/wallet skill install`,
 * npx prepends its transient cache dir to PATH for the lifetime of the
 * installer. `command -v <bin>` therefore succeeds inside the installer, but
 * the cache dir disappears from PATH the moment npx exits — and any later
 * spawn (hook fire / MCP launch) would crash with `command not found`.
 */
export function isNpxExecution(): boolean {
	const execPath = process.env.npm_execpath;
	if (typeof execPath !== "string" || execPath.length === 0) {
		return false;
	}
	if (/(?:^|[\\/])npx-cli\.(?:js|cjs|mjs)$/i.test(execPath)) {
		return true;
	}
	if (/(?:^|[\\/])npx(?:\.cmd|\.exe|\.ps1)?$/i.test(execPath)) {
		return true;
	}
	return false;
}

// Recognise a path that lives inside any transient package-runner cache.
// Patterns:
//   _npx        — npm/npx cache
//   dlx-<hash>  — pnpm dlx staging
//   xfs-<hash>  — yarn dlx (Berry) temp project
//   .bun/install/cache — bun x / bunx package cache
const TRANSIENT_CACHE_PATTERNS: ReadonlyArray<RegExp> = [
	/[\\/]_npx[\\/]/,
	/[\\/]dlx-[A-Za-z0-9]+[\\/]/,
	/[\\/]xfs-[A-Za-z0-9]+[\\/]/,
	/[\\/]\.bun[\\/]install[\\/]cache[\\/]/,
];

export function isPathUnderTransientCache(resolvedPath: string): boolean {
	for (const re of TRANSIENT_CACHE_PATTERNS) {
		if (re.test(resolvedPath)) {
			return true;
		}
	}
	return false;
}

export type ResolvedCommand = {
	/** The literal string that will be written into settings.json's `command` field. */
	commandString: string;
	/** Split form (command + args[]) for MCP entry shapes that require it. */
	command: string;
	args: string[];
};

/**
 * Resolve a bin name to a stable command form. Returns the bare bin if it
 * lives at a durable PATH location, otherwise a version-pinned npx fallback.
 *
 * The single decision logic is shared between the PreToolUse hook installer
 * and the MCP registration installer.
 */
export function resolveBinCommand(binName: string): ResolvedCommand {
	const version = readPackageVersion();
	const npxArgs = ["-y", "-p", `${PACKAGE_NAME}@${version}`, binName];
	const npxCommandString = `npx ${npxArgs.join(" ")}`;

	if (isNpxExecution()) {
		return {
			commandString: npxCommandString,
			command: "npx",
			args: npxArgs,
		};
	}

	try {
		const resolved = execFileSync("/bin/sh", ["-c", `command -v ${binName}`], {
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
		if (resolved.length > 0 && !isPathUnderTransientCache(resolved)) {
			return {
				commandString: binName,
				command: binName,
				args: [],
			};
		}
	} catch {
		// command -v failed: bin not on PATH at all. Fall through.
	}

	return {
		commandString: npxCommandString,
		command: "npx",
		args: npxArgs,
	};
}
