import { describe, expect, it, vi } from "vitest";
import { createPreToolUseHook } from "../../src/hook.js";
import type { SafetyConfig } from "../../src/safety-config.js";
import type { HookDecision, WalletConfig } from "../../src/types.js";

// Note: runHookCli() drives process.stdin/stdout/exit; we exercise the
// equivalent end-to-end logic through createPreToolUseHook and the JSON
// envelope construction. The runtime shim (hook-entrypoint.ts) is a thin
// wrapper over these primitives.

const testSafety: SafetyConfig = {
  auto_approve_max_usd: 5,
  ask_threshold_usd: 50,
  block_threshold_usd: 100,
  allowlisted_contracts: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
};

const wallet: WalletConfig = {
  subOrgId: "so_integration",
  walletAddress: "0x0000000000000000000000000000000000000009",
  hmacSecret: "ff".repeat(32),
};

type Envelope = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
  };
};

function toEnvelope(decision: HookDecision): Envelope {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.decision,
      ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
    },
  };
}

describe("Hook integration -- JSON envelope for Claude Code PreToolUse", () => {
  it("auto tier emits permissionDecision:allow without reason", async () => {
    const hook = await createPreToolUseHook({
      configLoader: () => Promise.resolve(testSafety),
      walletLoader: () => Promise.resolve(wallet),
      clientFactory: () => ({ request: vi.fn() }) as never,
    });
    const decision = await hook({
      tool_name: "mcp__keeperhub__call_workflow",
      tool_input: {
        paymentChallenge: {
          amount: "1000000",
          unit: "microUsdc",
          payTo: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        },
      },
    });
    const env = toEnvelope(decision);
    expect(env).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  it("block tier emits permissionDecision:deny with BLOCKED_BY_SAFETY_RULE", async () => {
    const hook = await createPreToolUseHook({
      configLoader: () => Promise.resolve(testSafety),
      walletLoader: () => Promise.resolve(wallet),
      clientFactory: () => ({ request: vi.fn() }) as never,
    });
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: {
        amount: "200000000",
        unit: "microUsdc",
        to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
    });
    const env = toEnvelope(decision);
    expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(env.hookSpecificOutput.permissionDecisionReason).toBe(
      "BLOCKED_BY_SAFETY_RULE"
    );
  });

  it("ask tier with approval emits permissionDecision:allow after poll", async () => {
    const requestMock = vi
      .fn()
      .mockResolvedValueOnce({
        approvalRequestId: "ar_int",
        status: "pending",
      })
      .mockResolvedValueOnce({ status: "approved" });
    const hook = await createPreToolUseHook({
      configLoader: () => Promise.resolve(testSafety),
      walletLoader: () => Promise.resolve(wallet),
      clientFactory: () => ({ request: requestMock }) as never,
      onAskOpen: () => {
        /* swallow */
      },
      poll: { intervalMs: 1, maxAttempts: 50 },
    });
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: {
        amount: "60000000",
        unit: "microUsdc",
        to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
    });
    const env = toEnvelope(decision);
    expect(env.hookSpecificOutput.permissionDecision).toBe("allow");
  });
});
