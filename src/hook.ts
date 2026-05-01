import { loadSafetyConfig, type SafetyConfig } from "./safety-config.js";
import type { HookDecision } from "./types.js";

type HookInput = {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export type CreateHookOptions = {
  /** Match against tool_name. Default: /keeperhub|wallet|sign/i */
  toolNameMatcher?: (name: string) => boolean;
  /** Injected for tests */
  configLoader?: () => Promise<SafetyConfig>;
};

const USDC_DECIMALS = 1_000_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MICRO_USDC_RE = /^\d+$/;
const DEFAULT_TOOL_RE = /keeperhub|wallet|sign/i;

function defaultToolMatcher(name: string): boolean {
  return DEFAULT_TOOL_RE.test(name);
}

/**
 * Detect whether a tool input carries any payment shape — the only kind
 * of call this hook is meant to gate. Free admin reads in the keeperhub
 * MCP namespace (e.g. mcp__plugin_keeperhub_keeperhub__get_execution_logs,
 * unlist_workflow, list_workflows) match the broad name regex but have
 * no amount, no contract, no challenge — there is nothing for the safety
 * gate to evaluate, so the hook should pass them through rather than
 * deny with AMOUNT_UNDETERMINED.
 *
 * A call is "payment-shaped" when at least one of these is present:
 *   - tool_input.paymentChallenge      (object)
 *   - tool_input.amount                (any non-null value)
 *   - tool_input.unit                  (any non-null value)
 *   - tool_input.to / contract / assetAddress  (only when the value
 *     looks like an EVM address; non-address strings such as Discord
 *     channel ids are not payment indicators)
 *
 * This complements the existing tool-name regex: the regex still gates
 * what the hook will *consider*, but presence of any payment field is
 * required before the safety thresholds actually run. Callers that pass
 * the regex but provide no payment context (the bug surfaced live with
 * mcp__plugin_keeperhub_keeperhub__unlist_workflow during marketplace
 * testing on 2026-05-01) are now allowed through.
 */
function hasPaymentShape(input: HookInput): boolean {
  const ti = input.tool_input ?? {};
  const challenge = ti.paymentChallenge;
  if (challenge !== undefined && challenge !== null) {
    return true;
  }
  if (ti.amount !== undefined && ti.amount !== null) {
    return true;
  }
  if (ti.unit !== undefined && ti.unit !== null) {
    return true;
  }
  for (const field of ["to", "contract", "assetAddress"] as const) {
    const v = ti[field];
    if (typeof v === "string" && ADDRESS_RE.test(v)) {
      return true;
    }
  }
  return false;
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

function extractContractAddress(input: HookInput): string | null {
  const ti = input.tool_input ?? {};
  const challenge = (ti.paymentChallenge ?? {}) as Record<string, unknown>;
  // Precedence order:
  //  1. challenge.asset -- x402 TransferWithAuthorization: the ERC-20 contract
  //     the authorization is bound to (the EVM `eth.tx.to` at execution time).
  //     This mirrors the server-side Turnkey policy (policy.ts) which denies
  //     `eth.tx.to not in [USDC_BASE, USDC_TEMPO]`.
  //  2. ti.contract / ti.assetAddress -- agent-runtime-supplied hints.
  //  3. ti.to / challenge.to -- legacy tool_inputs that labeled the asset as
  //     "to" (some older MCP implementations). Kept for backwards compat.
  // NEVER reads challenge.payTo: that is the transfer recipient (the
  // facilitator or service operator), not the ERC-20 contract being invoked.
  const contract =
    challenge.asset ??
    ti.contract ??
    ti.assetAddress ??
    ti.to ??
    challenge.to;
  if (typeof contract === "string" && ADDRESS_RE.test(contract)) {
    return contract.toLowerCase();
  }
  return null;
}

function usdToMicro(usd: number): bigint {
  return BigInt(Math.round(usd * USDC_DECIMALS));
}

/**
 * Factory returning the PreToolUse hook function. The hook enforces three
 * client-side safety tiers (auto / ask / block) sourced EXCLUSIVELY from
 * ~/.keeperhub/safety.json -- never from the tool payload (GUARD-05).
 *
 * v0.1.4 collapsed the previous four-band behaviour into three:
 *
 *   amount <= auto_approve_max_usd                    -> {decision: "allow"}
 *   auto_approve_max_usd < amount <= block_threshold  -> {decision: "ask"} (Claude Code prompts user inline)
 *   amount > block_threshold                          -> {decision: "deny"}
 *
 * The previous server-approval branch (amount >= ask_threshold -> create a
 * /api/agentic-wallet/approval-request row, print an approval URL, poll for
 * browser approval) was removed. It required the wallet to be linked to a
 * KeeperHub user via /link, and the link command was rough enough that we
 * never wired it into the documented flow. Returning {decision: "ask"}
 * inline lets Claude Code surface the prompt in the agent chat directly.
 *
 * `ask_threshold_usd` is still read from safety.json for backward-compat
 * with existing configs but is not consulted for decision-making. Tracked
 * as KEEP-307 for the permanent architectural decision.
 */
export async function createPreToolUseHook(
  options: CreateHookOptions = {}
): Promise<(input: unknown) => Promise<HookDecision>> {
  const toolMatcher = options.toolNameMatcher ?? defaultToolMatcher;
  const configLoader = options.configLoader ?? loadSafetyConfig;

  const safety = await configLoader();

  // The hook function is declared async so that synchronous throws in
  // extractAmountMicroUsdc (GUARD-05 unit-tag enforcement) become rejected
  // promises, matching the original pre-0.1.4 behaviour the tests rely on.
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

    // Pass-through for tool calls that match the wallet name regex but
    // carry no payment context whatsoever. The default matcher
    // /keeperhub|wallet|sign/i catches every keeperhub MCP tool by name
    // (call_workflow, list_workflows, unlist_workflow,
    // get_execution_logs, ...), but the bulk of those are free reads
    // and admin operations with no amount, no contract, no challenge.
    // Without this gate they would all fall through to the
    // AMOUNT_UNDETERMINED branch below and DENY, breaking ordinary
    // marketplace use of any agent that has the safety hook installed.
    if (!hasPaymentShape(hookInput)) {
      return { decision: "allow" };
    }

    // GUARD-05: ONLY these fields. No trust/override/admin_* reads.
    const contractAddr = extractContractAddress(hookInput);
    const amountMicro = extractAmountMicroUsdc(hookInput);

    if (contractAddr && !safety.allowlisted_contracts.includes(contractAddr)) {
      return { decision: "deny", reason: "CONTRACT_NOT_ALLOWLISTED" };
    }

    if (amountMicro === null) {
      return { decision: "deny", reason: "AMOUNT_UNDETERMINED" };
    }

    const blockMicro = usdToMicro(safety.block_threshold_usd);
    const autoMicro = usdToMicro(safety.auto_approve_max_usd);

    if (amountMicro > blockMicro) {
      return { decision: "deny", reason: "BLOCKED_BY_SAFETY_RULE" };
    }

    if (amountMicro <= autoMicro) {
      return { decision: "allow" };
    }

    // Everything between auto and block is an inline ask -- Claude Code
    // surfaces the prompt in-chat.
    return { decision: "ask" };
  };
}
