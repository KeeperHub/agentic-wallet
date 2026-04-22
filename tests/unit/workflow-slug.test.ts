import { describe, expect, it } from "vitest";
import { extractKeeperHubWorkflowSlug } from "../../src/workflow-slug.js";

describe("extractKeeperHubWorkflowSlug", () => {
  it("extracts slug from production URL", () => {
    const r = extractKeeperHubWorkflowSlug(
      "https://app.keeperhub.com/api/mcp/workflows/my-cool-flow/call"
    );
    expect(r).toEqual({ ok: true, slug: "my-cool-flow" });
  });

  it("extracts slug from staging URL", () => {
    const r = extractKeeperHubWorkflowSlug(
      "https://staging.keeperhub.com/api/mcp/workflows/test-slug/call"
    );
    expect(r).toEqual({ ok: true, slug: "test-slug" });
  });

  it("extracts slug from localhost dev URL with trailing slash", () => {
    const r = extractKeeperHubWorkflowSlug(
      "http://localhost:3000/api/mcp/workflows/dev-flow/call/"
    );
    expect(r).toEqual({ ok: true, slug: "dev-flow" });
  });

  it("extracts slug when query string follows", () => {
    const r = extractKeeperHubWorkflowSlug(
      "https://app.keeperhub.com/api/mcp/workflows/abc123/call?retry=1"
    );
    expect(r).toEqual({ ok: true, slug: "abc123" });
  });

  it("rejects empty URL with EMPTY_URL", () => {
    expect(extractKeeperHubWorkflowSlug("")).toEqual({
      ok: false,
      reason: "EMPTY_URL",
    });
    expect(extractKeeperHubWorkflowSlug(null)).toEqual({
      ok: false,
      reason: "EMPTY_URL",
    });
    expect(extractKeeperHubWorkflowSlug(undefined)).toEqual({
      ok: false,
      reason: "EMPTY_URL",
    });
  });

  it("rejects non-KeeperHub x402 URL with URL_PATTERN_MISMATCH", () => {
    expect(
      extractKeeperHubWorkflowSlug("https://random-x402-service.dev/api/pay")
    ).toEqual({ ok: false, reason: "URL_PATTERN_MISMATCH" });
  });

  it("rejects URL missing /call suffix", () => {
    expect(
      extractKeeperHubWorkflowSlug(
        "https://app.keeperhub.com/api/mcp/workflows/my-flow"
      )
    ).toEqual({ ok: false, reason: "URL_PATTERN_MISMATCH" });
  });

  it("rejects URL with empty slug", () => {
    expect(
      extractKeeperHubWorkflowSlug(
        "https://app.keeperhub.com/api/mcp/workflows//call"
      )
    ).toEqual({ ok: false, reason: "URL_PATTERN_MISMATCH" });
  });

  it("rejects URL with disallowed slug characters", () => {
    expect(
      extractKeeperHubWorkflowSlug(
        "https://app.keeperhub.com/api/mcp/workflows/bad slug/call"
      )
    ).toEqual({ ok: false, reason: "URL_PATTERN_MISMATCH" });
  });
});
