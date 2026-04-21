// CLI dispatcher for `npx @keeperhub/wallet <cmd>`. Ships 5 subcommands:
// add (provision -- NO auth), link (HMAC + KH_SESSION_COOKIE dual-proof),
// fund (pure string-build Coinbase Onramp + Tempo address), balance (unified
// Base USDC + Tempo USDC.e + off-chain KeeperHub credit), info (print
// subOrgId + walletAddress from ~/.keeperhub/wallet.json).
//
// @security The HMAC secret written to wallet.json is NEVER printed to stdout
// or stderr. `add` prints only subOrgId + walletAddress + the config path so
// users can inspect perms. `info` never references the secret at all. Grep
// rule: no process.stdout/process.stderr line in this file should include
// wallet.hmacSecret or data.hmacSecret.
//
// Exit codes: 0 on success, 1 on any error (WalletConfigMissingError,
// HTTP failure, validation error). Uncaught errors are written to stderr.

import { Command } from "commander";
import { checkBalance } from "./balance.js";
import { fund } from "./fund.js";
import { buildHmacHeaders } from "./hmac.js";
import { installSkill } from "./skill-install.js";
import {
  getWalletConfigPath,
  readWalletConfig,
  writeWalletConfig,
} from "./storage.js";
import { WalletConfigMissingError } from "./types.js";

const TRAILING_SLASH = /\/$/;
const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

