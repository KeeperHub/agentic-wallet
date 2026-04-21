#!/usr/bin/env node
import { runCli } from "../dist/cli.js";

runCli().catch((err) => {
  process.stderr.write(`[keeperhub-wallet] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
