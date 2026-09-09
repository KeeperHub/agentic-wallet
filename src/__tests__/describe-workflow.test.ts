/**
 * KEEP-436: describe_workflow pre-execution probe.
 *
 * Verifies the handler reads the 402 challenge WITHOUT paying — no wallet
 * is provisioned and no USDC moves — and surfaces price + auth mode. Uses
 * the same msw + challenge-fixture pattern as payment-hint.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { __test__ } from "../mcp-server.js";

const RESOURCE_URL =
	"https://app.keeperhub.com/api/mcp/workflows/dw-test/call";

const X402_CHALLENGE = {
	x402Version: 2,
	accepts: [
		{
			scheme: "exact" as const,
			network: "eip155:8453",
			asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			amount: "1000000",
			payTo: "0x0000000000000000000000000000000000000099",
			maxTimeoutSeconds: 60,
			extra: { name: "USD Coin", version: "2" },
		},
	],
	resource: {
		url: RESOURCE_URL,
		description: "dw-test",
		mimeType: "application/json",
	},
};

function makeX402402(): Response {
	const b64 = Buffer.from(JSON.stringify(X402_CHALLENGE)).toString("base64");
	const resp = new Response(JSON.stringify(X402_CHALLENGE), {
		status: 402,
		headers: {
			"PAYMENT-REQUIRED": b64,
			"content-type": "application/json",
		},
	});
	Object.defineProperty(resp, "url", { value: RESOURCE_URL });
	return resp;
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("describe_workflow (KEEP-436)", () => {
	it("reads price + authMode from 402 challenge without paying", async () => {
		server.use(
			http.post(RESOURCE_URL, () => makeX402402()),
		);

		const result = await __test__.handleDescribeWorkflow(
			{ slug: "dw-test" },
			__test__.defaultDeps(),
		);

		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<
			string,
			unknown
		>;
		expect(payload.slug).toBe("dw-test");
		expect(payload.requiresPayment).toBe(true);
		expect(payload.authMode).toBe("x402");
		// 1000000 micro-USDC = 1 USD.
		expect(payload.priceUsd).toBe(1);
	});

	it("reports a free workflow (200, no 402) as requiresPayment:false", async () => {
		server.use(
			http.post(RESOURCE_URL, () => HttpResponse.json({ ok: true })),
		);

		const result = await __test__.handleDescribeWorkflow(
			{ slug: "dw-test" },
			__test__.defaultDeps(),
		);

		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<
			string,
			unknown
		>;
		expect(payload.requiresPayment).toBe(false);
		expect(payload.authMode).toBe("none");
	});

	it("surfaces a structured error for a non-402/non-2xx probe", async () => {
		server.use(
			http.post(RESOURCE_URL, () => new HttpResponse(null, { status: 500 })),
		);

		const result = await __test__.handleDescribeWorkflow(
			{ slug: "dw-test" },
			__test__.defaultDeps(),
		);

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<
			string,
			unknown
		>;
		expect(payload.code).toBe("DESCRIBE_HTTP_500");
	});
});
