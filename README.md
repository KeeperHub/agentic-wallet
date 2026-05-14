# @keeperhub/wallet

> Agent payment client for [KeeperHub](https://keeperhub.com) workflows. Auto-pays `HTTP 402` responses over **x402** (Base USDC) or **MPP** (Tempo USDC.e), binds every payment to a workflow slug, and records an onchain audit trail via the **ERC-8004 ReputationRegistry**.

No hot key. No private key in your shell. Just install, set spending thresholds, and any MCP-aware agent can call paid KeeperHub workflows automatically.

---

## What it does

Four tools, exposed via [Model Context Protocol](https://modelcontextprotocol.io/):

| Tool | What it does | Backed by |
|---|---|---|
| `call_workflow` | Pay-and-invoke a KeeperHub-listed workflow by slug. Handles 402, picks `x402` or `mpp` based on what the server advertises, retries with a signed payment. | Server-side signing + workflow-slug binding |
| `balance` | On-chain USDC balance for both Base and Tempo. | `viem` `balanceOf` against canonical USDC contracts |
| `info` | Public wallet metadata (`subOrgId`, `walletAddress`). The HMAC secret is never returned. | Local `~/.keeperhub/wallet.json` |
| `feedback` | Record ERC-8004 ReputationRegistry feedback for a workflow execution this wallet paid for. Wallet pays gas (~$0.05–2 native ETH). | `giveFeedback()` on Ethereum mainnet |

A Commander-based CLI (`keeperhub-wallet`) and a PreToolUse safety hook (`keeperhub-wallet-hook`) ship in the same package.

---

## Why this exists

The agent-economy primitives are now real:

- **x402** (Coinbase's HTTP-402 payment protocol) is live on Base USDC. Around $24M/month in volume as of early 2026, with ~94k buyers and ~22k sellers.
- **MPP** (Machine Payments Protocol, launched alongside Stripe's Tempo chain on 2026-03-18) integrated 50+ services in its first week — OpenAI, Anthropic, Google Gemini, Dune, Browserbase, Parallel Web Systems, WorkOS. Visa joined as an anchor validator in April 2026.
- **ERC-8004** (Ethereum's agent identity standard, mainnet 2026-01-29) now has 70k+ registered agents.
- **MCP** is the de-facto agent tool-call protocol.

KeeperHub is registered as agent #31875 on the ERC-8004 IdentityRegistry. Workflows published on the marketplace can be called by any MCP-aware agent and paid for over either rail. `@keeperhub/wallet` is the client that closes that loop — it discovers the price, enforces a local spending policy, signs the payment through a managed signer, and writes feedback after.

---

## Install

```bash
npx -p @keeperhub/wallet keeperhub-wallet skill install
```

`skill install` does three things, idempotently:

1. Writes the `keeperhub-wallet` skill file into every detected agent's skills directory (Claude Code, Cursor, Windsurf, OpenCode auto-detected; Cline emits a copy-paste notice).
2. Registers the `keeperhub-wallet-hook` PreToolUse safety hook in `~/.claude/settings.json`.
3. Registers the `keeperhub-wallet` stdio MCP server in each detected agent's MCP config.

On the very first tool call the server provisions a fresh wallet automatically into `~/.keeperhub/wallet.json` — there is no manual `add` step. The provisioned wallet starts at zero balance; the first 402 round-trip surfaces `INSUFFICIENT_FUNDS` with a Coinbase Onramp URL.

---

## Use with Claude Code

After `skill install`, the wallet is wired automatically. Verify with:

```bash
cat ~/.claude.json | jq '.mcpServers.["keeperhub-wallet"]'
```

You should see the `command` and `args` for the stdio server. If you want to register it manually, add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "keeperhub-wallet": {
      "command": "npx",
      "args": ["-y", "-p", "@keeperhub/wallet", "keeperhub-wallet-mcp"]
    }
  }
}
```

## Use with Cursor / Windsurf / OpenCode / Cline

Auto-detected by `skill install`. For Cline (VS Code globalStorage paths are too variant-dependent to auto-detect), the installer prints the exact entry to paste.

For any other MCP-compatible client: it's a standard stdio server, point your client at `npx -y -p @keeperhub/wallet keeperhub-wallet-mcp`.

---

## Example session

In your AI coding agent, just ask:

> Pay $0.10 to call the KeeperHub workflow `aave-v3-rebalance` with my Safe address `0x...`

The agent calls `call_workflow({ slug: "aave-v3-rebalance", body: { safeAddress: "0x..." } })`. The wallet:

1. POSTs to `/api/mcp/workflows/aave-v3-rebalance/call`.
2. Server returns `HTTP 402` with a `PAYMENT-REQUIRED` (x402) or `WWW-Authenticate: Payment` (MPP) header.
3. Wallet checks the local `block_threshold_usd` against the offered amount.
4. Signs an EIP-3009 USDC authorization (x402) or fetches an MPP credential, attaches it to the retry.
5. Returns the workflow output plus a structured `paymentDetails` receipt.

Then:

> Leave 5-star feedback for that execution

The agent calls `feedback({ executionId, value: 5, valueDecimals: 0 })`. The wallet signs and broadcasts `giveFeedback()` on Ethereum mainnet against KeeperHub's ReputationRegistry entry (agent #31875).

---

## Reality check

This wallet pays **KeeperHub-listed workflows** at `/api/mcp/workflows/<slug>/call` URLs. Generic non-KH x402 endpoints throw `UNSUPPORTED_RECIPIENT` today — that's deferred until per-call principal-authorization (AP2) lands. If you want a thin x402 client for arbitrary endpoints, look at [`x402-fetch`](https://www.npmjs.com/package/x402-fetch) or [`agent-discovery-mcp`](https://github.com/Claynsn/agent-discovery-mcp).

What you get instead: every payment is workflow-slug-bound, gated by a configurable PreToolUse policy, and produces an onchain audit trail. Pick this client when the workflow + payment + outcome need to be linked in one verifiable record.

---

## Tools reference

### `call_workflow`
```typescript
{
  slug: string;                            // required, e.g. "aave-v3-rebalance"
  body?: Record<string, unknown>;          // forwarded as workflow input
  paymentHint?: "auto" | "x402" | "mpp";   // protocol preference, default "auto"
  responseFormat?: "text" | "base64" | "json";
}
```

Returns: `{ status, headers, bodyText, paid, responseFormat, protocolUsed, executionId, paymentDetails? }`.

### `balance`
```typescript
{}
```
Returns: `{ base: { amount, address }, tempo: { amount, address } }`.

### `info`
```typescript
{}
```
Returns: `{ subOrgId, walletAddress }`.

### `feedback`
```typescript
{
  executionId: string;       // from a prior call_workflow response
  value: number;             // raw int128 rating
  valueDecimals: number;     // 0..18
  comment?: string;          // max 2000 chars
  agentChainId?: number;     // defaults to 1 (Ethereum)
  agentId?: string;          // defaults to KeeperHub agent 31875
}
```
Returns: `{ feedbackId, txHash, publicUrl, summary }`.

---

## Supported chains

| Chain ID | Network | Payment protocol | Asset |
|---|---|---|---|
| 8453 | Base Mainnet | x402 (v2, EIP-3009) | USDC |
| 4217 | Tempo | MPP | USDC.e |
| 1 | Ethereum Mainnet | — | feedback writes only (native ETH for gas) |

---

## Architecture

```
┌───────────────────────┐   MCP    ┌──────────────────────┐
│  Claude / Cursor /    │  stdio   │  keeperhub-wallet    │
│  OpenCode / Windsurf  │ ───────▶ │  (this server)       │
└───────────────────────┘          └──────────┬───────────┘
                                              │
                ┌─────────────────────────────┼─────────────────────────────┐
                │                             │                             │
                ▼                             ▼                             ▼
       ┌────────────────┐           ┌──────────────────┐           ┌──────────────────┐
       │ PreToolUse     │           │ /api/agentic-    │           │ Base RPC + Tempo │
       │ safety hook    │           │ wallet/sign      │           │ RPC (viem)       │
       │ ~/.keeperhub/  │           │ HMAC-signed,     │           │ balance reads,   │
       │ safety.json    │           │ slug-bound       │           │ ERC-8004 writes  │
       └────────────────┘           └──────────────────┘           └──────────────────┘
```

No hot key on the client. No bundler. No relay. The signer is reached via HMAC-authenticated RPC; the local file at `~/.keeperhub/wallet.json` (chmod 0600) only holds `{ subOrgId, walletAddress, hmacSecret }`.

---

## Safety hook

The PreToolUse hook intercepts every MCP call whose name/args look like a payment shape and applies three thresholds from `~/.keeperhub/safety.json`:

```json
{
  "auto_approve_max_usd": 5,
  "ask_threshold_usd": 50,
  "block_threshold_usd": 100,
  "address_allowlist": []
}
```

- ≤ `auto_approve_max_usd` → pass through.
- `> block_threshold_usd` → deny inline.
- Anything in between → defer to the user.

Defaults are conservative. Edit the file on disk and restart the host; the hook re-reads on every fire.

---

## Install details

The installer probes `PATH` and chooses the form that will resolve later when your shell fires the hook:

- If `keeperhub-wallet-hook` is on `PATH` (global install or `npm link`), the installer writes the bare command for lowest startup latency.
- Otherwise (typical `npx -p @keeperhub/wallet` flow) it writes `npx -y -p @keeperhub/wallet@<version> keeperhub-wallet-hook` so the hook resolves on every fire.

The `npx` form is **pinned to the installer's own version** — never `@latest`. Pinning bounds supply-chain risk; to upgrade, re-run `skill install` from a fresh `npx -p @keeperhub/wallet@<new-version>`.

Override with `KEEPERHUB_WALLET_HOOK_COMMAND` if you need a different command (monorepo bin path, wrapper script). Re-running `skill install` is idempotent — switching between global, npx, or version-bumped npx replaces the existing entry rather than duplicating it. The de-dup matcher inspects only the `command` field; unrelated hooks that mention `keeperhub-wallet-hook` in their `matcher` are preserved.

---

## Roadmap

- [x] x402 v2 on Base (KEEP-176)
- [x] MPP on Tempo (KEEP-176)
- [x] PreToolUse safety hook with three-tier thresholds
- [x] ERC-8004 ReputationRegistry feedback writes
- [ ] Decoded `X-PAYMENT-RESPONSE` and decoded MPP receipts in `call_workflow` output (KEEP-554, KEEP-558)
- [ ] ERC-8004 ReputationRegistry reads (`get_reputation`, `get_agent_card`) — KEEP-554
- [ ] Invite-code onboarding (`redeem_invite`) + `onboardingCta` field — KEEP-554
- [ ] Pre-execution `describe_workflow(slug)` (price + schema + auth mode) — KEEP-436
- [ ] Per-call `maxAmountUsd` parameter on `call_workflow` — KEEP-554
- [ ] Generic non-KH-origin x402 — KEEP-311, blocks on AP2 (KEEP-385)
- [ ] Gas sponsorship for `feedback` via Pimlico paymaster

---

## License

Apache-2.0
