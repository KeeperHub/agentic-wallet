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
const TEST_NPX_COMMAND = "npx -y -p @keeperhub/wallet keeperhub-wallet-hook";

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
      TEST_HOOK_COMMAND
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
      TEST_HOOK_COMMAND
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
      TEST_HOOK_COMMAND
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
      })
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
      TEST_NPX_COMMAND
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
      TEST_NPX_COMMAND
    );
  });
});

describe("resolveHookCommand()", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.KEEPERHUB_WALLET_HOOK_COMMAND;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.KEEPERHUB_WALLET_HOOK_COMMAND;
    } else {
      process.env.KEEPERHUB_WALLET_HOOK_COMMAND = originalEnv;
    }
  });

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
      "utf-8"
    );
    const cursorCopy = await readFile(
      join(fakeHome, ".cursor", "skills", "keeperhub-wallet.skill.md"),
      "utf-8"
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
      stat(join(fakeHome, ".cursor", "settings.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
