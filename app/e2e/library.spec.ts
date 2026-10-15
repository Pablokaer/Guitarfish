import { expect, openApp, test, WONDERWALL } from "./fixtures";
import type { Page } from "@playwright/test";

const now = Date.now();
const HISTORY = [
  { url: "https://www.songsterr.com/a/wsa/oasis-wonderwall-tab-s11", songId: 11, title: "Wonderwall", artist: "Oasis", at: now - 5 * 60_000 },
  { url: "https://www.songsterr.com/a/wsa/oasis-champagne-supernova-tab-s12", songId: 12, title: "Champagne Supernova", artist: "Oasis", at: now - 3 * 3_600_000 },
];

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const rows = (page: Page) => page.locator("#page .rows .row-title");

// History and favorites live in localStorage only: seeded here as if the tabs had been opened before.
test("history lists opened tabs, newest first, and can be cleared", async ({ page, tauri }) => {
  await openApp(page, tauri, { "tabsync.history": HISTORY });
  await expect(page.locator("#recent .r-title")).toHaveText(["Wonderwall", "Champagne Supernova"]);

  await nav(page, "History");
  await expect(page.locator("#page").getByRole("heading", { name: "History" })).toBeVisible();
  await expect(rows(page)).toHaveText(["Wonderwall", "Champagne Supernova"]);
  await expect(page.locator("#page .row-meta")).toHaveText(["5 min ago", "3 h ago"]);

  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(page.locator("#page")).toContainText("Tabs you open appear here.");
  await expect(page.locator("#recent")).toContainText("Tabs you open appear here.");
  await page.reload();
  await expect(page.locator("#recent")).toContainText("Tabs you open appear here.");
});

test("favorites: add from history, list, remove, and persist across reloads", async ({ page, tauri }) => {
  await openApp(page, tauri, { "tabsync.history": HISTORY });
  await nav(page, "Favorites");
  await expect(page.locator("#page")).toContainText("Save tabs with the star in the toolbar.");

  await nav(page, "History");
  const star = page.locator("#page .row-wrap", { hasText: "Champagne Supernova" }).getByRole("button", { name: "Save to favorites" });
  await star.click();
  await expect(page.locator("#page .row-wrap", { hasText: "Champagne Supernova" }).getByRole("button", { name: "Remove from favorites" })).toHaveAttribute("aria-pressed", "true");

  await nav(page, "Favorites");
  await expect(rows(page)).toHaveText(["Champagne Supernova"]);

  await page.reload();
  await nav(page, "Favorites");
  await expect(rows(page)).toHaveText(["Champagne Supernova"]);

  await page.getByRole("button", { name: "Remove from favorites" }).click();
  await expect(page.locator("#page")).toContainText("Save tabs with the star in the toolbar.");
  await page.reload();
  await nav(page, "Favorites");
  await expect(page.locator("#page")).toContainText("Save tabs with the star in the toolbar.");
  await nav(page, "History");
  await expect(rows(page)).toHaveText(["Wonderwall", "Champagne Supernova"]);
});

test("opening a Songsterr page adds it to history, on this device", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri);
  await expect(page.locator("#recent .r-title")).toHaveText(["Wonderwall"]);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("tabsync.history") ?? "[]"));
  expect(stored).toEqual([expect.objectContaining({ songId: 11, title: "Wonderwall", artist: "Oasis", url: "https://www.songsterr.com/a/wa/song?id=11" })]);

  await page.getByRole("button", { name: "Save to favorites" }).first().click();
  await nav(page, "Favorites");
  await expect(rows(page)).toHaveText(["Wonderwall"]);
});
