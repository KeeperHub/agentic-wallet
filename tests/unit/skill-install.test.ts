// Unit tests for skill-install.ts.
//
// Covers:
// - registerClaudeCodeHook: creates file (0o600) when missing, is idempotent
//   across two invocations, preserves foreign keys, rejects malformed JSON
// - installSkill: copies skill bytes into every detected skillsDir and
//   emits notices for non-Claude agents without touching their settings.
// - resolveHookCommand: env override beats PATH probe; PATH-not-found
//   falls back to npx; previously-written hook entries (regardless of
//   command form) are de-duped on re-install.
//
// Test isolation: every test that calls registerClaudeCodeHook or
// installSkill passes an explicit `hookCommand` so assertions stay stable
// whether or not CI happens to have @keeperhub/wallet on PATH.

import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installSkill,
	registerClaudeCodeHook,
	resolveHookCommand,
} from "../../src/skill-install.js";

const TEST_HOOK_COMMAND = "keeperhub-wallet-hook";
const TEST_NPX_COMMAND =
	"npx -y -p @keeperhub/wallet@9.9.9-test keeperhub-wallet-hook";

type PreToolUseEntry = {
	matcher: string;
	hooks: Array<{ type: string; command: string }>;
};

type SettingsShape = {
	mcpServers?: { [k: string]: { command: string; args: unknown[] } };
	theme?: string;
	telemetry?: boolean;
	custom?: { nested: string };
	hooks?: {
		PreToolUse?: PreToolUseEntry[];
		PostToolUse?: PreToolUseEntry[];
	};
};

const NOT_VALID_JSON_RE = /not valid JSON/;

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	fakeHome = await mkdtemp(join(tmpdir(), "kh-skill-install-"));
	process.env.HOME = fakeHome;
	await mkdir(join(fakeHome, ".claude"), { recursive: true });
	await mkdir(join(fakeHome, ".cursor"), { recursive: true });
});

afterEach(async () => {
	process.env.HOME = originalHome;
	await rm(fakeHome, { recursive: true, force: true });
});

