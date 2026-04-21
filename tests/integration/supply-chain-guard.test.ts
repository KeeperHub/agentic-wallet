import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("supply-chain guard (DIST-03)", () => {
  it("package.json has no postinstall, preinstall, or install script", async () => {
    const raw = await readFile(
      resolve(import.meta.dirname, "../../package.json"),
      "utf-8"
    );
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    expect(
      scripts.postinstall,
      "postinstall is a supply-chain vector (DIST-03)"
    ).toBeUndefined();
    expect(
      scripts.preinstall,
      "preinstall is a supply-chain vector (DIST-03)"
    ).toBeUndefined();
    expect(
      scripts.install,
      "install is a supply-chain vector (DIST-03)"
    ).toBeUndefined();
  });

  it("viem and commander are pinned to exact versions (no semver ranges)", async () => {
    const raw = await readFile(
      resolve(import.meta.dirname, "../../package.json"),
      "utf-8"
    );
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};
    expect(deps.viem).toBe("2.48.1");
    expect(deps.commander).toBe("14.0.3");
    for (const [name, range] of Object.entries(deps)) {
      expect(
        range.startsWith("^") || range.startsWith("~"),
        `${name} uses floating range ${range}`
      ).toBe(false);
    }
  });

  it("bin entries are declared for keeperhub-wallet and keeperhub-wallet-hook", async () => {
    const raw = await readFile(
      resolve(import.meta.dirname, "../../package.json"),
      "utf-8"
    );
    const pkg = JSON.parse(raw) as { bin?: Record<string, string> };
    expect(pkg.bin?.["keeperhub-wallet"]).toBe("./bin/keeperhub-wallet.js");
    expect(pkg.bin?.["keeperhub-wallet-hook"]).toBe(
      "./bin/keeperhub-wallet-hook.js"
    );
  });

  it("files entry includes dist, bin, README, LICENSE -- no extraneous paths", async () => {
    const raw = await readFile(
      resolve(import.meta.dirname, "../../package.json"),
      "utf-8"
    );
    const pkg = JSON.parse(raw) as { files?: string[] };
    expect(pkg.files).toEqual(
      expect.arrayContaining(["dist", "bin", "README.md"])
    );
    // No accidentally-included src/ or tests/ in the published tarball.
    expect(pkg.files).not.toContain("src");
    expect(pkg.files).not.toContain("tests");
    expect(pkg.files).not.toContain(".env");
    expect(pkg.files).not.toContain(".planning");
  });

  it("devDependencies also use exact pins (no floating ranges)", async () => {
    const raw = await readFile(
      resolve(import.meta.dirname, "../../package.json"),
      "utf-8"
    );
    const pkg = JSON.parse(raw) as {
      devDependencies?: Record<string, string>;
    };
    // Guard against a future refactor that removes devDependencies entirely,
    // which would make the loop below vacuously pass.
    expect(Object.keys(pkg.devDependencies ?? {}).length).toBeGreaterThan(0);
    for (const [name, range] of Object.entries(pkg.devDependencies ?? {})) {
      expect(
        range.startsWith("^") || range.startsWith("~"),
        `dev ${name} uses floating range ${range}`
      ).toBe(false);
    }
  });

  it("files entry includes skill/ so the .skill.md ships in the published tarball (DIST-01)", async () => {
    const raw = await readFile(
      resolve(import.meta.dirname, "../../package.json"),
      "utf-8"
    );
    const pkg = JSON.parse(raw) as { files?: string[] };
    expect(pkg.files).toEqual(expect.arrayContaining(["skill"]));
  });
});
