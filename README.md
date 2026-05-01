# @keeperhub/wallet

Agentic wallet for AI agents. Auto-pays x402 (Base USDC) and MPP (Tempo USDC.e) 402 responses with server-side Turnkey custody. Ships a three-tier PreToolUse safety hook (auto/ask/block).

## Install

```bash
npx @keeperhub/wallet skill install
npx @keeperhub/wallet add
```

`skill install` writes the skill file into every detected agent directory AND registers the `keeperhub-wallet-hook` PreToolUse safety hook in `~/.claude/settings.json`. The alternate `npx skills add keeperhub/agentic-wallet-skills` path installs the skill file only — if you use it, follow up with `npx @keeperhub/wallet skill install` to activate the safety hook.

The installer probes `PATH` and chooses the form that will resolve later when your shell fires the hook:

- If `keeperhub-wallet-hook` is on `PATH` (global install or `npm link`), the installer writes the bare command for lowest startup latency.
- Otherwise (the typical `npx @keeperhub/wallet skill install` flow, where the bin is only inside an `npx` cache), it writes `npx -y -p @keeperhub/wallet keeperhub-wallet-hook` so the hook resolves on every fire without a global install.

Override with `KEEPERHUB_WALLET_HOOK_COMMAND` if you need a different command (monorepo bin path, wrapper script, etc.). Re-running `skill install` is idempotent across either form — switching from a global install to npx (or vice versa) replaces the existing entry rather than duplicating it.

## First use

```ts
import { paymentSigner } from "@keeperhub/wallet";

// One-liner: send the same init you'd pass to fetch(); a 402 is paid and
// the retry carries the original body + headers automatically.
const paid = await paymentSigner.fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: "0x..." }),
});
```

For advanced flows where you already hold the 402 `Response`, pass the
original body/headers explicitly so the retry doesn't drop them:

```ts
const paid = await paymentSigner.pay(response402, {
  body: JSON.stringify(payload),
  headers: { "content-type": "application/json" },
});
```

Full walkthrough (safety hooks, approval flow, comparison with agentcash + Coinbase): https://docs.keeperhub.com/ai-tools/agentic-wallet

## License

Apache-2.0
