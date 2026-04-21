#!/usr/bin/env node
import { runHookCli } from "../dist/hook-entrypoint.js";

runHookCli().catch((err) => {
  process.stderr.write(
    `[keeperhub-wallet] hook crashed: ${err?.message ?? err}\n`
  );
  process.exit(2);
});
