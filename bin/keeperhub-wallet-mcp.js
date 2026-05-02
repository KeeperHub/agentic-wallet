#!/usr/bin/env node
import { runMcpServer } from "../dist/mcp-server.js";

runMcpServer().catch((err) => {
	process.stderr.write(
		`[keeperhub-wallet] mcp server crashed: ${err?.message ?? err}\n`,
	);
	process.exit(1);
});
