import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SAFETY_CONFIG,
  loadSafetyConfig,
  type SafetyConfig,
  validateAndMerge,
} from "../../src/safety-config.js";

const NON_NEGATIVE_RE = /non-negative/;
const ASK_GTE_AUTO_RE = /ask_threshold_usd must be >= auto_approve_max_usd/;
const BLOCK_GTE_ASK_RE = /block_threshold_usd must be >= ask_threshold_usd/;
const ARRAY_RE = /array/;

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "kh-safety-"));
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(fakeHome, { recursive: true, force: true });
});

describe("loadSafetyConfig()", () => {
  it("returns DEFAULT config and writes the file (mode 0o644) when missing", async () => {
    const cfg = await loadSafetyConfig();
    expect(cfg).toEqual(DEFAULT_SAFETY_CONFIG);
    const st = await stat(join(fakeHome, ".keeperhub", "safety.json"));
    expect(st.mode & 0o777).toBe(0o644);
  });

  it("reads existing config and merges with defaults", async () => {
    await mkdir(join(fakeHome, ".keeperhub"), { recursive: true });
    await writeFile(
      join(fakeHome, ".keeperhub", "safety.json"),
      JSON.stringify({ auto_approve_max_usd: 10 })
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.auto_approve_max_usd).toBe(10);
    expect(cfg.ask_threshold_usd).toBe(50);
  });

  it("lowercases allowlisted contracts on load", async () => {
    await mkdir(join(fakeHome, ".keeperhub"), { recursive: true });
    await writeFile(
      join(fakeHome, ".keeperhub", "safety.json"),
      JSON.stringify({
        allowlisted_contracts: ["0xABCDEF0000000000000000000000000000000001"],
      })
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.allowlisted_contracts).toEqual([
      "0xabcdef0000000000000000000000000000000001",
    ]);
  });
});

describe("validateAndMerge()", () => {
  it("throws when auto_approve_max_usd is negative", () => {
    expect(() => validateAndMerge({ auto_approve_max_usd: -5 })).toThrow(
      NON_NEGATIVE_RE
    );
  });

  it("throws when ask_threshold < auto_approve", () => {
    expect(() =>
      validateAndMerge({ auto_approve_max_usd: 50, ask_threshold_usd: 10 })
    ).toThrow(ASK_GTE_AUTO_RE);
  });

  it("throws when block_threshold < ask_threshold", () => {
    expect(() =>
      validateAndMerge({ ask_threshold_usd: 50, block_threshold_usd: 10 })
    ).toThrow(BLOCK_GTE_ASK_RE);
  });

  it("throws when allowlisted_contracts is not an array", () => {
    expect(() =>
      validateAndMerge({
        allowlisted_contracts: "0xabc" as unknown as string[],
      })
    ).toThrow(ARRAY_RE);
  });

  it("accepts valid config unchanged (except lowercasing)", () => {
    const input: SafetyConfig = {
      auto_approve_max_usd: 1,
      ask_threshold_usd: 10,
      block_threshold_usd: 100,
      allowlisted_contracts: ["0xABC"],
    };
    const out = validateAndMerge(input);
    expect(out.auto_approve_max_usd).toBe(1);
    expect(out.allowlisted_contracts).toEqual(["0xabc"]);
  });
});
