// End-to-end integration test for `npx @keeperhub/wallet skill install`.
//
// Drives the full commander pipeline via in-process runCli(). Seeds a
// tmp $HOME with pre-existing ~/.claude/settings.json containing 5
// foreign keys and asserts:
//   - skill file lands in both .claude/skills/ and .cursor/skills/
//   - settings.json preserves every foreign key byte-identically
//   - running the CLI twice leaves exactly one PreToolUse entry
//   - ~/.cursor/settings.json is never written
//   - stderr carries a notice mentioning the cursor agent and the
//     keeperhub-wallet-hook command (once per run, twice total)
//   - malformed settings.json aborts cleanly with exit 1 and keeps
//     the disk bytes intact

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
import { runCli } from "../../src/cli.js";

type PreToolUseEntry = {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
};

type SeededSettings = {
  mcpServers: {
    "existing-mcp": { command: string; args: unknown[] };
  };
  theme: string;
  telemetry: boolean;
  hooks: {
    PostToolUse: PreToolUseEntry[];
    PreToolUse?: PreToolUseEntry[];
  };
  custom: { nested: string };
};

const NOT_VALID_JSON_RE = /not valid JSON/;
const NOTICE_CURSOR_LINE_RE = /^notice: cursor ->/gm;

function buildSeed(): SeededSettings {
  return {
    mcpServers: {
      "existing-mcp": { command: "foo", args: [] },
    },
    theme: "dark",
    telemetry: false,
    hooks: {
      PostToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "other-hook" }],
        },
      ],
    },
    custom: { nested: "value" },
  };
}

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "kh-skill-install-e2e-"));
  process.env.HOME = fakeHome;
  await mkdir(join(fakeHome, ".claude"), { recursive: true });
  await mkdir(join(fakeHome, ".cursor"), { recursive: true });
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(fakeHome, { recursive: true, force: true });
});

type StdioCapture = {
  stdoutChunks: string[];
  stderrChunks: string[];
  restore: () => void;
};

function captureStdio(): StdioCapture {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    stdoutChunks,
    stderrChunks,
    restore: (): void => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

type ExitTrap = {
  codes: (number | undefined)[];
  restore: () => void;
};

function trapExit(): ExitTrap {
  const codes: (number | undefined)[] = [];
  const origExit = process.exit;
  process.exit = ((code?: number): never => {
    codes.push(code);
    throw new Error(`EXIT_${code}`);
  }) as typeof process.exit;
  return {
    codes,
    restore: (): void => {
      process.exit = origExit;
    },
  };
}

async function driveSkillInstall(): Promise<StdioCapture & ExitTrap> {
  const stdio = captureStdio();
  const exit = trapExit();
  try {
    await runCli(["node", "keeperhub-wallet", "skill", "install"]);
  } catch (err) {
    if (!(err as Error).message?.startsWith("EXIT_")) {
      throw err;
    }
  } finally {
    stdio.restore();
    exit.restore();
  }
  return { ...stdio, ...exit };
}

describe("CLI skill install end-to-end", () => {
  it("runs idempotently across two invocations and preserves foreign settings keys", async () => {
    const settingsPath = join(fakeHome, ".claude", "settings.json");
    const seed = buildSeed();
    await writeFile(settingsPath, JSON.stringify(seed, null, 2));

    const first = await driveSkillInstall();
    const second = await driveSkillInstall();

    // Skill file lands in both agents' directories.
    const claudeSkill = await readFile(
      join(fakeHome, ".claude", "skills", "keeperhub-wallet.skill.md"),
      "utf-8"
    );
    const cursorSkill = await readFile(
      join(fakeHome, ".cursor", "skills", "keeperhub-wallet.skill.md"),
      "utf-8"
    );
    expect(claudeSkill.startsWith("---")).toBe(true);
    expect(claudeSkill).toContain("name: keeperhub-wallet");
    expect(cursorSkill).toBe(claudeSkill);

    // settings.json: idempotency + full preservation.
    const raw = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as SeededSettings;
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse?.[0].hooks[0].command).toBe(
      "keeperhub-wallet-hook"
    );
    expect(parsed.hooks.PostToolUse).toEqual(seed.hooks.PostToolUse);
    expect(parsed.mcpServers["existing-mcp"].command).toBe("foo");
    expect(parsed.theme).toBe("dark");
    expect(parsed.telemetry).toBe(false);
    expect(parsed.custom.nested).toBe("value");

    // ~/.cursor/settings.json must never be written.
    await expect(
      stat(join(fakeHome, ".cursor", "settings.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Notice printed exactly once per run (twice total across two runs).
    // Count the "notice: cursor" line-prefix rather than substrings of the
    // message body: the notice text itself legitimately contains the word
    // "cursor" multiple times (agent name + settings file path).
    const combinedStderr =
      first.stderrChunks.join("") + second.stderrChunks.join("");
    const noticeLines = combinedStderr.match(NOTICE_CURSOR_LINE_RE);
    expect(noticeLines?.length ?? 0).toBe(2);
    expect(combinedStderr).toContain("cursor");
    expect(combinedStderr).toContain("keeperhub-wallet-hook");
  });

  it("creates .claude/skills/ (mode 0o755) with skill file mode 0o644 on fresh run", async () => {
    await driveSkillInstall();

    const skillsDirStat = await stat(join(fakeHome, ".claude", "skills"));
    expect(skillsDirStat.isDirectory()).toBe(true);
    expect(skillsDirStat.mode & 0o755).toBe(0o755);

    const skillFileStat = await stat(
      join(fakeHome, ".claude", "skills", "keeperhub-wallet.skill.md")
    );
    expect(skillFileStat.mode & 0o644).toBe(0o644);
  });

  it("aborts with exit 1 on malformed settings.json and leaves bytes unchanged", async () => {
    const settingsPath = join(fakeHome, ".claude", "settings.json");
    const bogus = "{ not valid json";
    await writeFile(settingsPath, bogus);
    const before = await readFile(settingsPath, "utf-8");

    const run = await driveSkillInstall();

    expect(run.codes).toContain(1);
    const errOut = run.stderrChunks.join("");
    expect(errOut).toMatch(NOT_VALID_JSON_RE);

    const after = await readFile(settingsPath, "utf-8");
    expect(after).toBe(before);
  });
});
