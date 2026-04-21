import { KeeperHubClient } from "./client.js";
import { loadSafetyConfig, type SafetyConfig } from "./safety-config.js";
import { readWalletConfig } from "./storage.js";
import type { HookDecision, WalletConfig } from "./types.js";

type HookInput = {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export type CreateHookOptions = {
  /** Match against tool_name. Default: /keeperhub|wallet|sign/i */
  toolNameMatcher?: (name: string) => boolean;
  /** Injected for tests */
  walletLoader?: () => Promise<WalletConfig>;
  /** Injected for tests */
  configLoader?: () => Promise<SafetyConfig>;
  /** Injected for tests */
  clientFactory?: (w: WalletConfig) => KeeperHubClient;
  /**
   * Called when the ask tier opens an approval URL. Default: write to stderr
   * (stdout is reserved for the Claude Code hook JSON output).
   */
  onAskOpen?: (url: string) => void;
  /** Polling config for the ask tier */
  poll?: { intervalMs: number; maxAttempts: number };
};

const DEFAULT_POLL = { intervalMs: 2000, maxAttempts: 150 } as const;
const APPROVAL_URL_BASE = "https://app.keeperhub.com/approve/";
const USDC_DECIMALS = 1_000_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MICRO_USDC_RE = /^\d+$/;
const DEFAULT_TOOL_RE = /keeperhub|wallet|sign/i;

function defaultToolMatcher(name: string): boolean {
  return DEFAULT_TOOL_RE.test(name);
}

/**
 * Coerce an amount field to micro-USDC. Inputs MUST be explicitly tagged with
 * `unit`:
 *  - `{amount: string, unit: "microUsdc"}` -> parsed as integer micro-USDC
 *    (x402 wire format)
 *  - `{amount: number, unit: "usd"}`       -> multiplied by 1_000_000
 *
 * Untagged amounts are REJECTED with a thrown TypeError. This is GUARD-05:
 * we refuse to guess whether a "5" is 5 USD or 5 micro-USDC (a six-order-of-
 * magnitude reading error). The caller must commit.
 *
 * Fields read: ONLY tool_input.paymentChallenge.{amount,unit} and
 * tool_input.{amount,unit}. Forged safety-bypass fields (any "trust-level"
 * hint, "is-safe" boolean, "admin-override" bit, or similar) are NEVER read;
 * thresholds come exclusively from ~/.keeperhub/safety.json.
 */
function extractAmountMicroUsdc(input: HookInput): bigint | null {
  const ti = input.tool_input ?? {};
  const challenge = (ti.paymentChallenge ?? {}) as Record<string, unknown>;
  // WR-01: prefer the signed wire field (paymentChallenge.amount/unit) over
  // caller-supplied sibling tool_input fields. The nested challenge is the
  // field the downstream /sign call actually binds into the signed bytes, so
  // a misbehaving tool cannot slip a larger nested amount past the auto cap
  // by shadowing it with a small top-level sibling. Fall back to top-level
  // only when no challenge is present (e.g. direct /sign tool calls with no
  // 402 round).
  const directAmount = challenge.amount ?? ti.amount;
  const directUnit = challenge.unit ?? ti.unit;

  if (directAmount === undefined || directAmount === null) {
    return null;
  }
  if (directUnit !== "usd" && directUnit !== "microUsdc") {
    throw new TypeError(
      `Amount input must be tagged with unit:"usd" or unit:"microUsdc"; got unit=${JSON.stringify(directUnit)}. GUARD-05 refuses to guess - specify explicitly.`
    );
  }
  if (directUnit === "microUsdc") {
    if (
      !(typeof directAmount === "string" && MICRO_USDC_RE.test(directAmount))
    ) {
      throw new TypeError(
        `unit:"microUsdc" requires amount as a non-negative integer string; got ${typeof directAmount}`
      );
    }
    return BigInt(directAmount);
  }
  // unit === "usd"
  if (
    !(
      typeof directAmount === "number" &&
      Number.isFinite(directAmount) &&
      directAmount >= 0
    )
  ) {
    throw new TypeError(
      `unit:"usd" requires amount as a finite non-negative number; got ${typeof directAmount}`
    );
  }
  return BigInt(Math.round(directAmount * USDC_DECIMALS));
}

function extractToAddress(input: HookInput): string | null {
  const ti = input.tool_input ?? {};
  const challenge = (ti.paymentChallenge ?? {}) as Record<string, unknown>;
  const to = ti.to ?? challenge.payTo ?? challenge.to;
  if (typeof to === "string" && ADDRESS_RE.test(to)) {
    return to.toLowerCase();
  }
  return null;
}

function usdToMicro(usd: number): bigint {
  return BigInt(Math.round(usd * USDC_DECIMALS));
}

/**
 * Factory returning the PreToolUse hook function. The hook enforces the three
 * client-side safety tiers (auto / ask / block) sourced EXCLUSIVELY from
 * ~/.keeperhub/safety.json -- never from the tool payload (GUARD-05).
 */
export async function createPreToolUseHook(
  options: CreateHookOptions = {}
): Promise<(input: unknown) => Promise<HookDecision>> {
  const toolMatcher = options.toolNameMatcher ?? defaultToolMatcher;
  const configLoader = options.configLoader ?? loadSafetyConfig;
  const walletLoader = options.walletLoader ?? readWalletConfig;
  const clientFactory =
    options.clientFactory ?? ((w: WalletConfig) => new KeeperHubClient(w));
  const onAskOpen =
    options.onAskOpen ??
    ((url: string): void => {
      process.stderr.write(
        `\n[keeperhub-wallet] Approval required. Visit: ${url}\n`
      );
    });
  const poll = options.poll ?? DEFAULT_POLL;

  const safety = await configLoader();

  return async (raw: unknown): Promise<HookDecision> => {
    const hookInput = (raw ?? {}) as HookInput;

    // Pass-through for non-wallet tool calls.
    if (
      !(
        typeof hookInput.tool_name === "string" &&
        toolMatcher(hookInput.tool_name)
      )
    ) {
      return { decision: "allow" };
    }

    // GUARD-05: ONLY these fields. No trust/override/admin_* reads.
    const toAddr = extractToAddress(hookInput);
    const amountMicro = extractAmountMicroUsdc(hookInput);

    if (toAddr && !safety.allowlisted_contracts.includes(toAddr)) {
      return { decision: "deny", reason: "CONTRACT_NOT_ALLOWLISTED" };
    }

    if (amountMicro === null) {
      return { decision: "deny", reason: "AMOUNT_UNDETERMINED" };
    }

    const blockMicro = usdToMicro(safety.block_threshold_usd);
    const askMicro = usdToMicro(safety.ask_threshold_usd);
    const autoMicro = usdToMicro(safety.auto_approve_max_usd);

    if (amountMicro > blockMicro) {
      return { decision: "deny", reason: "BLOCKED_BY_SAFETY_RULE" };
    }

    if (amountMicro >= askMicro) {
      // Open approval flow (create approval-request + poll until non-pending).
      const wallet = await walletLoader();
      const client = clientFactory(wallet);
      const created = await client.request<{
        approvalRequestId: string;
        status: string;
      }>("POST", "/api/agentic-wallet/approval-request", {
        amountMicroUsdc: amountMicro.toString(),
        toAddress: toAddr ?? "",
        reason: `Agent tool ${hookInput.tool_name}`,
      });
      const approvalId = created.approvalRequestId;
      onAskOpen(`${APPROVAL_URL_BASE}${approvalId}`);
      for (let attempt = 0; attempt < poll.maxAttempts; attempt++) {
        await new Promise<void>((r) => setTimeout(r, poll.intervalMs));
        const status = await client.request<{
          status: "pending" | "approved" | "rejected";
        }>("GET", `/api/agentic-wallet/approval-request/${approvalId}`);
        // WR-03: align with payment-signer.ts:84 -- positive-shape check on
        // the expected envelope. If a future server change or proxy returns
        // a 202/other wrapper without `status`, keep polling instead of
        // treating an unknown envelope as "pending" by implication.
        if (!("status" in status)) {
          continue;
        }
        if (status.status === "approved") {
          return { decision: "allow" };
        }
        if (status.status === "rejected") {
          return { decision: "deny", reason: "USER_REJECTED" };
        }
        // status === "pending" -- continue polling.
      }
      return { decision: "deny", reason: "APPROVAL_TIMEOUT" };
    }

    if (amountMicro <= autoMicro) {
      return { decision: "allow" };
    }

    // Middle band: above auto but below ask.
    return { decision: "ask" };
  };
}
