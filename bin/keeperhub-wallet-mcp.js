#!/usr/bin/env node
import { runMcpServer } from "../dist/mcp-server.js";

function reportCrash(label, err) {
	const detail = err instanceof Error && err.stack ? err.stack : String(err);
	process.stderr.write(`[keeperhub-wallet] ${label}:\n${detail}\n`);
}

process.on("uncaughtException", (err) => {
	reportCrash("uncaughtException", err);
	process.exit(2);
});
process.on("unhandledRejection", (reason) => {
	reportCrash("unhandledRejection", reason);
	process.exit(3);
});

runMcpServer().catch((err) => {
	reportCrash("mcp server crashed", err);
	process.exit(1);
});