function resolveBaseUrl(override: string | undefined): string {
  const candidate =
    override ?? process.env.KEEPERHUB_API_URL ?? "https://app.keeperhub.com";
  return candidate.replace(TRAILING_SLASH, "");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function provisionInvalidError(
  message: string
): Error & { code: "PROVISION_RESPONSE_INVALID" } {
  const err = new Error(message) as Error & {
    code: "PROVISION_RESPONSE_INVALID";
  };
  err.code = "PROVISION_RESPONSE_INVALID";
  return err;
}

function validateProvisionResponse(data: unknown): {
  subOrgId: string;
  walletAddress: `0x${string}`;
  hmacSecret: string;
} {
  if (typeof data !== "object" || data === null) {
    throw provisionInvalidError("provision response is not an object");
  }
  const { subOrgId, walletAddress, hmacSecret } = data as Record<
    string,
    unknown
  >;
  if (
    !(
      isNonEmptyString(subOrgId) &&
      isNonEmptyString(walletAddress) &&
      isNonEmptyString(hmacSecret)
    )
  ) {
    throw provisionInvalidError(
      "provision response missing subOrgId, walletAddress, or hmacSecret"
    );
  }
  if (!WALLET_ADDRESS_PATTERN.test(walletAddress)) {
    throw provisionInvalidError(
      `provision response walletAddress is not a valid 0x-prefixed 40-hex address: ${walletAddress}`
    );
  }
  return {
    subOrgId,
    walletAddress: walletAddress as `0x${string}`,
    hmacSecret,
  };
}

async function cmdAdd(opts: { baseUrl?: string } = {}): Promise<void> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const response = await fetch(`${baseUrl}/api/agentic-wallet/provision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    const text = await response.text();
    process.stderr.write(
      `[keeperhub-wallet] provision failed: HTTP ${response.status}: ${text}\n`
    );
    process.exit(1);
  }
  const raw = (await response.json()) as unknown;
  const data = validateProvisionResponse(raw);
  await writeWalletConfig({
    subOrgId: data.subOrgId,
    walletAddress: data.walletAddress,
    hmacSecret: data.hmacSecret,
  });
  // Intentionally print only public fields. The hmacSecret is written to
  // wallet.json (chmod 0o600) but never printed -- T-34-cli-02 mitigation.
  process.stdout.write(`subOrgId: ${data.subOrgId}\n`);
  process.stdout.write(`walletAddress: ${data.walletAddress}\n`);
  process.stdout.write(`config written to ${getWalletConfigPath()}\n`);
}

async function cmdLink(opts: { baseUrl?: string } = {}): Promise<void> {
  const wallet = await readWalletConfig();
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const sessionCookie = process.env.KH_SESSION_COOKIE;
  if (!sessionCookie) {
    process.stderr.write(
      "[keeperhub-wallet] link requires KH_SESSION_COOKIE env var.\n" +
        "Sign in at app.keeperhub.com, copy the session cookie, and re-run with:\n" +
        "  KH_SESSION_COOKIE='<cookie>' npx @keeperhub/wallet link\n"
    );
    process.exit(1);
  }
  const body = JSON.stringify({ subOrgId: wallet.subOrgId });
  const headers = buildHmacHeaders(
    wallet.hmacSecret,
    "POST",
    "/api/agentic-wallet/link",
    wallet.subOrgId,
    body
  );
  const response = await fetch(`${baseUrl}/api/agentic-wallet/link`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      cookie: sessionCookie,
    },
    body,
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    already?: boolean;
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    process.stderr.write(
      `[keeperhub-wallet] link failed: ${json.code ?? response.status}: ${json.error ?? ""}\n`
    );
    process.exit(1);
  }
  if (json.already) {
    process.stdout.write("already linked\n");
    return;
  }
  process.stdout.write("linked\n");
}

async function cmdFund(): Promise<void> {
  const wallet = await readWalletConfig();
  const out = fund(wallet.walletAddress);
  process.stdout.write(`${out.coinbaseOnrampUrl}\n`);
  process.stdout.write(`Tempo address: ${out.tempoAddress}\n`);
  process.stdout.write(`${out.disclaimer}\n`);
}

async function cmdBalance(): Promise<void> {
  const wallet = await readWalletConfig();
  const snap = await checkBalance(wallet);
  process.stdout.write(`Base USDC:         ${snap.base.amount}\n`);
  process.stdout.write(`Tempo USDC.e:      ${snap.tempo.amount}\n`);
  process.stdout.write(
    `KeeperHub credit:  ${snap.offChainCredit.amount} ${snap.offChainCredit.currency}\n`
  );
}

async function cmdInfo(): Promise<void> {
  const wallet = await readWalletConfig();
  process.stdout.write(`subOrgId: ${wallet.subOrgId}\n`);
  process.stdout.write(`walletAddress: ${wallet.walletAddress}\n`);
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("keeperhub-wallet")
    .description(
      "KeeperHub agentic wallet CLI (auto-pay x402 + MPP 402 responses)"
    )
    .version("0.1.0");

  program
    .command("add")
    .description("Provision a new agentic wallet (no account required)")
    .option("--base-url <url>", "KeeperHub API base URL")
    .action(async (opts: { baseUrl?: string }) => {
      await cmdAdd(opts);
    });

  program
    .command("link")
    .description(
      "Link the current wallet to your KeeperHub account (requires KH_SESSION_COOKIE env)"
    )
    .option("--base-url <url>", "KeeperHub API base URL")
    .action(async (opts: { baseUrl?: string }) => {
      await cmdLink(opts);
    });

  program
    .command("fund")
    .description(
      "Print Coinbase Onramp URL (Base USDC) and Tempo deposit address"
    )
    .action(async () => {
      await cmdFund();
    });

  program
    .command("balance")
    .description(
      "Print unified balance: Base USDC + Tempo USDC.e + off-chain KeeperHub credit"
    )
    .action(async () => {
      await cmdBalance();
    });

  program
    .command("info")
    .description("Print subOrgId and walletAddress from local config")
    .action(async () => {
      await cmdInfo();
    });

  program
    .command("skill")
    .description(
      "Install the KeeperHub skill file into detected agent directories"
    )
    .addCommand(
      new Command("install")
        .description(
          "Write skill file + register PreToolUse hook in all detected agents"
        )
        .action(async () => {
          const result = await installSkill();
          for (const write of result.skillWrites) {
            process.stdout.write(
              `skill: ${write.agent} -> ${write.path} (${write.status})\n`
            );
          }
          for (const reg of result.hookRegistrations) {
            if (reg.status === "registered") {
              process.stdout.write(
                `hook: ${reg.agent} -> PreToolUse registered\n`
              );
            } else if (reg.status === "notice") {
              process.stderr.write(
                `notice: ${reg.agent} -> ${reg.message ?? ""}\n`
              );
            }
          }
          if (result.skillWrites.length === 0) {
            process.stderr.write(
              "No supported agent skill directories detected under $HOME. Create ~/.claude/, ~/.cursor/, ~/.cline/, ~/.windsurf/, or ~/.config/opencode/ and re-run.\n"
            );
          }
        })
    );

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof WalletConfigMissingError) {
      process.stderr.write(`[keeperhub-wallet] ${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `[keeperhub-wallet] ${(err as Error).message ?? String(err)}\n`
    );
    process.exit(1);
  }
}
