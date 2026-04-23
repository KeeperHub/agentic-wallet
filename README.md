# @keeperhub/wallet

Agentic wallet for AI agents. Auto-pays x402 (Base USDC) and MPP (Tempo USDC.e) 402 responses with server-side Turnkey custody. Ships a three-tier PreToolUse safety hook (auto/ask/block).

## Install

```bash
npx @keeperhub/wallet skill install
npx @keeperhub/wallet add
```

`skill install` writes the skill file into every detected agent directory AND registers the `keeperhub-wallet-hook` PreToolUse safety hook in `~/.claude/settings.json`. The alternate `npx skills add keeperhub/agentic-wallet-skills` path installs the skill file only — if you use it, follow up with `npx @keeperhub/wallet skill install` to activate the safety hook.

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
