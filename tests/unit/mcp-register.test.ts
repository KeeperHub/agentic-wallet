// Unit tests for mcp-register.ts.
//
// Covers:
// - Standard shape (claude-code, cursor, windsurf): writes
//   `mcpServers.keeperhub-wallet` with {command, args} into a fresh JSON file.
//   Verifies file mode is 0o600.
// - OpenCode divergent shape: writes
//   `mcp.keeperhub-wallet` with {type:"local", command:[...], enabled, environment}.
// - Idempotent re-run: re-registering with the same args is byte-stable;
//   re-registering with different args overwrites cleanly.
// - Foreign-key preservation: large existing claude.json with sibling MCP
//   entries (agentcash, discord) and unrelated top-level keys are untouched.
// - OpenCode foreign-key preservation: divergent shape preserves siblings.
// - Malformed JSON: throws with file path in the error message; disk bytes
//   are left unchanged (mirrors skill-install.test.ts).
// - Notice path (cline): registerMcpServer throws when called against a
//   `notice` agent; installSkill (covered indirectly here) handles that
//   branch by emitting a stderr notice instead.
// - resolveMcpCommand: env override beats PATH probe; PATH-not-found falls
//   back to the version-pinned npx form; bare bin form is returned only when
//   resolved on a stable PATH location.

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
import { join, delimiter as pathDelimiter } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTarget } from "../../src/agent-detect.js";
import {
	MCP_SERVER_NAME,
	type McpCommand,
	registerMcpServer,
	resolveMcpCommand,
} from "../../src/mcp-register.js";

// PATH-probing tests assume POSIX `/bin/sh` and `command -v`. Same gate as
// skill-install.test.ts.
const itPosix = process.platform === "win32" ? it.skip : it;

const TEST_BARE_COMMAND: McpCommand = {
	command: "keeperhub-wallet-mcp",
	args: [],
};

const TEST_NPX_COMMAND: McpCommand = {
	command: "npx",
	args: ["-y", "-p", "@keeperhub/wallet@9.9.9-test", "keeperhub-wallet-mcp"],
};

const NOT_VALID_JSON_RE = /not valid JSON/;

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	fakeHome = await mkdtemp(join(tmpdir(), "kh-mcp-register-"));
	process.env.HOME = fakeHome;
});

afterEach(async () => {
	process.env.HOME = originalHome;
	await rm(fakeHome, { recursive: true, force: true });
});

function buildClaudeTarget(): AgentTarget {
	return {
		agent: "claude-code",
		skillsDir: join(fakeHome, ".claude", "skills"),
		settingsFile: join(fakeHome, ".claude", "settings.json"),
		hookSupport: "claude-code",
		mcpConfigRel: [".claude.json"],
		mcpSupport: "claude-code",
	};
}

function buildCursorTarget(): AgentTarget {
	return {
		agent: "cursor",
		skillsDir: join(fakeHome, ".cursor", "skills"),
		settingsFile: join(fakeHome, ".cursor", "settings.json"),
		hookSupport: "notice",
		mcpConfigRel: [".cursor", "mcp.json"],
		mcpSupport: "cursor",
	};
}

function buildWindsurfTarget(): AgentTarget {
	return {
		agent: "windsurf",
		skillsDir: join(fakeHome, ".windsurf", "skills"),
		settingsFile: join(fakeHome, ".windsurf", "settings.json"),
		hookSupport: "notice",
		mcpConfigRel: [".codeium", "windsurf", "mcp_config.json"],
		mcpSupport: "windsurf",
	};
}

function buildOpencodeTarget(): AgentTarget {
	return {
		agent: "opencode",
		skillsDir: join(fakeHome, ".config", "opencode", "skills"),
		settingsFile: join(fakeHome, ".config", "opencode", "settings.json"),
		hookSupport: "notice",
		mcpConfigRel: [".config", "opencode", "opencode.json"],
		mcpSupport: "opencode",
	};
}

function buildClineTarget(): AgentTarget {
	return {
		agent: "cline",
		skillsDir: join(fakeHome, ".cline", "skills"),
		settingsFile: join(fakeHome, ".cline", "settings.json"),
		hookSupport: "notice",
		mcpSupport: "notice",
	};
}

type StandardEntry = {
	command: string;
	args: unknown[];
	env?: Record<string, string>;
};

type StandardConfig = {
	mcpServers?: Record<string, StandardEntry | Record<string, unknown>>;
	[k: string]: unknown;
};

