import { describe, expect, it, vi } from "vitest";
import { createPreToolUseHook } from "../../src/hook.js";
import type { SafetyConfig } from "../../src/safety-config.js";
import type { WalletConfig } from "../../src/types.js";

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

const wallet: WalletConfig = {
  subOrgId: "so_hook",
  walletAddress: "0x0000000000000000000000000000000000000008",
  hmacSecret: "ee".repeat(32),
};

type BuildOpts = {
  clientFactory?: () => { request: ReturnType<typeof vi.fn> };
  onAskOpen?: (url: string) => void;
  poll?: { intervalMs: number; maxAttempts: number };
};

function buildHook(
  opts: BuildOpts
): Promise<(input: unknown) => Promise<{ decision: string; reason?: string }>> {
  return createPreToolUseHook({
    configLoader: () => Promise.resolve(testSafety),
    walletLoader: () => Promise.resolve(wallet),
    clientFactory: opts.clientFactory as never,
    onAskOpen: opts.onAskOpen,
    poll: opts.poll ?? { intervalMs: 1, maxAttempts: 50 },
  });
}

describe("createPreToolUseHook() -- auto/ask/block tiers", () => {
  it("GUARD-02 auto tier: allows 1 USDC to allowlisted contract", async () => {
    const hook = await buildHook({
      clientFactory: () => ({ request: vi.fn() }),
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
    expect(decision).toEqual({ decision: "allow" });
  });

  it("GUARD-04 block tier: denies 200 USDC (above block_threshold 100)", async () => {
    const clientMock = { request: vi.fn() };
    const hook = await buildHook({ clientFactory: () => clientMock });
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
    expect(clientMock.request).not.toHaveBeenCalled();
  });

  it("GUARD-04 block tier: denies contract not in allowlist", async () => {
    const clientMock = { request: vi.fn() };
    const hook = await buildHook({ clientFactory: () => clientMock });
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
    expect(clientMock.request).not.toHaveBeenCalled();
  });

  it("GUARD-05 ignores forged trust flags -- trustLevel:high is irrelevant", async () => {
    const clientMock = { request: vi.fn() };
    const hook = await buildHook({ clientFactory: () => clientMock });
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
    expect(clientMock.request).not.toHaveBeenCalled();
  });

  it("pass-through: allows non-wallet tool calls", async () => {
    const hook = await buildHook({
      clientFactory: () => ({ request: vi.fn() }),
    });
    const decision = await hook({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(decision).toEqual({ decision: "allow" });
  });

  it("GUARD-03 ask tier: opens approval URL, polls approval-request, resolves on approved", async () => {
    const clientMock = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          approvalRequestId: "ar_test",
          status: "pending",
        })
        .mockResolvedValueOnce({ status: "approved" }),
    };
    let capturedUrl: string | null = null;
    const hook = await buildHook({
      clientFactory: () => clientMock,
      onAskOpen: (url) => {
        capturedUrl = url;
      },
    });
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: {
        amount: "60000000",
        unit: "microUsdc",
        to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
    });
    expect(decision).toEqual({ decision: "allow" });
    expect(capturedUrl).toBe("https://app.keeperhub.com/approve/ar_test");
    expect(clientMock.request).toHaveBeenCalledTimes(2);
    expect(clientMock.request.mock.calls[0]?.[1]).toBe(
      "/api/agentic-wallet/approval-request"
    );
    expect(clientMock.request.mock.calls[1]?.[1]).toBe(
      "/api/agentic-wallet/approval-request/ar_test"
    );
  });

  it("GUARD-03 ask tier: resolves deny/USER_REJECTED when human rejects", async () => {
    const clientMock = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          approvalRequestId: "ar_reject",
          status: "pending",
        })
        .mockResolvedValueOnce({ status: "rejected" }),
    };
    const hook = await buildHook({ clientFactory: () => clientMock });
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: {
        amount: "60000000",
        unit: "microUsdc",
        to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
    });
    expect(decision).toEqual({ decision: "deny", reason: "USER_REJECTED" });
  });

  it("ask tier (middle band auto<amount<ask): returns {decision:'ask'}", async () => {
    const hook = await buildHook({
      clientFactory: () => ({ request: vi.fn() }),
    });
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

  it("GUARD-05 throws when amount is untagged (no unit field)", async () => {
    const hook = await buildHook({
      clientFactory: () => ({ request: vi.fn() }),
    });
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
    const hook = await buildHook({
      clientFactory: () => ({ request: vi.fn() }),
    });
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
    const hook = await buildHook({
      clientFactory: () => ({ request: vi.fn() }),
    });
    const decision = await hook({
      tool_name: "keeperhub-sign",
      tool_input: { to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
    });
    expect(decision).toEqual({
      decision: "deny",
      reason: "AMOUNT_UNDETERMINED",
    });
  });
});
