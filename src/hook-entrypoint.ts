import { createPreToolUseHook } from "./hook.js";

/**
 * Binary entrypoint for `npx @keeperhub/wallet hook` or direct invocation via
 * Claude Code settings.json:
 *
 *   { "type": "command", "command": "npx @keeperhub/wallet hook", "timeout": 30 }
 *
 * Reads JSON from stdin (Claude Code PreToolUse payload), writes the JSON
 * decision envelope to stdout, and exits 2 on deny (the universal "block"
 * signal across agent-hook runtimes per the Claude Code docs). A non-JSON
 * stdin is treated as a deny.
 *
 * @security Stdout is RESERVED for the envelope JSON; any diagnostic output
 * (approval URL, errors) goes to stderr via onAskOpen or direct writes.
 */
export async function runHookCli(): Promise<void> {
  const hook = await createPreToolUseHook();

  let raw = "";
  for await (const chunk of process.stdin as unknown as AsyncIterable<Buffer>) {
    raw += chunk.toString("utf-8");
  }

  let parsed: unknown;
  try {
    parsed = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(
      `[keeperhub-wallet] hook input is not valid JSON: ${(err as Error).message}\n`
    );
    process.exit(2);
  }

  const decision = await hook(parsed);

  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: decision.decision,
      ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(decision.decision === "deny" ? 2 : 0);
}
