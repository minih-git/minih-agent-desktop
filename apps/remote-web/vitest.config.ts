import { defineConfig } from "vitest/config";

/**
 * Pure-logic tests only: the reducers, ticket parsing, the registry, the
 * credential port, the reconnect schedule, the command builders and the
 * catalog parity check. There is deliberately no DOM environment, so a
 * component cannot silently depend on `document` to pass.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
