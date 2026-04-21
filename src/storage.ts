import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type WalletConfig, WalletConfigMissingError } from "./types.js";

// NOTE: Every function calls `join(homedir(), ".keeperhub", "wallet.json")`
// itself. Do NOT hoist to a module-level `const WALLET_PATH` -- tests
// override `process.env.HOME` in `beforeEach` and `homedir()` must re-read
// that on each call. A hoisted constant would freeze the harness's original
// HOME at import time and every test would write into the real
// ~/.keeperhub/ directory.

export async function readWalletConfig(): Promise<WalletConfig> {
  const walletPath = join(homedir(), ".keeperhub", "wallet.json");
  let raw: string;
  try {
    raw = await readFile(walletPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WalletConfigMissingError();
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<WalletConfig>;
  if (!(parsed.subOrgId && parsed.walletAddress && parsed.hmacSecret)) {
    throw new Error(`Malformed wallet.json at ${walletPath}`);
  }
  return parsed as WalletConfig;
}

export async function writeWalletConfig(config: WalletConfig): Promise<void> {
  const walletPath = join(homedir(), ".keeperhub", "wallet.json");
  await mkdir(dirname(walletPath), { recursive: true, mode: 0o700 });
  await writeFile(walletPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  // Reassert mode in case the file already existed with looser perms.
  await chmod(walletPath, 0o600);
}

export function getWalletConfigPath(): string {
  return join(homedir(), ".keeperhub", "wallet.json");
}
