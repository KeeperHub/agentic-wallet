import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * User-owned safety config at ~/.keeperhub/safety.json. File mode 0o644 so the
 * user can freely edit thresholds and the allowlist; server-side Turnkey policy
 * remains the authoritative hard cap (GUARD-06).
 */
export type SafetyConfig = {
  auto_approve_max_usd: number;
  ask_threshold_usd: number;
  block_threshold_usd: number;
  allowlisted_contracts: string[];
};

/**
 * Defaults per 34-CONTEXT lines 61-68. Thresholds bracket the Turnkey policy
 * hard cap (100 USDC). Allowlisted contracts mirror the server Turnkey policy
 * allowlist (lib/agentic-wallet/policy.ts FACILITATOR_ALLOWLIST) -- lowercased
 * for case-insensitive match against tool_input.to / paymentChallenge.payTo.
 */
export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  auto_approve_max_usd: 5,
  ask_threshold_usd: 50,
  block_threshold_usd: 100,
  allowlisted_contracts: [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base USDC
    "0x20c000000000000000000000b9537d11c60e8b50", // Tempo USDC.e
  ],
};

// NOTE: Every function calls `join(homedir(), ".keeperhub", "safety.json")`
// itself -- matches storage.ts. Hoisting to a module-level constant would
// freeze $HOME at import time and break tests that override process.env.HOME
// in beforeEach.

function getSafetyPath(): string {
  return join(homedir(), ".keeperhub", "safety.json");
}

export async function loadSafetyConfig(): Promise<SafetyConfig> {
  const path = getSafetyPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(DEFAULT_SAFETY_CONFIG, null, 2), {
        mode: 0o644,
      });
      // Reassert mode in case the file already existed with looser perms.
      await chmod(path, 0o644);
      return DEFAULT_SAFETY_CONFIG;
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<SafetyConfig>;
  return validateAndMerge(parsed);
}

const THRESHOLD_KEYS = [
  "auto_approve_max_usd",
  "ask_threshold_usd",
  "block_threshold_usd",
] as const;

export function validateAndMerge(partial: Partial<SafetyConfig>): SafetyConfig {
  const merged: SafetyConfig = {
    auto_approve_max_usd:
      partial.auto_approve_max_usd ??
      DEFAULT_SAFETY_CONFIG.auto_approve_max_usd,
    ask_threshold_usd:
      partial.ask_threshold_usd ?? DEFAULT_SAFETY_CONFIG.ask_threshold_usd,
    block_threshold_usd:
      partial.block_threshold_usd ?? DEFAULT_SAFETY_CONFIG.block_threshold_usd,
    allowlisted_contracts:
      partial.allowlisted_contracts ??
      DEFAULT_SAFETY_CONFIG.allowlisted_contracts,
  };

  for (const key of THRESHOLD_KEYS) {
    const v = merged[key];
    if (!(Number.isFinite(v) && v >= 0)) {
      throw new Error(
        `safety.json: ${key} must be a non-negative finite number; got ${String(v)}`
      );
    }
  }
  if (merged.ask_threshold_usd < merged.auto_approve_max_usd) {
    throw new Error(
      "safety.json: ask_threshold_usd must be >= auto_approve_max_usd"
    );
  }
  if (merged.block_threshold_usd < merged.ask_threshold_usd) {
    throw new Error(
      "safety.json: block_threshold_usd must be >= ask_threshold_usd"
    );
  }
  if (!Array.isArray(merged.allowlisted_contracts)) {
    throw new Error("safety.json: allowlisted_contracts must be an array");
  }
  merged.allowlisted_contracts = merged.allowlisted_contracts.map((a) =>
    a.toLowerCase()
  );
  return merged;
}

export function getSafetyConfigPath(): string {
  return getSafetyPath();
}
