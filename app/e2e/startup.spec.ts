import { expect, openApp, test, WONDERWALL } from "./fixtures";

test("first load shows the waiting state", async ({ page, server }) => {
  await openApp(page);
  await expect(page.locator("#np-title")).toHaveText("Waiting for Spotify…");
  await expect(page.locator("#status-pill")).toContainText("Waiting for playback");
  await expect(page.locator("#stage-empty")).toContainText("Play something on Spotify");
  await expect(page.locator("#banner")).toContainText("Running in a browser");
  await expect(page.locator("#spotify-status")).toHaveText("Web API: connected");
  expect(server.callsTo("/v1/spotify/now-playing").length).toBeGreaterThan(0);
});

test("a playing track appears in the player", async ({ page, server }) => {
  server.nowPlaying = WONDERWALL;
  await openApp(page);
  await expect(page.locator("#np-title")).toHaveText("Wonderwall");
  await expect(page.locator("#np-artist")).toHaveText("Oasis · E2E Album");
  await expect(page.locator("#np-dur")).toHaveText("3:20");
  await expect(page.locator("#np-pos")).toHaveText(/^1:0\d$/);
  await expect(page.locator("#tools-source")).toHaveText("Spotify Web API");
  const pct = Number(await page.locator("#np-progress").getAttribute("aria-valuenow"));
  expect(pct).toBeGreaterThanOrEqual(32);
  expect(pct).toBeLessThan(40);
});
