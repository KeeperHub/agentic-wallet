// Unit tests for detectAgents(). Seeds a tmp $HOME and asserts detection
// matches the canonical agent table (claude-code / cursor / cline /
// windsurf / opencode).

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentTarget, detectAgents } from "../../src/agent-detect.js";

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "kh-agent-detect-"));
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(fakeHome, { recursive: true, force: true });
});

describe("detectAgents()", () => {
  it("returns [] when no agent directories exist under $HOME", () => {
    const result = detectAgents();
    expect(result).toEqual([]);
  });

  it("detects claude-code when ~/.claude/ exists and flags hookSupport='claude-code'", async () => {
    await mkdir(join(fakeHome, ".claude"), { recursive: true });
    const result = detectAgents();
    expect(result).toHaveLength(1);
    const [entry] = result;
    expect(entry.agent).toBe("claude-code");
    expect(entry.hookSupport).toBe("claude-code");
    expect(entry.skillsDir).toBe(join(fakeHome, ".claude", "skills"));
    expect(entry.settingsFile).toBe(join(fakeHome, ".claude", "settings.json"));
  });

  it("detects multiple agents in deterministic order (claude-code -> cursor -> opencode)", async () => {
    await mkdir(join(fakeHome, ".claude"), { recursive: true });
    await mkdir(join(fakeHome, ".cursor"), { recursive: true });
    await mkdir(join(fakeHome, ".config", "opencode"), { recursive: true });

    const result = detectAgents();
    expect(result).toHaveLength(3);
    const agents: AgentTarget["agent"][] = [];
    for (const entry of result) {
      agents.push(entry.agent);
      expect(entry.skillsDir).toContain(fakeHome);
      expect(entry.settingsFile).toContain(fakeHome);
      expect(entry.hookSupport).not.toBeUndefined();
    }
    expect(agents).toEqual(["claude-code", "cursor", "opencode"]);

    const cursor = result.find(
      (r): r is AgentTarget => r.agent === "cursor"
    ) as AgentTarget;
    expect(cursor.skillsDir).toBe(join(fakeHome, ".cursor", "skills"));
    expect(cursor.settingsFile).toBe(
      join(fakeHome, ".cursor", "settings.json")
    );
    expect(cursor.hookSupport).toBe("notice");

    const opencode = result.find(
      (r): r is AgentTarget => r.agent === "opencode"
    ) as AgentTarget;
    expect(opencode.skillsDir).toBe(
      join(fakeHome, ".config", "opencode", "skills")
    );
    expect(opencode.settingsFile).toBe(
      join(fakeHome, ".config", "opencode", "settings.json")
    );
    expect(opencode.hookSupport).toBe("notice");
  });

  it("honours homeOverride, bypassing process.env.HOME", async () => {
    // Force process.env.HOME to a path that will never detect anything,
    // then pass the real fakeHome as override and prove detection still
    // works. This proves the override plumbing is test-friendly.
    const overrideHome = await mkdtemp(join(tmpdir(), "kh-agent-override-"));
    try {
      await mkdir(join(overrideHome, ".claude"), { recursive: true });
      process.env.HOME = "/nonexistent-home-path-for-test";

      const result = detectAgents(overrideHome);
      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe("claude-code");
      expect(result[0].skillsDir).toBe(join(overrideHome, ".claude", "skills"));
    } finally {
      await rm(overrideHome, { recursive: true, force: true });
    }
  });
});
