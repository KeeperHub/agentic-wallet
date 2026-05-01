import { describe, expect, it } from "vitest";
import { createPreToolUseHook } from "../../src/hook.js";
import type { SafetyConfig } from "../../src/safety-config.js";

const UNIT_TAG_RE = /unit:"usd" or unit:"microUsdc"/;

const testSafety: SafetyConfig = {
  auto_approve_max_usd: 5,
  ask_threshold_usd: 50,
  block_threshold_usd: 100,
  allowlisted_contracts: [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0x20c000000000000000000000b9537d11c60e8b50",
  ],
};

function buildHook(): Promise<
  (input: unknown) => Promise<{ decision: string; reason?: string }>
> {
  return createPreToolUseHook({
    configLoader: () => Promise.resolve(testSafety),
  });
}

describe("createPreToolUseHook() -- auto/ask/block tiers", () => {
  it("GUARD-02 auto tier: allows 1 USDC to allowlisted contract", async () => {
    const hook = await buildHook();
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
    expect(decision).toEqual({ decision: "allow" });
  });

  it("GUARD-04 block tier: denies 200 USDC (above block_threshold 100)", async () => {
    const hook = await buildHook();
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: {
        amount: "200000000",
        unit: "microUsdc",
        to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
    });
    expect(decision).toEqual({
      decision: "deny",
      reason: "BLOCKED_BY_SAFETY_RULE",
    });
  });

  it("GUARD-04 block tier: denies contract not in allowlist", async () => {
    const hook = await buildHook();
    const decision = await hook({
      tool_name: "wallet-sign",
      tool_input: {
        amount: "1000000",
        unit: "microUsdc",
        to: "0xdeadbeef00000000000000000000000000000001",
      },
    });
    expect(decision).toEqual({
      decision: "deny",
      reason: "CONTRACT_NOT_ALLOWLISTED",
    });
  });

  it("GUARD-05 ignores forged trust flags -- trustLevel:high is irrelevant", async () => {
    const hook = await buildHook();
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: {
        amount: "200000000",
        unit: "microUsdc",
        to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        trustLevel: "high",
        trusted: true,
        isSafe: true,
        admin_override: true,
      },
    });
    expect(decision).toEqual({
      decision: "deny",
      reason: "BLOCKED_BY_SAFETY_RULE",
    });
  });

  it("pass-through: allows non-wallet tool calls", async () => {
    const hook = await buildHook();
    const decision = await hook({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(decision).toEqual({ decision: "allow" });
  });

  it("ask tier (middle band auto < amount < block): returns {decision:'ask'}", async () => {
    const hook = await buildHook();
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: {
        amount: "20000000",
        unit: "microUsdc",
        to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
    });
    expect(decision).toEqual({ decision: "ask" });
  });

  it("ask tier (amount above ask_threshold but at or below block): still inline ask (v0.1.4 collapse)", async () => {
    // v0.1.4 removed the server-approval branch; anything above auto and at
    // or below block now returns inline ask so Claude Code handles the
    // prompt in-chat rather than opening a browser approval URL.
    const hook = await buildHook();
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: {
        amount: "60000000",
        unit: "microUsdc",
        to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
    });
    expect(decision).toEqual({ decision: "ask" });
  });

  it("GUARD-05 throws when amount is untagged (no unit field)", async () => {
    const hook = await buildHook();
    await expect(
      hook({
        tool_name: "keeperhub-sign",
        tool_input: {
          amount: "5",
          to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        },
      })
    ).rejects.toThrow(UNIT_TAG_RE);
  });

  it("GUARD-05 treats {amount:5, unit:'usd'} as 5_000_000 micro-USDC (auto allow)", async () => {
    const hook = await buildHook();
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: {
        amount: 5,
        unit: "usd",
        to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
    });
    expect(decision).toEqual({ decision: "allow" });
  });

  it("deny when amount cannot be determined", async () => {
    const hook = await buildHook();
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: { to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
    });
    expect(decision).toEqual({
      decision: "deny",
      reason: "AMOUNT_UNDETERMINED",
    });
  });

  // Bug surfaced live during marketplace testing on 2026-05-01: every free
  // admin MCP call (unlist_workflow, get_execution_logs, list_workflows)
  // matched the wallet-tool name regex via the substring "keeperhub" and
  // hit AMOUNT_UNDETERMINED, blocking ordinary use of any agent with the
  // safety hook installed.
  describe("pass-through for non-payment MCP calls (KEEP-392)", () => {
    it("allows mcp keeperhub admin call with no payment shape (unlist_workflow)", async () => {
      const hook = await buildHook();
      const decision = await hook({
        tool_name: "mcp__plugin_keeperhub_keeperhub__unlist_workflow",
        tool_input: { workflowId: "abc123" },
      });
      expect(decision).toEqual({ decision: "allow" });
    });

    it("allows mcp keeperhub read call with no payment shape (get_execution_logs)", async () => {
      const hook = await buildHook();
      const decision = await hook({
        tool_name: "mcp__plugin_keeperhub_keeperhub__get_execution_logs",
        tool_input: { executionId: "exec_xyz" },
      });
      expect(decision).toEqual({ decision: "allow" });
    });

    it("allows mcp keeperhub call_workflow before any 402 (no challenge yet)", async () => {
      const hook = await buildHook();
      const decision = await hook({
        tool_name: "mcp__plugin_keeperhub_keeperhub__call_workflow",
        tool_input: { slug: "stablecoin-yield-compare-base", inputs: {} },
      });
      expect(decision).toEqual({ decision: "allow" });
    });

    it("does NOT pass through when paymentChallenge is present (still gates)", async () => {
      // Same tool name as the test above, but now with payment context.
      // Must still hit the safety thresholds — pass-through only applies
      // when the call carries no payment shape at all.
      const hook = await buildHook();
      const decision = await hook({
        tool_name: "mcp__plugin_keeperhub_keeperhub__call_workflow",
        tool_input: {
          slug: "expensive-workflow",
          inputs: {},
          paymentChallenge: {
            amount: "200000000",
            unit: "microUsdc",
            payTo: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          },
        },
      });
      expect(decision).toEqual({
        decision: "deny",
        reason: "BLOCKED_BY_SAFETY_RULE",
      });
    });

    it("does NOT pass through when amount is provided directly (still gates)", async () => {
      // amount/unit at the top level is also a payment shape.
      const hook = await buildHook();
      const decision = await hook({
        tool_name: "wallet-sign",
        tool_input: {
          amount: 200,
          unit: "usd",
          to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        },
      });
      expect(decision).toEqual({
        decision: "deny",
        reason: "BLOCKED_BY_SAFETY_RULE",
      });
    });

    it("does NOT pass through when 'to' is an EVM contract address (still gates)", async () => {
      // Even without amount, a contract-shaped `to` is treated as a
      // payment indicator — preserving the existing AMOUNT_UNDETERMINED
      // case for sign-shaped calls that omit the amount.
      const hook = await buildHook();
      const decision = await hook({
        tool_name: "keeperhub-sign",
        tool_input: { to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
      });
      expect(decision).toEqual({
        decision: "deny",
        reason: "AMOUNT_UNDETERMINED",
      });
    });

    it("DOES pass through when 'to' is a non-address string (e.g. discord channel id)", async () => {
      // A `to` field is only a payment indicator when it looks like an
      // EVM address. Discord channel ids, slack workspace ids, etc. must
      // not accidentally trigger the gate.
      const hook = await buildHook();
      const decision = await hook({
        tool_name: "mcp__plugin_keeperhub_keeperhub__send_discord_message",
        tool_input: { to: "1234567890123456789", message: "hi" },
      });
      expect(decision).toEqual({ decision: "allow" });
    });
  });
});