type OpencodeEntry = {
	type: "local";
	command: string[];
	enabled: boolean;
	environment: Record<string, string>;
};

type OpencodeConfig = {
	mcp?: Record<string, OpencodeEntry | Record<string, unknown>>;
	[k: string]: unknown;
};

describe("registerMcpServer() — standard shape (claude-code/cursor/windsurf)", () => {
	it("writes mcpServers.keeperhub-wallet with {command,args} and mode 0o600 (claude-code)", async () => {
		const target = buildClaudeTarget();
		const result = await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_BARE_COMMAND,
		});

		expect(result.name).toBe(MCP_SERVER_NAME);
		expect(result.path).toBe(join(fakeHome, ".claude.json"));

		const st = await stat(result.path);
		expect(st.mode & 0o777).toBe(0o600);

		const raw = await readFile(result.path, "utf-8");
		const parsed = JSON.parse(raw) as StandardConfig;
		const entry = parsed.mcpServers?.[MCP_SERVER_NAME] as StandardEntry;
		expect(entry).toBeDefined();
		expect(entry.command).toBe(TEST_BARE_COMMAND.command);
		expect(entry.args).toEqual(TEST_BARE_COMMAND.args);
		// env is omitted when absent or empty (verified later in opencode shape).
		expect(entry.env).toBeUndefined();
	});

	it("writes the npx-pinned form verbatim (cursor variant)", async () => {
		const target = buildCursorTarget();
		const result = await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_NPX_COMMAND,
		});

		expect(result.path).toBe(join(fakeHome, ".cursor", "mcp.json"));
		const raw = await readFile(result.path, "utf-8");
		const parsed = JSON.parse(raw) as StandardConfig;
		const entry = parsed.mcpServers?.[MCP_SERVER_NAME] as StandardEntry;
		expect(entry.command).toBe("npx");
		expect(entry.args).toEqual(TEST_NPX_COMMAND.args);
	});

	it("creates parent directory under windsurf's legacy .codeium/windsurf path", async () => {
		const target = buildWindsurfTarget();
		const result = await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_BARE_COMMAND,
		});
		expect(result.path).toBe(
			join(fakeHome, ".codeium", "windsurf", "mcp_config.json"),
		);
		const st = await stat(result.path);
		expect(st.mode & 0o777).toBe(0o600);
	});
});

describe("registerMcpServer() — opencode divergent shape", () => {
	it("writes mcp.keeperhub-wallet as {type:'local', command:[...], enabled:true, environment:{}}", async () => {
		const target = buildOpencodeTarget();
		const result = await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_BARE_COMMAND,
		});

		expect(result.path).toBe(
			join(fakeHome, ".config", "opencode", "opencode.json"),
		);
		const raw = await readFile(result.path, "utf-8");
		const parsed = JSON.parse(raw) as OpencodeConfig;

		// The standard `mcpServers` key MUST NOT be present in the opencode shape.
		expect((parsed as Record<string, unknown>).mcpServers).toBeUndefined();

		const entry = parsed.mcp?.[MCP_SERVER_NAME] as OpencodeEntry;
		expect(entry).toBeDefined();
		expect(entry.type).toBe("local");
		// command is a single array combining the executable + args.
		expect(entry.command).toEqual([
			TEST_BARE_COMMAND.command,
			...TEST_BARE_COMMAND.args,
		]);
		expect(entry.enabled).toBe(true);
		// environment is always present (defaults to {}); divergence vs. standard
		// shape, which omits env when empty.
		expect(entry.environment).toEqual({});
	});

	it("flattens npx command + args into a single array for opencode", async () => {
		const target = buildOpencodeTarget();
		const result = await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_NPX_COMMAND,
		});
		const raw = await readFile(result.path, "utf-8");
		const parsed = JSON.parse(raw) as OpencodeConfig;
		const entry = parsed.mcp?.[MCP_SERVER_NAME] as OpencodeEntry;
		expect(entry.command).toEqual([
			"npx",
			"-y",
			"-p",
			"@keeperhub/wallet@9.9.9-test",
			"keeperhub-wallet-mcp",
		]);
	});
});

