import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkFeedbackGas } from "../../src/feedback-gas.js";
import { runCli } from "../../src/cli.js";

vi.mock("../../src/feedback-gas.js", () => ({
	checkFeedbackGas: vi.fn(),
}));

const wallet = {
	subOrgId: "so_cli_feedback",
	walletAddress: "0x000000000000000000000000000000000000000c",
	hmacSecret: "ee".repeat(32),
};

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	fakeHome = await mkdtemp(join(tmpdir(), "kh-cli-feedback-"));
	process.env.HOME = fakeHome;
	await mkdir(join(fakeHome, ".keeperhub"), { recursive: true });
	await writeFile(
		join(fakeHome, ".keeperhub", "wallet.json"),
		JSON.stringify(wallet),
		{ mode: 0o600 },
	);
});

afterEach(async () => {
	process.env.HOME = originalHome;
	await rm(fakeHome, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function captureStdio(): {
	stderrChunks: string[];
	restore: () => void;
} {
	const stderrChunks: string[] = [];
	const origStderr = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	}) as typeof process.stderr.write;
	return {
		stderrChunks,
		restore: (): void => {
			process.stderr.write = origStderr;
		},
	};
}

function trapExit(): {
	codes: (number | undefined)[];
	restore: () => void;
} {
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

describe("CLI feedback", () => {
	it("exits before POSTing feedback when mainnet gas is insufficient", async () => {
		vi.mocked(checkFeedbackGas).mockResolvedValue({
			ok: false,
			code: "INSUFFICIENT_GAS",
			message: "Wallet has 0 ETH on Ethereum mainnet",
			availableWei: "0",
			requiredWei: "5000000000000000",
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const stdio = captureStdio();
		const exit = trapExit();

		try {
			await runCli([
				"node",
				"cli",
				"feedback",
				"--execution-id",
				"exec_low_gas",
				"--value",
				"5",
			]);
		} catch (err) {
			if (!(err as Error).message?.startsWith("EXIT_")) {
				throw err;
			}
		} finally {
			stdio.restore();
			exit.restore();
		}

		expect(exit.codes).toContain(1);
		expect(fetchSpy).not.toHaveBeenCalled();
		const parsed = JSON.parse(stdio.stderrChunks[0] ?? "{}") as {
			code?: string;
			availableWei?: string;
			requiredWei?: string;
		};
		expect(parsed.code).toBe("INSUFFICIENT_GAS");
		expect(parsed.availableWei).toBe("0");
		expect(parsed.requiredWei).toBe("5000000000000000");
	});

	it("includes forceBroadcast:true in the POST body when --force-broadcast is passed", async () => {
		vi.mocked(checkFeedbackGas).mockResolvedValue({
			ok: true,
			availableWei: "10000000000000000",
			requiredWei: "5000000000000000",
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ feedbackId: "fb_force" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		const stdio = captureStdio();
		const exit = trapExit();

		try {
			await runCli([
				"node",
				"cli",
				"feedback",
				"--execution-id",
				"exec_force",
				"--value",
				"5",
				"--force-broadcast",
			]);
		} catch (err) {
			if (!(err as Error).message?.startsWith("EXIT_")) {
				throw err;
			}
		} finally {
			stdio.restore();
			exit.restore();
		}

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const init = fetchSpy.mock.calls[0]?.[1];
		const sentBody = JSON.parse(init?.body as string) as Record<
			string,
			unknown
		>;
		expect(sentBody.forceBroadcast).toBe(true);
		expect(sentBody.executionId).toBe("exec_force");
	});

	it("omits forceBroadcast from the POST body when --force-broadcast is absent", async () => {
		vi.mocked(checkFeedbackGas).mockResolvedValue({
			ok: true,
			availableWei: "10000000000000000",
			requiredWei: "5000000000000000",
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ feedbackId: "fb_plain" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		const stdio = captureStdio();
		const exit = trapExit();

		try {
			await runCli([
				"node",
				"cli",
				"feedback",
				"--execution-id",
				"exec_plain",
				"--value",
				"5",
			]);
		} catch (err) {
			if (!(err as Error).message?.startsWith("EXIT_")) {
				throw err;
			}
		} finally {
			stdio.restore();
			exit.restore();
		}

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const init = fetchSpy.mock.calls[0]?.[1];
		const sentBody = JSON.parse(init?.body as string) as Record<
			string,
			unknown
		>;
		expect(sentBody).not.toHaveProperty("forceBroadcast");
		expect(sentBody.executionId).toBe("exec_plain");
	});
});
