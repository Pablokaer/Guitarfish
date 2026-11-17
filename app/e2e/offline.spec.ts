import type { Page } from "@playwright/test";
import { expect, openApp, test, WONDERWALL } from "./fixtures";

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();

test("save the Songsterr page for offline, find it under Offline, and read it there", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri);
  await expect.poll(() => tauri.embedded().length).toBeGreaterThan(0);

  const save = page.getByRole("button", { name: "Save for offline" }).first();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("#banner")).toContainText("Saved “Wonderwall” for offline");
  // The app shell is asked to capture the embedded Songsterr webview.
  expect(String(tauri.callsTo("snapshot_webview")[0].args.label)).toMatch(/^embed-/);

  await nav(page, "Offline");
  const row = page.locator("#page .row").filter({ hasText: "Wonderwall" });
  await expect(row).toContainText("Oasis");
  await row.click();
  const img = page.locator(".offline-sheet img");
  await expect(img).toHaveCount(1);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  await expect(page.locator(".offline-bar")).toContainText("Wonderwall");

  // Zoom is remembered across pages.
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByRole("button", { name: "Zoom, reset to 100%" })).toHaveText("110%");

  // Saving the same page again replaces the copy instead of adding one.
  await nav(page, "Now Playing");
  await save.click();
  await expect(page.locator("#banner")).toContainText("Saved “Wonderwall” for offline");
  await nav(page, "Offline");
  await expect(page.locator("#page .row")).toHaveCount(1);

  // Delete takes two clicks.
  const del = page.getByRole("button", { name: "Delete the saved page of Wonderwall" });
  await del.click();
  await del.click();
  await expect(page.locator("#page")).toContainText("No pages saved yet");
});

test("offline, the playing song's saved copy opens by itself", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri);
  await expect.poll(() => tauri.embedded().length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Save for offline" }).first().click();
  await expect(page.locator("#banner")).toContainText("Saved “Wonderwall” for offline");

  // Next start, without a connection: Songsterr can't be reached.
  tauri.songsterrDown = true;
  const opened = tauri.embedded().length;
  await page.reload();
  await expect(page.locator("#banner")).toContainText("You're offline: showing your saved copy of “Wonderwall”");
  await expect(page.locator(".offline-sheet img")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Offline", exact: true })).toHaveAttribute("aria-current", "page");
  // The (unreachable) Songsterr page wasn't loaded instead.
  expect(tauri.embedded().length).toBe(opened);
});