describe("registerClaudeCodeHook()", () => {
	it("creates settings.json with mode 0o600 and one PreToolUse entry when missing", async () => {
		const settingsPath = join(fakeHome, ".claude", "settings.json");
		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_HOOK_COMMAND,
		});

		const st = await stat(settingsPath);
		expect(st.mode & 0o777).toBe(0o600);

		const raw = await readFile(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as SettingsShape;
		expect(parsed.hooks?.PreToolUse).toHaveLength(1);
		expect(parsed.hooks?.PreToolUse?.[0].matcher).toBe("*");
		expect(parsed.hooks?.PreToolUse?.[0].hooks[0].command).toBe(
			TEST_HOOK_COMMAND,
		);
	});

	it("is idempotent: two invocations produce exactly one hook entry", async () => {
		const settingsPath = join(fakeHome, ".claude", "settings.json");
		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_HOOK_COMMAND,
		});
		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_HOOK_COMMAND,
		});

		const raw = await readFile(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as SettingsShape;
		expect(parsed.hooks?.PreToolUse).toHaveLength(1);
		expect(parsed.hooks?.PreToolUse?.[0].hooks[0].command).toBe(
			TEST_HOOK_COMMAND,
		);
	});

	it("preserves 5 pre-existing top-level keys including hooks.PostToolUse", async () => {
		const settingsPath = join(fakeHome, ".claude", "settings.json");
		const seed = {
			mcpServers: {
				"existing-mcp": { command: "foo", args: [] },
			},
			theme: "dark",
			telemetry: false,
			custom: { nested: "value" },
			hooks: {
				PostToolUse: [
					{
						matcher: "*",
						hooks: [{ type: "command", command: "other-hook" }],
					},
				],
			},
		};
		await writeFile(settingsPath, JSON.stringify(seed, null, 2));

		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_HOOK_COMMAND,
		});

		const raw = await readFile(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as SettingsShape;

		expect(parsed.mcpServers).toEqual(seed.mcpServers);
		expect(parsed.theme).toBe("dark");
		expect(parsed.telemetry).toBe(false);
		expect(parsed.custom?.nested).toBe("value");
		expect(parsed.hooks?.PostToolUse).toEqual(seed.hooks.PostToolUse);
		expect(parsed.hooks?.PreToolUse).toHaveLength(1);
		expect(parsed.hooks?.PreToolUse?.[0].hooks[0].command).toBe(
			TEST_HOOK_COMMAND,
		);
	});

	it("throws on malformed JSON and leaves disk bytes unchanged", async () => {
		const settingsPath = join(fakeHome, ".claude", "settings.json");
		const bogus = "{ not valid json";
		await writeFile(settingsPath, bogus);
		const before = await readFile(settingsPath, "utf-8");

		await expect(
			registerClaudeCodeHook(settingsPath, {
				hookCommand: TEST_HOOK_COMMAND,
			}),
		).rejects.toThrow(NOT_VALID_JSON_RE);

		const after = await readFile(settingsPath, "utf-8");
		expect(after).toBe(before);
	});

	it("writes the npx form when the resolver returns it (simulates non-global install)", async () => {
		const settingsPath = join(fakeHome, ".claude", "settings.json");
		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_NPX_COMMAND,
		});

		const raw = await readFile(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as SettingsShape;
		expect(parsed.hooks?.PreToolUse?.[0].hooks[0].command).toBe(
			TEST_NPX_COMMAND,
		);
	});

	it("de-dups across bare-vs-npx command transitions on re-install", async () => {
		// Simulate a user who first installed globally (bare command) and then
		// re-ran via npx: the second register call must REPLACE the first
		// entry, not append a duplicate.
		const settingsPath = join(fakeHome, ".claude", "settings.json");
		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_HOOK_COMMAND,
		});
		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_NPX_COMMAND,
		});

		const raw = await readFile(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as SettingsShape;
		expect(parsed.hooks?.PreToolUse).toHaveLength(1);
		expect(parsed.hooks?.PreToolUse?.[0].hooks[0].command).toBe(
			TEST_NPX_COMMAND,
		);
	});

	it("preserves an unrelated hook whose matcher mentions the bin name", async () => {
		// Reviewer 2 finding: scoping de-dup to the `command` field avoids
		// silently deleting a foreign hook whose matcher (or other non-command
		// metadata) happens to mention "keeperhub-wallet-hook". Only hooks
		// whose `command` references the bin should be replaced.
		//
		// Seed a foreign entry where the bin name appears ONLY in the matcher
		// string. Under the previous JSON-stringify marker this would be
		// wiped; under the new command-scoped marker it must survive.
		const settingsPath = join(fakeHome, ".claude", "settings.json");
		const foreignCommand = "/usr/local/bin/audit-logger --kind=pretool";
		const seed = {
			hooks: {
				PreToolUse: [
					{
						// Matcher includes the bin name as a tag — purely metadata,
						// not a reference to our installed hook command. The command
						// itself is unrelated and must survive re-install.
						matcher: "Bash:keeperhub-wallet-hook-pretool",
						hooks: [{ type: "command", command: foreignCommand }],
					},
				],
			},
		};
		await writeFile(settingsPath, JSON.stringify(seed, null, 2));

		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_HOOK_COMMAND,
		});

		const raw = await readFile(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as SettingsShape;
		// Both entries must coexist — the foreign one and ours.
		expect(parsed.hooks?.PreToolUse).toHaveLength(2);
		const commands = parsed.hooks?.PreToolUse?.map((e) => e.hooks[0].command);
		expect(commands).toContain(foreignCommand);
		expect(commands).toContain(TEST_HOOK_COMMAND);
	});

	it("still de-dups when the foreign-looking entry has the bin in its actual command", async () => {
		// Inverse of the previous test: if a previous installer wrote the
		// bin name into `command` (the only place we care about), it MUST
		// be replaced regardless of matcher or other fields.
		const settingsPath = join(fakeHome, ".claude", "settings.json");
		const seed = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ type: "command", command: "/old/path/keeperhub-wallet-hook" },
						],
					},
				],
			},
		};
		await writeFile(settingsPath, JSON.stringify(seed, null, 2));

		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_HOOK_COMMAND,
		});

		const raw = await readFile(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as SettingsShape;
		expect(parsed.hooks?.PreToolUse).toHaveLength(1);
		expect(parsed.hooks?.PreToolUse?.[0].hooks[0].command).toBe(
			TEST_HOOK_COMMAND,
		);
	});

	it("preserves foreign sibling hooks[] inside the same PreToolUse element on re-install", async () => {
		// Reviewer follow-up: if a user merged our hook into an existing
		// PreToolUse element so it lives alongside their own commands,
		// dropping the whole element on re-install would silently delete
		// their unrelated sibling. Filter only the matching hooks[] items,
		// leaving siblings intact.
		const settingsPath = join(fakeHome, ".claude", "settings.json");
		const auditCommand = "/usr/local/bin/audit-logger --on=pretool";
		const seed = {
			hooks: {
				PreToolUse: [
					{
						matcher: "*",
						hooks: [
							{ type: "command", command: auditCommand },
							{ type: "command", command: "/old/path/keeperhub-wallet-hook" },
						],
					},
				],
			},
		};
		await writeFile(settingsPath, JSON.stringify(seed, null, 2));

		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_HOOK_COMMAND,
		});

		const raw = await readFile(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as SettingsShape;
		// Original element keeps its foreign sibling and loses our old hook;
		// a new element carrying our refreshed hook is appended.
		expect(parsed.hooks?.PreToolUse).toHaveLength(2);
		const surviving = parsed.hooks?.PreToolUse?.[0];
		expect(surviving?.matcher).toBe("*");
		expect(surviving?.hooks).toHaveLength(1);
		expect(surviving?.hooks[0].command).toBe(auditCommand);
		const ours = parsed.hooks?.PreToolUse?.[1];
		expect(ours?.hooks[0].command).toBe(TEST_HOOK_COMMAND);
	});

	it("drops the whole PreToolUse element only when every hooks[] item was ours", async () => {
		// Mirror case: when there are NO surviving siblings, the now-empty
		// shell {matcher, hooks: []} must not be left behind.
		const settingsPath = join(fakeHome, ".claude", "settings.json");
		const seed = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ type: "command", command: "/old/path/keeperhub-wallet-hook" },
							{
								type: "command",
								command:
									"npx -y -p @keeperhub/wallet@0.1.7 keeperhub-wallet-hook",
							},
						],
					},
				],
			},
		};
		await writeFile(settingsPath, JSON.stringify(seed, null, 2));

		await registerClaudeCodeHook(settingsPath, {
			hookCommand: TEST_HOOK_COMMAND,
		});

		const raw = await readFile(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as SettingsShape;
		// Original element fully dropped; only the freshly-appended one remains.
		expect(parsed.hooks?.PreToolUse).toHaveLength(1);
		expect(parsed.hooks?.PreToolUse?.[0].hooks[0].command).toBe(
			TEST_HOOK_COMMAND,
		);
	});
});

