# @keeperhub/wallet

Agentic wallet for AI agents. Auto-pays x402 (Base USDC) and MPP (Tempo USDC.e) 402 responses with server-side Turnkey custody. Ships a three-tier PreToolUse safety hook (auto/ask/block).

## Install

```bash
npx skills add keeperhub/agentic-wallet-skills
npx @keeperhub/wallet add
```

## First use

```ts
import { paymentSigner } from "@keeperhub/wallet";
const paid = await paymentSigner.pay(await fetch(url));
```

Full walkthrough (safety hooks, approval flow, comparison with agentcash + Coinbase): https://docs.keeperhub.com/ai-tools/agentic-wallet

## License

Apache-2.0
