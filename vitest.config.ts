import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/types.ts", "src/index.ts"],
      thresholds: { lines: 92, functions: 92, statements: 92, branches: 88 },
    },
  },
});
