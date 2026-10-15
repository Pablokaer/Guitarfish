import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The entry point only starts the HTTP server; scripts/ are one-off CLI tools.
      exclude: ["src/index.ts"],
      reporter: ["text", "text-summary"],
      // Just below the current numbers, rounded down to a multiple of 5.
      thresholds: { lines: 75, functions: 75, branches: 70, statements: 75 },
    },
  },
});
