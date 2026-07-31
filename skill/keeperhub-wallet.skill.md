---
name: keeperhub-wallet
description: |
  KeeperHub agentic wallet — pay for KeeperHub-listed marketplace workflows
  that advertise x402 or MPP. Auto-pays Base USDC + Tempo USDC.e through a
  server-proxied Turnkey wallet. Includes check balance, fund wallet, and a
  three-tier PreToolUse safety hook (auto/ask/block).

  TRIGGER when the user mentions: "keeperhub wallet", "agentic wallet",
  "pay for keeperhub workflow", "call paid keeperhub workflow",
  "use my keeperhub wallet to pay", "fund keeperhub wallet",
  "auto-pay KeeperHub 402", "KeeperHub x402 payment", "KeeperHub MPP payment",
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

Enables automatic payment of KeeperHub-listed workflow 402 responses (x402 on Base USDC + MPP on Tempo USDC.e) with a server-proxied Turnkey wallet. A PreToolUse hook gates payment-shaped tool inputs against user-configured auto/ask/block thresholds, while `call_workflow` also checks the discovered x402 amount against the local block threshold before signing.

## Install

**Recommended — full install in one command:**

```
npx -p @keeperhub/wallet keeperhub-wallet skill install
```

This writes the skill file into every detected agent directory under `$HOME` (Claude Code, Cursor, Cline, Windsurf, OpenCode), registers the `keeperhub-wallet` MCP server for clients with a known config format, and registers the `keeperhub-wallet-hook` PreToolUse safety hook for Claude Code. When a client cannot be configured safely (Cline MCP registration or non-Claude hook formats), the installer prints an explicit manual-registration notice. Re-running is safe: registration is idempotent and preserves unrelated config.

If you intentionally want the skill text only, `npx skills add keeperhub/agentic-wallet-skills` installs it through the skills convention. That command does **not** configure the MCP server or PreToolUse hook, so it is not a replacement for the full install above.

There is no separate provisioning step. The first MCP tool call provisions `~/.keeperhub/wallet.json` automatically when it is missing.

## Commands

Direct npm package invocation:

- `npx -p @keeperhub/wallet keeperhub-wallet add` — ensure a local agentic wallet exists; an existing valid config is reported and left unchanged.
- `npx -p @keeperhub/wallet keeperhub-wallet add --force-new` — intentionally provision a replacement config. Use with care: the previous wallet may still hold funds.
- `npx -p @keeperhub/wallet keeperhub-wallet info` — print `subOrgId` and `walletAddress` for the current wallet.
- `npx -p @keeperhub/wallet keeperhub-wallet fund` — print a Coinbase Onramp URL (Base USDC) and a Tempo deposit address.
- `npx -p @keeperhub/wallet keeperhub-wallet balance` — print on-chain balance across Base USDC and Tempo USDC.e.

Equivalent Go CLI wrappers (thin pass-through; delegate to the npm package):

- `kh wallet add`
- `kh wallet info`
- `kh wallet fund`

## Safety

The PreToolUse hook applies three tiers when a visible tool input contains a payment amount and/or asset contract:

- **auto** — amount at or below `auto_approve_max_usd` signs without prompting.
- **ask** — amount above `auto_approve_max_usd` and at or below `block_threshold_usd` returns `{decision: "ask"}` so Claude Code surfaces an inline prompt in the agent chat.
- **block** — amount above `block_threshold_usd`, or a contract not in `allowlisted_contracts`, is denied without calling `/sign`.

Thresholds live in `~/.keeperhub/safety.json` (chmod 0o644). The `npx -p @keeperhub/wallet keeperhub-wallet skill install` path registers the `keeperhub-wallet-hook` PreToolUse entry in `~/.claude/settings.json` automatically. For agents without auto-registration support (Cursor, Cline, Windsurf, OpenCode), the installer prints a manual-registration notice.

The hook reads only the payment-challenge fields `amount`, `unit`, and the asset contract address from the tool payload. Forged fields like `trust-level hint`, `is-safe boolean`, or `admin-override bit` are ignored by design (GUARD-05).

### Default safety config

Used when `~/.keeperhub/safety.json` is absent:

```json
{
  "auto_approve_max_usd": 5,
  "ask_threshold_usd": 50,
  "block_threshold_usd": 100,
  "allowlisted_contracts": [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0x20c000000000000000000000b9537d11c60e8b50"
  ]
}
```

- `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` — **Base USDC**. Canonical Circle USDC contract on Base mainnet (chain id 8453). Used by x402 challenges from KeeperHub-listed workflows.
- `0x20c000000000000000000000b9537d11c60e8b50` — **Tempo USDC.e**. USDC bridge token on Tempo mainnet (chain id 4217). Used by MPP challenges from KeeperHub paid workflows that settle on Tempo.

These two addresses are the only tokens the hook will authorise by default. This is a local guard, not a server capability switch: removing entries makes local policy stricter, while adding an ERC-20 address does **not** widen KeeperHub's server-side Turnkey allowlist or enable payments for that asset.

This wallet only signs for KeeperHub-listed `/api/mcp/workflows/<slug>/call` URLs. Arbitrary x402 or MPP endpoints remain unsupported and fail with `UNSUPPORTED_RECIPIENT`, regardless of local `allowlisted_contracts` edits.

## Storage

Wallet credentials persist at `~/.keeperhub/wallet.json` with mode `0o600`. Only the following fields are stored locally:

- `subOrgId` — Turnkey sub-organisation identifier.
- `walletAddress` — the EVM address the agent signs as.
- `hmacSecret` — the symmetric secret used to authenticate signing requests against the KeeperHub server proxy.

The private key never leaves Turnkey's secure enclave and is never written to disk locally.