describe("registerMcpServer() — idempotency", () => {
	it("two invocations with identical args produce byte-identical disk content", async () => {
		const target = buildClaudeTarget();
		await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_BARE_COMMAND,
		});
		const first = await readFile(join(fakeHome, ".claude.json"), "utf-8");

		await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_BARE_COMMAND,
		});
		const second = await readFile(join(fakeHome, ".claude.json"), "utf-8");

		expect(second).toBe(first);
	});

	it("re-registering with different args overwrites the slot cleanly (no array dups)", async () => {
		const target = buildClaudeTarget();
		await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_BARE_COMMAND,
		});
		await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_NPX_COMMAND,
		});

		const raw = await readFile(join(fakeHome, ".claude.json"), "utf-8");
		const parsed = JSON.parse(raw) as StandardConfig;
		// Exactly ONE entry under the keeperhub-wallet name.
		expect(Object.keys(parsed.mcpServers ?? {})).toEqual([MCP_SERVER_NAME]);
		const entry = parsed.mcpServers?.[MCP_SERVER_NAME] as StandardEntry;
		expect(entry.command).toBe("npx");
		expect(entry.args).toEqual(TEST_NPX_COMMAND.args);
	});
});

describe("registerMcpServer() — foreign-key preservation (claude-code)", () => {
	it("preserves all top-level keys plus sibling mcpServers entries (agentcash + discord)", async () => {
		const target = buildClaudeTarget();
		const path = join(fakeHome, ".claude.json");

		// Seed the file with the kind of content a real ~/.claude.json contains:
		// large `projects` map, theme, sibling MCP entries, and a couple of
		// non-mcp top-level keys.
		const seed = {
			projects: {
				"/Users/test/proj1": { lastUsed: "2026-04-01" },
				"/Users/test/proj2": { lastUsed: "2026-04-15" },
				"/Users/test/proj3": { lastUsed: "2026-04-20" },
			},
			theme: "dark",
			telemetry: false,
			mcpServers: {
				agentcash: {
					command: "agentcash-mcp",
					args: ["--mode=stdio"],
					env: { AGENTCASH_TOKEN: "secret" },
				},
				discord: {
					command: "npx",
					args: ["-y", "discord-mcp"],
				},
			},
		};
		await writeFile(path, JSON.stringify(seed, null, 2));

		await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_BARE_COMMAND,
		});

		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as StandardConfig;

		// Foreign top-level keys preserved verbatim.
		expect(parsed.projects).toEqual(seed.projects);
		expect(parsed.theme).toBe("dark");
		expect(parsed.telemetry).toBe(false);

		// Sibling MCP entries preserved byte-for-byte.
		expect(parsed.mcpServers?.agentcash).toEqual(seed.mcpServers.agentcash);
		expect(parsed.mcpServers?.discord).toEqual(seed.mcpServers.discord);

		// Our slot is the only new key.
		expect(parsed.mcpServers?.[MCP_SERVER_NAME]).toBeDefined();
		const ourKeys = Object.keys(parsed.mcpServers ?? {}).sort();
		expect(ourKeys).toEqual(["agentcash", "discord", MCP_SERVER_NAME].sort());
	});
});

describe("registerMcpServer() — foreign-key preservation (opencode)", () => {
	it("preserves siblings under the divergent `mcp` key shape", async () => {
		const target = buildOpencodeTarget();
		const path = join(fakeHome, ".config", "opencode", "opencode.json");
		await mkdir(join(fakeHome, ".config", "opencode"), { recursive: true });

		const siblingFoo: OpencodeEntry = {
			type: "local",
			command: ["foo-server"],
			enabled: true,
			environment: { FOO_TOKEN: "abc" },
		};
		const siblingBar: OpencodeEntry = {
			type: "local",
			command: ["bar-server", "--flag"],
			enabled: false,
			environment: {},
		};
		const seed = {
			theme: "light",
			editor: { fontSize: 14 },
			mcp: { foo: siblingFoo, bar: siblingBar },
		};
		await writeFile(path, JSON.stringify(seed, null, 2));

		await registerMcpServer(target, {
			homeOverride: fakeHome,
			command: TEST_BARE_COMMAND,
		});

		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as OpencodeConfig;
		expect(parsed.theme).toBe("light");
		expect((parsed as Record<string, unknown>).editor).toEqual({
			fontSize: 14,
		});

		// Siblings preserved exactly.
		expect(parsed.mcp?.foo).toEqual(siblingFoo);
		expect(parsed.mcp?.bar).toEqual(siblingBar);

		// Only our slot was added under the divergent `mcp` key.
		const ours = parsed.mcp?.[MCP_SERVER_NAME] as OpencodeEntry;
		expect(ours.type).toBe("local");
		expect(ours.command).toEqual([TEST_BARE_COMMAND.command]);
	});
});

