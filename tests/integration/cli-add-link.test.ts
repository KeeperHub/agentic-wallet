// End-to-end for the `add` + `link` CLI subcommands driven through
// runCli() directly rather than execFile. runCli() spawns no subprocess
// so we can override process.exit/stdout/stderr and MSW can intercept
// fetch() to mock /provision + /link responses.
//
// HOME override: beforeEach mkdtemps a fake $HOME and points process.env.HOME
// at it; storage.ts re-reads homedir() per call so wallet.json lands inside
// the tempdir. afterEach restores the original HOME.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { server } from "../setup.js";

type StoredWallet = {
  subOrgId: string;
  walletAddress: string;
  hmacSecret: string;
};

let fakeHome: string;
let originalHome: string | undefined;
let originalSessionCookie: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalSessionCookie = process.env.KH_SESSION_COOKIE;
  fakeHome = await mkdtemp(join(tmpdir(), "kh-cli-add-"));
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  if (originalSessionCookie === undefined) {
    // biome-ignore lint/performance/noDelete: env.X=undefined coerces to the string "undefined"; delete is required to truly unset
    delete process.env.KH_SESSION_COOKIE;
  } else {
    process.env.KH_SESSION_COOKIE = originalSessionCookie;
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

describe("CLI add + link end-to-end", () => {
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

    const stdio = captureStdio();
    const exit = trapExit();

    try {
      await runCli(["node", "cli", "add"]);
    } catch (err) {
      if (!(err as Error).message?.startsWith("EXIT_")) {
        throw err;
      }
    } finally {
      stdio.restore();
      exit.restore();
    }

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

    const combined = stdio.stdoutChunks.join("");
    expect(combined).toContain("subOrgId: so_provisioned");
    expect(combined).toContain(
      "walletAddress: 0x000000000000000000000000000000000000000b"
    );
    // hmacSecret must NEVER appear on stdout (T-34-cli-02)
    expect(combined).not.toContain("ab".repeat(32));
  });

  it("`link` without KH_SESSION_COOKIE exits 1 with actionable stderr", async () => {
    // Seed a wallet.json so readWalletConfig succeeds
    await mkdir(join(fakeHome, ".keeperhub"), { recursive: true });
    await writeFile(
      join(fakeHome, ".keeperhub", "wallet.json"),
      JSON.stringify({
        subOrgId: "so_x",
        walletAddress: "0x000000000000000000000000000000000000000c",
        hmacSecret: "cd".repeat(32),
      })
    );

    // biome-ignore lint/performance/noDelete: env.X=undefined coerces to the string "undefined"; delete is required to truly unset
    delete process.env.KH_SESSION_COOKIE;

    const stdio = captureStdio();
    const exit = trapExit();

    try {
      await runCli(["node", "cli", "link"]);
    } catch (err) {
      if (!(err as Error).message?.startsWith("EXIT_")) {
        throw err;
      }
    } finally {
      stdio.restore();
      exit.restore();
    }

    expect(exit.codes).toContain(1);
    const errOut = stdio.stderrChunks.join("");
    expect(errOut).toContain("KH_SESSION_COOKIE");
  });
});
