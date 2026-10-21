import { expect, openApp, test, WONDERWALL } from "./fixtures";

test("first load shows the waiting state", async ({ page, tauri }) => {
  await openApp(page, tauri);
  await expect(page.locator("#np-title")).toHaveText("Waiting for YouTube or Spotify…");
  await expect(page.locator("#status-pill")).toContainText("Waiting for playback");
  await expect(page.locator("#stage-empty")).toContainText("Play something on YouTube or Spotify");
  await expect(page.locator("#banner")).toBeHidden();
  await expect.poll(() => tauri.callsTo("plugin:nowplaying|get_now_playing").length).toBeGreaterThan(1);
  expect(tauri.callsTo("plugin:nowplaying|check_permission")).toHaveLength(1);
  expect(tauri.callsTo("plugin:nowplaying|get_capabilities").length).toBeGreaterThan(0);
});

test("a playing track appears in the player, with its controls", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri);
  await expect(page.locator("#np-title")).toHaveText("Wonderwall");
  await expect(page.locator("#np-artist")).toHaveText("Oasis · E2E Album");
  await expect(page.locator("#np-dur")).toHaveText("3:20");
  await expect(page.locator("#np-pos")).toHaveText(/^1:0\d$/);
  await expect(page.locator("#tools-source")).toHaveText("Spotify");
  const pct = Number(await page.locator("#np-progress").getAttribute("aria-valuenow"));
  expect(pct).toBeGreaterThanOrEqual(32);
  expect(pct).toBeLessThan(40);

  // get_capabilities reported transport controls: they drive Spotify through the plugin.
  await page.getByRole("button", { name: "Next track" }).click();
  await expect.poll(() => tauri.callsTo("plugin:nowplaying|control").map((c) => c.args.action)).toEqual(["next"]);
});

test("in a plain browser nothing is detected, and the app says why", async ({ page }) => {
  await openApp(page, null);
  await expect(page.locator("#banner")).toContainText("Running in a browser: Guitarfish can't see what YouTube or Spotify play here");
  await expect(page.locator("#np-title")).toHaveText("Waiting for YouTube or Spotify…");
  await expect(page.locator("#status-pill")).toContainText("Waiting for playback");
});