describe("resolveHookCommand()", () => {
	let originalEnv: string | undefined;
	let originalPath: string | undefined;
	let originalNpmExecPath: string | undefined;

	beforeEach(() => {
		originalEnv = process.env.KEEPERHUB_WALLET_HOOK_COMMAND;
		originalPath = process.env.PATH;
		originalNpmExecPath = process.env.npm_execpath;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.KEEPERHUB_WALLET_HOOK_COMMAND;
		} else {
			process.env.KEEPERHUB_WALLET_HOOK_COMMAND = originalEnv;
		}
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		if (originalNpmExecPath === undefined) {
			delete process.env.npm_execpath;
		} else {
			process.env.npm_execpath = originalNpmExecPath;
		}
	});

	// Helper: create an executable stub at <dir>/keeperhub-wallet-hook so a
	// PATH probe via `command -v` succeeds. Returns the directory holding the
	// stub so callers can prepend it to PATH.
	async function seedHookStub(rootDir: string): Promise<string> {
		await mkdir(rootDir, { recursive: true });
		const binPath = join(rootDir, "keeperhub-wallet-hook");
		await writeFile(binPath, "#!/bin/sh\nexit 0\n");
		await chmod(binPath, 0o755);
		return rootDir;
	}

	it("honours KEEPERHUB_WALLET_HOOK_COMMAND env override before probing PATH", () => {
		const sentinel = "/opt/custom/bin/keeperhub-wallet-hook --flag";
		process.env.KEEPERHUB_WALLET_HOOK_COMMAND = sentinel;
		expect(resolveHookCommand()).toBe(sentinel);
	});

	it("ignores an empty env override and falls through to PATH probe", () => {
		process.env.KEEPERHUB_WALLET_HOOK_COMMAND = "";
		// PATH probe outcome depends on host, so just assert the override was
		// ignored — the result must contain the bin name in either form.
		expect(resolveHookCommand()).toContain("keeperhub-wallet-hook");
	});

	it("returns npx form when npm_execpath points at npx-cli, even if bin is on PATH", async () => {
		// Repro: when the user runs `npx @keeperhub/wallet skill install`, npx
		// prepends its transient cache dir to PATH for the lifetime of the
		// installer process. `command -v keeperhub-wallet-hook` therefore
		// resolves successfully INSIDE the installer, but the cache dir is
		// gone from PATH for fresh shells (the ones that fire the hook), so
		// the hook crashes with `command not found`. Detect npx via
		// `npm_execpath` (the canonical signal npm/npx set on every spawn)
		// and force the npx form regardless of probe outcome.
		delete process.env.KEEPERHUB_WALLET_HOOK_COMMAND;
		const stubRoot = await mkdtemp(join(tmpdir(), "kh-resolver-npx-env-"));
		const stubBinDir = await seedHookStub(
			join(stubRoot, "stable-install", "bin"),
		);
		process.env.PATH = `${stubBinDir}:/var/empty`;
		process.env.npm_execpath =
			"/Users/x/.npm/_npx/abc/node_modules/npm/bin/npx-cli.js";

		try {
			const cmd = resolveHookCommand();
			expect(cmd.startsWith("npx -y -p @keeperhub/wallet@")).toBe(true);
		} finally {
			await rm(stubRoot, { recursive: true, force: true });
		}
	});

	it("returns npx form when the resolved bin path lives under an npx _npx cache", async () => {
		// Fallback detection for runners that don't propagate npm_execpath:
		// resolve the bin via `command -v` and check whether the absolute path
		// contains an `_npx/` segment (npm's transient install cache, both on
		// POSIX and Windows). A path under _npx is by definition not durable
		// and the bare command form would fail post-install.
		delete process.env.KEEPERHUB_WALLET_HOOK_COMMAND;
		delete process.env.npm_execpath;
		const npxRoot = await mkdtemp(join(tmpdir(), "kh-resolver-npx-path-"));
		const npxBinDir = await seedHookStub(
			join(npxRoot, "_npx", "abc123", "node_modules", ".bin"),
		);
		process.env.PATH = `${npxBinDir}:/var/empty`;

		try {
			const cmd = resolveHookCommand();
			expect(cmd.startsWith("npx -y -p @keeperhub/wallet@")).toBe(true);
		} finally {
			await rm(npxRoot, { recursive: true, force: true });
		}
	});

	it("returns the bare bin form when the resolved path is a stable install location", async () => {
		// Positive case: a real global install (npm i -g, brew, distro pkg) lands
		// outside any _npx cache and stays on PATH after the installer exits, so
		// the bare-bin form is the lowest-latency hook command.
		delete process.env.KEEPERHUB_WALLET_HOOK_COMMAND;
		delete process.env.npm_execpath;
		const stableRoot = await mkdtemp(join(tmpdir(), "kh-resolver-stable-"));
		const stableBinDir = await seedHookStub(
			join(stableRoot, "usr", "local", "bin"),
		);
		process.env.PATH = `${stableBinDir}:/var/empty`;

		try {
			expect(resolveHookCommand()).toBe("keeperhub-wallet-hook");
		} finally {
			await rm(stableRoot, { recursive: true, force: true });
		}
	});

	it("pins npx to the installer's package version (no implicit @latest)", () => {
		// Reviewer 2 finding: pulling `latest` on every PreToolUse fire is a
		// supply-chain risk. Force the npx fallback by pointing the env-driven
		// PATH at an empty directory so `command -v` cannot resolve the bin.
		delete process.env.KEEPERHUB_WALLET_HOOK_COMMAND;
		const originalPath = process.env.PATH;
		process.env.PATH = "/var/empty";
		try {
			const cmd = resolveHookCommand();
			expect(cmd.startsWith("npx -y -p @keeperhub/wallet@")).toBe(true);
			// Must NOT pin to @latest — the installer's own version is the
			// upper bound on supply-chain trust.
			expect(cmd).not.toContain("@keeperhub/wallet@latest");
			expect(cmd).not.toContain("@keeperhub/wallet keeperhub-wallet-hook");
			// Sanity: the pinned segment must look like a semver-ish token, not
			// an empty placeholder.
			const match = cmd.match(/@keeperhub\/wallet@([^\s]+)/);
			expect(match).not.toBeNull();
			const pinned = match?.[1] ?? "";
			expect(pinned.length).toBeGreaterThan(0);
			expect(pinned).not.toBe("latest");
		} finally {
			process.env.PATH = originalPath;
		}
	});
});

