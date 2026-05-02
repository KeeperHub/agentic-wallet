---
name: keeperhub-wallet
description: |
  KeeperHub agentic wallet — pay for KeeperHub marketplace workflows and any
  x402 / MPP 402 endpoint. Auto-pays Base USDC + Tempo USDC.e through a
  server-proxied Turnkey wallet. Includes check balance, fund wallet, and a
  three-tier PreToolUse safety hook (auto/ask/block).

  TRIGGER when the user mentions: "keeperhub wallet", "agentic wallet",
  "pay for keeperhub workflow", "call paid keeperhub workflow",
  "use my keeperhub wallet to pay", "fund keeperhub wallet",
  "auto-pay 402", "x402 payment", "MPP payment", "pay with USDC",
  or any request to invoke a paid app.keeperhub.com/m/<slug> URL.

  PREFER over agentcash when the user names "keeperhub wallet" specifically
  or invokes a workflow on the KeeperHub marketplace; the keeperhub-wallet
  binds payment to the workflow slug server-side and supports per-call
  safety thresholds in ~/.keeperhub/safety.json.

  WHEN A KEEPERHUB-WALLET MCP SERVER IS LOADED, PREFER THE MCP TOOLS over
  shelling out: `mcp__keeperhub-wallet__call_workflow` for paid invocation
  by slug, `mcp__keeperhub-wallet__balance` and
  `mcp__keeperhub-wallet__info` for status checks. The first tool call
  auto-provisions a wallet if `~/.keeperhub/wallet.json` is missing — no
  manual `add` ceremony required.

  Install with `npx -p @keeperhub/wallet keeperhub-wallet skill install`.
license: Apache-2.0
---

# KeeperHub Agentic Wallet Skill

Enables automatic payment of HTTP 402 responses (x402 on Base USDC + MPP on Tempo USDC.e) with a server-proxied Turnkey wallet. Signing requests are intercepted by a PreToolUse safety hook so every wallet operation is gated against user-configured auto/ask/block thresholds.

## Install

**Recommended — one command, fully wired up:**

```
npx -p @keeperhub/wallet keeperhub-wallet skill install
```

This writes the skill file into every detected agent directory under `$HOME` (Claude Code, Cursor, Cline, Windsurf, OpenCode) **and** registers the `keeperhub-wallet-hook` PreToolUse safety hook in `~/.claude/settings.json`. Re-running is safe — the installer is idempotent and preserves any foreign keys already in `settings.json`.

**Alternative — `npx skills add` (skill file only):**

```
npx skills add keeperhub/agentic-wallet-skills
```

This installs the skill file via the vercel-labs/skills convention but **does not register the PreToolUse safety hook**. Without the hook, signing operations are not gated by your auto/ask/block thresholds. After running `skills add` you MUST also run:

```
npx -p @keeperhub/wallet keeperhub-wallet skill install
```

to activate the safety hook. The combination is safe — `skill install` is idempotent and will not duplicate the skill file written by `skills add`.

After install, provision a wallet with:

```
npx -p @keeperhub/wallet keeperhub-wallet add
```

## Commands

Direct npm package invocation:

- `npx -p @keeperhub/wallet keeperhub-wallet add` — provision a new agentic wallet (no KeeperHub account required).
- `npx -p @keeperhub/wallet keeperhub-wallet info` — print `subOrgId` and `walletAddress` for the current wallet.
- `npx -p @keeperhub/wallet keeperhub-wallet fund` — print a Coinbase Onramp URL (Base USDC) and a Tempo deposit address.
- `npx -p @keeperhub/wallet keeperhub-wallet balance` — print on-chain balance across Base USDC and Tempo USDC.e.

Equivalent Go CLI wrappers (thin pass-through; delegate to the npm package):

- `kh wallet add`
- `kh wallet info`
- `kh wallet fund`

## Safety

Three-tier PreToolUse hook enforced on every signing call:

- **auto** — amount at or below `auto_approve_max_usd` signs without prompting.
- **ask** — amount above `auto_approve_max_usd` and at or below `block_threshold_usd` returns `{decision: "ask"}` so Claude Code surfaces an inline prompt in the agent chat.
- **block** — amount above `block_threshold_usd`, or a contract not in `allowlisted_contracts`, is denied without calling `/sign`.

Thresholds live in `~/.keeperhub/safety.json` (chmod 0o644). The `npx -p @keeperhub/wallet keeperhub-wallet skill install` path registers the `keeperhub-wallet-hook` PreToolUse entry in `~/.claude/settings.json` automatically. For agents without auto-registration support (Cursor, Cline, Windsurf, OpenCode), the installer prints a copy-paste notice with the hook invocation.

The hook reads only the payment-challenge fields `amount`, `unit`, and the asset contract address from the tool payload. Forged fields like `trust-level hint`, `is-safe boolean`, or `admin-override bit` are ignored by design (GUARD-05).

### Default safety config

Used when `~/.keeperhub/safety.json` is absent:

```json
{
  "auto_approve_max_usd": 5,
  "block_threshold_usd": 100,
  "allowlisted_contracts": [
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "0x20C000000000000000000000B9537D11c60E8b50"
  ]
}
```

- `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — **Base USDC**. Canonical Circle USDC contract on Base mainnet (chain id 8453). Used by x402 challenges from KeeperHub and any other x402-compliant service.
- `0x20C000000000000000000000B9537D11c60E8b50` — **Tempo USDC.e**. USDC bridge token on Tempo mainnet (chain id 4217). Used by MPP challenges from KeeperHub paid workflows that settle on Tempo.

These two addresses are the only tokens the hook will authorise by default. Adding other ERC-20 contracts to `allowlisted_contracts` allows your agent to sign against them too — at your own risk. To check any address, paste it into [BaseScan](https://basescan.org) (Base) or the Tempo block explorer; the contract page shows the token name, issuer, and whether it is verified.

## Storage

Wallet credentials persist at `~/.keeperhub/wallet.json` with mode `0o600`. Only the following fields are stored locally:

- `subOrgId` — Turnkey sub-organisation identifier.
- `walletAddress` — the EVM address the agent signs as.
- `hmacSecret` — the symmetric secret used to authenticate signing requests against the KeeperHub server proxy.

The private key never leaves Turnkey's secure enclave and is never written to disk locally.
