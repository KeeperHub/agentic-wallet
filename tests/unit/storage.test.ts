import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getWalletConfigPath,
  readWalletConfig,
  writeWalletConfig,
} from "../../src/storage.js";
import { WalletConfigMissingError } from "../../src/types.js";

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "kh-wallet-"));
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(fakeHome, { recursive: true, force: true });
});

describe("storage.ts", () => {
  it("writeWalletConfig writes JSON with chmod 600", async () => {
    await writeWalletConfig({
      subOrgId: "so_1",
      walletAddress: "0xabc",
      hmacSecret: "deadbeef",
    });
    const st = await stat(getWalletConfigPath());
    // mode & 0o777 isolates permission bits
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("readWalletConfig round-trips the written object", async () => {
    await writeWalletConfig({
      subOrgId: "so_1",
      walletAddress: "0xabc",
      hmacSecret: "deadbeef",
    });
    const cfg = await readWalletConfig();
    expect(cfg).toEqual({
      subOrgId: "so_1",
      walletAddress: "0xabc",
      hmacSecret: "deadbeef",
    });
  });

  it("readWalletConfig throws WalletConfigMissingError when file missing", async () => {
    await expect(readWalletConfig()).rejects.toBeInstanceOf(
      WalletConfigMissingError
    );
  });
});
