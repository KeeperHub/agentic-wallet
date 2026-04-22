---
name: keeperhub-wallet
description: Pay x402 and MPP 402 responses with a server-proxied Turnkey wallet. Auto-pays Base USDC + Tempo USDC.e. Includes check balance, fund wallet, and three-tier safety hook (auto/ask/block). Install with `npx @keeperhub/wallet skill install`.
version: 0.1.2
license: Apache-2.0
---

# KeeperHub Agentic Wallet Skill

Enables automatic payment of HTTP 402 responses (x402 on Base USDC + MPP on Tempo USDC.e) with a server-proxied Turnkey wallet. Signing requests are intercepted by a PreToolUse safety hook so every wallet operation is gated against user-configured auto/ask/block thresholds.

## Install

**Recommended — one command, fully wired up:**

```
npx @keeperhub/wallet skill install
```

This writes the skill file into every detected agent directory under `$HOME` (Claude Code, Cursor, Cline, Windsurf, OpenCode) **and** registers the `keeperhub-wallet-hook` PreToolUse safety hook in `~/.claude/settings.json`. Re-running is safe — the installer is idempotent and preserves any foreign keys already in `settings.json`.

**Alternative — `npx skills add` (skill file only):**

```
npx skills add keeperhub/agentic-wallet-skills
```

This installs the skill file via the vercel-labs/skills convention but **does not register the PreToolUse safety hook**. Without the hook, signing operations are not gated by your auto/ask/block thresholds. After running `skills add` you MUST also run:

```
npx @keeperhub/wallet skill install
```

to activate the safety hook. The combination is safe — `skill install` is idempotent and will not duplicate the skill file written by `skills add`.

After install, provision a wallet with:

```
npx @keeperhub/wallet add
```

## Commands

Direct npm package invocation:

- `npx @keeperhub/wallet add` — provision a new agentic wallet (no KeeperHub account required).
- `npx @keeperhub/wallet info` — print `subOrgId` and `walletAddress` for the current wallet.
- `npx @keeperhub/wallet fund` — print a Coinbase Onramp URL (Base USDC) and a Tempo deposit address.
- `npx @keeperhub/wallet link` — link the current wallet to a KeeperHub account (requires `KH_SESSION_COOKIE`).
- `npx @keeperhub/wallet balance` — print unified balance across Base USDC, Tempo USDC.e, and off-chain KeeperHub credit.

Equivalent Go CLI wrappers (thin pass-through; delegate to the npm package):

- `kh wallet add`
- `kh wallet info`
- `kh wallet fund`
- `kh wallet link`

## Safety

Three-tier PreToolUse hook enforced on every signing call:

- **auto** — amount below `auto_approve_max_usd` signs without prompting.
- **ask** — amount between `auto_approve_max_usd` and `ask_threshold_usd` surfaces an approval prompt in-chat.
- **block** — amount above `block_threshold_usd` or contract not in `allowlisted_contracts` denies outright.

Thresholds live in `~/.keeperhub/safety.json` (chmod 0o644). The `npx @keeperhub/wallet skill install` path registers the `keeperhub-wallet-hook` PreToolUse entry in `~/.claude/settings.json` automatically. For agents without auto-registration support (Cursor, Cline, Windsurf, OpenCode), the installer prints a copy-paste notice with the hook invocation.

The hook reads only `tool_input.amount`, `tool_input.unit`, and `tool_input.to` — forged fields such as `trust-level hint`, `is-safe boolean`, or `admin-override bit` on the tool input are ignored by design (GUARD-05).

## Storage

Wallet credentials persist at `~/.keeperhub/wallet.json` with mode `0o600`. Only the following fields are stored locally:

- `subOrgId` — Turnkey sub-organisation identifier.
- `walletAddress` — the EVM address the agent signs as.
- `hmacSecret` — the symmetric secret used to authenticate signing requests against the KeeperHub server proxy.

The private key never leaves Turnkey's secure enclave and is never written to disk locally.
