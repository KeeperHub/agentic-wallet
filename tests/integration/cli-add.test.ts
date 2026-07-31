// End-to-end for the `add` CLI subcommand driven through runCli() directly
// rather than execFile. runCli() spawns no subprocess so we can override
// process.exit/stdout/stderr and MSW can intercept fetch() to mock
// /provision responses. v0.1.4 removed the `link` subcommand (see KEEP-308).
//
// Home override: beforeEach mkdtemps an isolated home and points both HOME
// (POSIX) and USERPROFILE (Windows) at it; storage.ts re-reads homedir() per
// call so wallet.json lands inside the tempdir. afterEach restores both.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { writeWalletConfig } from "../../src/storage.js";
import { server } from "../setup.js";

type StoredWallet = {
  subOrgId: string;
  walletAddress: `0x${string}`;
  hmacSecret: string;
};

let fakeHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  fakeHome = await mkdtemp(join(tmpdir(), "kh-cli-add-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  await rm(fakeHome, { recursive: true, force: true });
});

type StdioCapture = {
  stdoutChunks: string[];
  stderrChunks: string[];
  restore: () => void;
};

function captureStdio(): StdioCapture {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    stdoutChunks,
    stderrChunks,
    restore: (): void => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

type ExitTrap = {
  codes: (number | undefined)[];
  restore: () => void;
};

function trapExit(): ExitTrap {
  const codes: (number | undefined)[] = [];
  const origExit = process.exit;
  process.exit = ((code?: number): never => {
    codes.push(code);
    throw new Error(`EXIT_${code}`);
  }) as typeof process.exit;
  return {
    codes,
    restore: (): void => {
      process.exit = origExit;
    },
  };
}

async function invokeAdd(
  args: string[] = []
): Promise<{ stdout: string; stderr: string; exitCodes: ExitTrap["codes"] }> {
  const stdio = captureStdio();
  const exit = trapExit();

  try {
    await runCli(["node", "cli", "add", ...args]);
  } catch (err) {
    if (!(err as Error).message?.startsWith("EXIT_")) {
      throw err;
    }
  } finally {
    stdio.restore();
    exit.restore();
  }

  return {
    stdout: stdio.stdoutChunks.join(""),
    stderr: stdio.stderrChunks.join(""),
    exitCodes: exit.codes,
  };
}

describe("CLI add end-to-end", () => {
  it("`add` writes wallet.json with provisioned values from POST /provision", async () => {
    server.use(
      http.post("https://app.keeperhub.com/api/agentic-wallet/provision", () =>
        HttpResponse.json({
          subOrgId: "so_provisioned",
          walletAddress: "0x000000000000000000000000000000000000000b",
          hmacSecret: "ab".repeat(32),
        })
      )
    );

    const result = await invokeAdd();

    const raw = await readFile(
      join(fakeHome, ".keeperhub", "wallet.json"),
      "utf-8"
    );
    const parsed = JSON.parse(raw) as StoredWallet;
    expect(parsed.subOrgId).toBe("so_provisioned");
    expect(parsed.walletAddress).toBe(
      "0x000000000000000000000000000000000000000b"
    );
    expect(parsed.hmacSecret).toBe("ab".repeat(32));

    expect(result.exitCodes).toEqual([]);
    expect(result.stderr).toBe("");
    const combined = result.stdout;
    expect(combined).toContain("subOrgId: so_provisioned");
    expect(combined).toContain(
      "walletAddress: 0x000000000000000000000000000000000000000b"
    );
    // hmacSecret must NEVER appear on stdout (T-34-cli-02)
    expect(combined).not.toContain("ab".repeat(32));
  });

  it("`add` reuses an existing wallet without calling POST /provision or rewriting config", async () => {
    const existing: StoredWallet = {
      subOrgId: "so_existing",
      walletAddress: "0x000000000000000000000000000000000000000c",
      hmacSecret: "cd".repeat(32),
    };
    await writeWalletConfig(existing);

    let provisionCalls = 0;
    server.use(
      http.post("https://app.keeperhub.com/api/agentic-wallet/provision", () => {
        provisionCalls += 1;
        return HttpResponse.json({
          subOrgId: "so_replacement",
          walletAddress: "0x000000000000000000000000000000000000000d",
          hmacSecret: "ef".repeat(32),
        });
      })
    );

    const before = await readFile(
      join(fakeHome, ".keeperhub", "wallet.json"),
      "utf-8"
    );
    const result = await invokeAdd();

    const after = await readFile(
      join(fakeHome, ".keeperhub", "wallet.json"),
      "utf-8"
    );
    expect(provisionCalls).toBe(0);
    expect(after).toBe(before);

    expect(result.exitCodes).toEqual([]);
    expect(result.stderr).toBe("");
    const combined = result.stdout;
    expect(combined).toContain("subOrgId: so_existing");
    expect(combined).toContain(existing.walletAddress);
    expect(combined).toContain("config already exists");
    expect(combined).toContain("--force-new");
    expect(combined).not.toContain(existing.hmacSecret);
  });

  it("`add --force-new` explicitly provisions and replaces an existing wallet config", async () => {
    const existing: StoredWallet = {
      subOrgId: "so_existing",
      walletAddress: "0x000000000000000000000000000000000000000c",
      hmacSecret: "cd".repeat(32),
    };
    await writeWalletConfig(existing);

    let provisionCalls = 0;
    server.use(
      http.post("https://app.keeperhub.com/api/agentic-wallet/provision", () => {
        provisionCalls += 1;
        return HttpResponse.json({
          subOrgId: "so_replacement",
          walletAddress: "0x000000000000000000000000000000000000000d",
          hmacSecret: "ef".repeat(32),
        });
      })
    );

    const result = await invokeAdd(["--force-new"]);

    expect(provisionCalls).toBe(1);
    const raw = await readFile(
      join(fakeHome, ".keeperhub", "wallet.json"),
      "utf-8"
    );
    const parsed = JSON.parse(raw) as StoredWallet;
    expect(parsed).toEqual({
      subOrgId: "so_replacement",
      walletAddress: "0x000000000000000000000000000000000000000d",
      hmacSecret: "ef".repeat(32),
    });

    expect(result.exitCodes).toEqual([]);
    expect(result.stderr).toBe("");
    const combined = result.stdout;
    expect(combined).toContain("subOrgId: so_replacement");
    expect(combined).toContain(parsed.walletAddress);
    expect(combined).not.toContain(existing.hmacSecret);
    expect(combined).not.toContain(parsed.hmacSecret);
  });
});
