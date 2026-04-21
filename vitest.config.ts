import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    environment: "node",
    testTimeout: 10_000,
    include: ["tests/**/*.test.ts"],
  },
});
