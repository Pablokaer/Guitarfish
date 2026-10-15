import { expect, LOCAL_VIEW, openApp, test, WONDERWALL } from "./fixtures";

test("a failed Songsterr search shows Songsterr as unreachable, and recovers", async ({ page, tauri }) => {
  tauri.songsterrDown = true;
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri);

  const pill = page.locator("#status-pill");
  await expect(pill).toContainText("Songsterr unreachable");
  await expect(page.locator("#tools-status")).toHaveText("Songsterr unreachable");
  await expect(page.locator("#tools-status-detail")).toHaveText("You may be offline, or Songsterr isn't answering. Retrying…");
  // No server any more: no banner, no server address.
  await expect(page.locator("#banner")).toBeHidden();
  await expect(page.locator("body")).not.toContainText(/tab server|127\.0\.0\.1/i);
  // Meanwhile Songsterr's own search page is shown.
  await expect.poll(() => tauri.embedded()).toEqual(["https://www.songsterr.com/?pattern=Oasis%20Wonderwall"]);

  tauri.songsterrDown = false;
  // The search is retried every 5 s.
  await expect(pill).toContainText("Tablature found", { timeout: 15_000 });
  expect(tauri.embedded().at(-1)).toBe("https://www.songsterr.com/a/wa/song?id=11");
  expect(tauri.callsTo("songsterr_search").length).toBeGreaterThan(1);
});

test("the local catalogue works while Songsterr is unreachable", async ({ page, tauri }) => {
  tauri.songsterrDown = true;
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri, LOCAL_VIEW);
  await expect(page.locator("#status-pill")).toContainText("Songsterr unreachable");
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Oasis – Wonderwall");
  await expect(page.locator("#tab .at-surface svg").first()).toBeVisible();
});
