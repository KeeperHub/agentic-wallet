import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/hook-entrypoint.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  splitting: false,
  minify: false,
  // CJS shim: populate `import.meta.url` from __filename so modules that
  // use `fileURLToPath(import.meta.url)` to resolve on-disk sibling files
  // (skill-install.ts -> skill/ directory) work in the CJS build too.
  // esbuild otherwise emits `var import_meta = {}` leaving .url undefined.
  cjsInterop: true,
  esbuildOptions(options, context): void {
    if (context.format === "cjs") {
      options.define = {
        ...options.define,
        "import.meta.url": "__filename",
      };
    }
  },
});
