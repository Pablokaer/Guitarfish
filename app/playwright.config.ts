import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4317);

/**
 * End-to-end tests of the UI in a plain browser (no Tauri): the Guitarfish server
 * and Spotify are faked per test with page.route (see e2e/fixtures.ts).
 * Run `npm run build` first; the tests use `vite preview` of dist/.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The Spotify Web API fallback is polled every 3 s, so a song change takes a few seconds.
  expect: { timeout: 10_000 },
  timeout: 45_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
