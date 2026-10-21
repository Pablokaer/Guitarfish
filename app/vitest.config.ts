import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/ holds the Playwright specs (npm run e2e).
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts, fretcam.ts and musicview.ts only wire the DOM (camera, canvas, the Music pages)
      // to the modules below, and the workers only wire messages to them; they run in the app and
      // in the e2e tests.
      exclude: ["src/main.ts", "src/fretcam.ts", "src/musicview.ts", "src/neckworker.ts", "src/trackworker.ts"],
      reporter: ["text", "text-summary"],
      // Just below the current numbers, rounded down to a multiple of 5.
      thresholds: { lines: 80, functions: 90, branches: 90, statements: 80 },
    },
  },
});
