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
- Otherwise (the typical `npx @keeperhub/wallet skill install` flow, where the bin is only inside an `npx` cache), it writes `npx -y -p @keeperhub/wallet@<version> keeperhub-wallet-hook` so the hook resolves on every fire without a global install.

The `npx` form is **pinned to the installer's own version** — never `@latest`. Pinning bounds supply-chain risk: `npx -y` runs whatever is in the registry, so a `latest`-pulling hook would execute new code on every tool call after any future scope compromise. To upgrade, re-run `skill install` from a fresh `npx @keeperhub/wallet@<new-version>`.

Override with `KEEPERHUB_WALLET_HOOK_COMMAND` if you need a different command (monorepo bin path, wrapper script, etc.) — it is written verbatim into `settings.json`, so treat it as trusted input. Re-running `skill install` is idempotent across either form: switching between global, npx, or version-bumped npx replaces the existing entry rather than duplicating it. The de-dup matcher only inspects the `command` field of each hook, so unrelated entries that mention `keeperhub-wallet-hook` in their `matcher` or args are preserved.

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
