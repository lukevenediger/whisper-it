import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/unit/python/**", "tests/e2e/**", "node_modules/**", "dist/**"],
    environment: "node",
    pool: "forks",
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/public/**", "dist/**"],
    },
  },
});
