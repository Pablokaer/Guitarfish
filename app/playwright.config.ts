import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4317);

/**
 * End-to-end tests of the built UI in Chromium, made to behave as inside Tauri:
 * Tauri's IPC mocks (@tauri-apps/api/mocks) answer the now-playing plugin, the
 * songsterr_search command and the webview calls, scripted per test (see
 * e2e/fixtures.ts and e2e/tauri-mock.ts). The tab catalogue is the browser's real
 * IndexedDB. Run `npm run build` first; the tests use `vite preview` of dist/.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A song change shows at the next poll (every second); a failed Songsterr search is retried after 5 s.
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