describe("installSkill()", () => {
	it("copies the skill source verbatim into every detected skillsDir", async () => {
		// Seed a tmp skill source with a deterministic marker.
		const skillSource = join(fakeHome, "_source", "keeperhub-wallet.skill.md");
		await mkdir(join(fakeHome, "_source"), { recursive: true });
		const sourceContents =
			"---\nname: keeperhub-wallet\n---\n\n# marker-under-test\n";
		await writeFile(skillSource, sourceContents);

		const result = await installSkill({
			homeOverride: fakeHome,
			skillSourcePath: skillSource,
			onNotice: (): void => {
				// Silence stderr in this test; notice path is exercised separately.
			},
		});

		expect(result.skillWrites).toHaveLength(2);

		const claudeCopy = await readFile(
			join(fakeHome, ".claude", "skills", "keeperhub-wallet.skill.md"),
			"utf-8",
		);
		const cursorCopy = await readFile(
			join(fakeHome, ".cursor", "skills", "keeperhub-wallet.skill.md"),
			"utf-8",
		);
		expect(claudeCopy).toBe(sourceContents);
		expect(cursorCopy).toBe(sourceContents);
	});

	it("emits a notice for cursor-only home and never touches cursor settings.json", async () => {
		// Remove the .claude seed so only cursor is detected.
		await rm(join(fakeHome, ".claude"), { recursive: true, force: true });

		const skillSource = join(fakeHome, "_source", "keeperhub-wallet.skill.md");
		await mkdir(join(fakeHome, "_source"), { recursive: true });
		await writeFile(skillSource, "---\nname: keeperhub-wallet\n---\n");

		const notices: string[] = [];
		const result = await installSkill({
			homeOverride: fakeHome,
			skillSourcePath: skillSource,
			onNotice: (msg: string): void => {
				notices.push(msg);
			},
		});

		expect(result.hookRegistrations).toHaveLength(1);
		expect(result.hookRegistrations[0]).toMatchObject({
			agent: "cursor",
			status: "notice",
		});
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("cursor");
		expect(notices[0]).toContain("keeperhub-wallet-hook");

		// Cursor settings.json must NEVER be written.
		await expect(
			stat(join(fakeHome, ".cursor", "settings.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
