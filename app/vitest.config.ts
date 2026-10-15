import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts only wires the DOM to the modules below; it runs in the app, not in tests.
      exclude: ["src/main.ts"],
      reporter: ["text", "text-summary"],
      // Just below the current numbers, rounded down to a multiple of 5.
      thresholds: { lines: 80, functions: 90, branches: 90, statements: 80 },
    },
  },
});
