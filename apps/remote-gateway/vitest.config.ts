import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The Gateway tests open real loopback listeners and file stores.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
