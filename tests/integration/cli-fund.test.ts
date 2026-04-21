// SC-4 end-to-end: `npx @keeperhub/wallet fund` prints a valid Coinbase
// Onramp URL + Tempo address to stdout. Invokes the built binary via
// execFile so the whole pipeline (shebang -> dist/cli.js -> fund() string
// build) is exercised. Requires `pnpm build` to have run before this suite.
//
// Isolation: each test mkdtemp's a fake HOME with a seeded wallet.json so
// the execFile child points at an ephemeral ~/.keeperhub/ directory.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileP = promisify(execFile);
const BIN = resolve(import.meta.dirname, "../../bin/keeperhub-wallet.js");

const wallet = {
  subOrgId: "so_cli_fund",
  walletAddress: "0x000000000000000000000000000000000000000a" as const,
  hmacSecret: "ee".repeat(32),
};

const HTTPS_PREFIX = /^https:\/\//;

let fakeHome: string;

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "kh-cli-"));
  await mkdir(join(fakeHome, ".keeperhub"), { recursive: true });
  await writeFile(
    join(fakeHome, ".keeperhub", "wallet.json"),
    JSON.stringify(wallet),
    { mode: 0o600 }
  );
});

afterEach(async () => {
  await rm(fakeHome, { recursive: true, force: true });
});

describe("CLI fund end-to-end (SC-4)", () => {
  it("`keeperhub-wallet fund` prints a valid URL + Tempo address to stdout", async () => {
    const { stdout, stderr } = await execFileP("node", [BIN, "fund"], {
      env: { ...process.env, HOME: fakeHome },
    });
    expect(stderr).toBe("");
    expect(stdout).toContain("pay.coinbase.com/buy/select-asset");
    expect(stdout).toContain(`Tempo address: ${wallet.walletAddress}`);
    // URL parses as valid
    const urlLine = stdout
      .split("\n")
      .find((l: string) => HTTPS_PREFIX.test(l));
    expect(urlLine).toBeDefined();
    expect(() => new URL(urlLine ?? "")).not.toThrow();
  });
});