describe("registerMcpServer() — malformed JSON", () => {
	it("throws with the file path in the error message and leaves disk bytes unchanged", async () => {
		const target = buildClaudeTarget();
		const path = join(fakeHome, ".claude.json");
		const bogus = "{ this is not valid json";
		await writeFile(path, bogus);
		const before = await readFile(path, "utf-8");

		await expect(
			registerMcpServer(target, {
				homeOverride: fakeHome,
				command: TEST_BARE_COMMAND,
			}),
		).rejects.toThrow(NOT_VALID_JSON_RE);

		const after = await readFile(path, "utf-8");
		expect(after).toBe(before);
	});

	it("error message includes the absolute config file path", async () => {
		const target = buildClaudeTarget();
		const path = join(fakeHome, ".claude.json");
		await writeFile(path, "{ bogus");
		try {
			await registerMcpServer(target, {
				homeOverride: fakeHome,
				command: TEST_BARE_COMMAND,
			});
			throw new Error("expected rejection");
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain(path);
		}
	});
});

describe("registerMcpServer() — notice path", () => {
	it("throws when called against a `notice` agent (cline)", async () => {
		const target = buildClineTarget();
		await expect(
			registerMcpServer(target, {
				homeOverride: fakeHome,
				command: TEST_BARE_COMMAND,
			}),
		).rejects.toThrow(/does not support auto-registered MCP servers/);

		// Confirm no file was written under the cline tree.
		await expect(
			stat(join(fakeHome, ".cline", "mcp.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("resolveMcpCommand()", () => {
	let originalEnv: string | undefined;
	let originalPath: string | undefined;
	let originalNpmExecPath: string | undefined;

	beforeEach(() => {
		originalEnv = process.env.KEEPERHUB_WALLET_MCP_COMMAND;
		originalPath = process.env.PATH;
		originalNpmExecPath = process.env.npm_execpath;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.KEEPERHUB_WALLET_MCP_COMMAND;
		} else {
			process.env.KEEPERHUB_WALLET_MCP_COMMAND = originalEnv;
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

	async function seedMcpStub(rootDir: string): Promise<string> {
		await mkdir(rootDir, { recursive: true });
		const binPath = join(rootDir, "keeperhub-wallet-mcp");
		await writeFile(binPath, "#!/bin/sh\nexit 0\n");
		await chmod(binPath, 0o755);
		return rootDir;
	}

	it("honours KEEPERHUB_WALLET_MCP_COMMAND env override before probing PATH", () => {
		const sentinel = "/opt/custom/bin/keeperhub-wallet-mcp --flag";
		process.env.KEEPERHUB_WALLET_MCP_COMMAND = sentinel;
		const cmd = resolveMcpCommand();
		// Override is split on whitespace into command + args; head goes into
		// `command`, the tail goes into `args[]`.
		expect(cmd.command).toBe("/opt/custom/bin/keeperhub-wallet-mcp");
		expect(cmd.args).toEqual(["--flag"]);
	});

	it("env override with no whitespace returns command-only and empty args[]", () => {
		process.env.KEEPERHUB_WALLET_MCP_COMMAND = "/opt/sole/bin/kh-mcp";
		const cmd = resolveMcpCommand();
		expect(cmd.command).toBe("/opt/sole/bin/kh-mcp");
		expect(cmd.args).toEqual([]);
	});

	it("falls back to the version-pinned npx form when bin not on PATH", () => {
		delete process.env.KEEPERHUB_WALLET_MCP_COMMAND;
		delete process.env.npm_execpath;
		// Empty PATH guarantees `command -v` fails.
		process.env.PATH = "/var/empty";
		const cmd = resolveMcpCommand();
		expect(cmd.command).toBe("npx");
		// Pin must include the package name + a non-"latest" version.
		const pkgArg = cmd.args[1] ?? "";
		expect(pkgArg).toMatch(/^-p$|^@keeperhub\/wallet@/);
		const joined = cmd.args.join(" ");
		expect(joined).toContain("@keeperhub/wallet@");
		expect(joined).not.toContain("@keeperhub/wallet@latest");
		expect(cmd.args[cmd.args.length - 1]).toBe("keeperhub-wallet-mcp");
	});

	itPosix(
		"returns the bare bin form when resolved via a stable PATH location",
		async () => {
			delete process.env.KEEPERHUB_WALLET_MCP_COMMAND;
			delete process.env.npm_execpath;
			const stableRoot = await mkdtemp(join(tmpdir(), "kh-mcp-resolver-"));
			const stableBinDir = await seedMcpStub(
				join(stableRoot, "usr", "local", "bin"),
			);
			process.env.PATH = `${stableBinDir}${pathDelimiter}/var/empty`;
			try {
				const cmd = resolveMcpCommand();
				expect(cmd.command).toBe("keeperhub-wallet-mcp");
				expect(cmd.args).toEqual([]);
			} finally {
				await rm(stableRoot, { recursive: true, force: true });
			}
		},
	);

	itPosix(
		"returns the npx form when the resolved bin lives under a transient _npx cache",
		async () => {
			delete process.env.KEEPERHUB_WALLET_MCP_COMMAND;
			delete process.env.npm_execpath;
			const npxRoot = await mkdtemp(join(tmpdir(), "kh-mcp-resolver-npx-"));
			const npxBinDir = await seedMcpStub(
				join(npxRoot, "_npx", "abc123", "node_modules", ".bin"),
			);
			process.env.PATH = `${npxBinDir}${pathDelimiter}/var/empty`;
			try {
				const cmd = resolveMcpCommand();
				expect(cmd.command).toBe("npx");
				expect(cmd.args.join(" ")).toContain("@keeperhub/wallet@");
				expect(cmd.args[cmd.args.length - 1]).toBe("keeperhub-wallet-mcp");
			} finally {
				await rm(npxRoot, { recursive: true, force: true });
			}
		},
	);

	itPosix(
		"returns the npx form when the resolved bin lives under a pnpm dlx-* cache",
		async () => {
			delete process.env.KEEPERHUB_WALLET_MCP_COMMAND;
			delete process.env.npm_execpath;
			const dlxRoot = await mkdtemp(join(tmpdir(), "kh-mcp-resolver-dlx-"));
			const dlxBinDir = await seedMcpStub(
				join(dlxRoot, "tmp", "dlx-abc", "node_modules", ".bin"),
			);
			process.env.PATH = `${dlxBinDir}${pathDelimiter}/var/empty`;
			try {
				const cmd = resolveMcpCommand();
				expect(cmd.command).toBe("npx");
			} finally {
				await rm(dlxRoot, { recursive: true, force: true });
			}
		},
	);

	itPosix(
		"returns the npx form when the resolved bin lives under a yarn dlx xfs-* cache",
		async () => {
			delete process.env.KEEPERHUB_WALLET_MCP_COMMAND;
			delete process.env.npm_execpath;
			const xfsRoot = await mkdtemp(join(tmpdir(), "kh-mcp-resolver-xfs-"));
			const xfsBinDir = await seedMcpStub(
				join(xfsRoot, "xfs-deadbeef", "node_modules", ".bin"),
			);
			process.env.PATH = `${xfsBinDir}${pathDelimiter}/var/empty`;
			try {
				const cmd = resolveMcpCommand();
				expect(cmd.command).toBe("npx");
			} finally {
				await rm(xfsRoot, { recursive: true, force: true });
			}
		},
	);

	itPosix(
		"returns the npx form when the resolved bin lives under bun's install cache",
		async () => {
			delete process.env.KEEPERHUB_WALLET_MCP_COMMAND;
			delete process.env.npm_execpath;
			const bunRoot = await mkdtemp(join(tmpdir(), "kh-mcp-resolver-bun-"));
			const bunBinDir = await seedMcpStub(
				join(
					bunRoot,
					".bun",
					"install",
					"cache",
					"@keeperhub",
					"wallet@0.1.10",
					"bin",
				),
			);
			process.env.PATH = `${bunBinDir}${pathDelimiter}/var/empty`;
			try {
				const cmd = resolveMcpCommand();
				expect(cmd.command).toBe("npx");
			} finally {
				await rm(bunRoot, { recursive: true, force: true });
			}
		},
	);

	itPosix(
		"returns the npx form when npm_execpath points at npx-cli.js, even with bin on PATH",
		async () => {
			delete process.env.KEEPERHUB_WALLET_MCP_COMMAND;
			const stubRoot = await mkdtemp(
				join(tmpdir(), "kh-mcp-resolver-npx-env-"),
			);
			const stubBinDir = await seedMcpStub(
				join(stubRoot, "stable-install", "bin"),
			);
			process.env.PATH = `${stubBinDir}${pathDelimiter}/var/empty`;
			process.env.npm_execpath =
				"/Users/x/.npm/_npx/abc/node_modules/npm/bin/npx-cli.js";
			try {
				const cmd = resolveMcpCommand();
				expect(cmd.command).toBe("npx");
			} finally {
				await rm(stubRoot, { recursive: true, force: true });
			}
		},
	);
});
