import { expect, openApp, test } from "./fixtures";
import type { Page } from "@playwright/test";

const searchFor = async (page: Page, q: string) => {
  await page.getByRole("searchbox", { name: "Search Songsterr" }).fill(q);
  await page.getByRole("searchbox", { name: "Search Songsterr" }).press("Enter");
};

test("the Search page asks for a query when there is none", async ({ page, tauri }) => {
  await openApp(page, tauri);
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Search" }).click();
  const pageLayer = page.locator("#page");
  await expect(pageLayer.getByRole("heading", { name: "Search" })).toBeVisible();
  await expect(pageLayer.getByText("Type an artist or song.")).toHaveCount(2);
  await expect(pageLayer.getByRole("searchbox", { name: "Search" })).toBeFocused();
});

test("manual search lists Songsterr results and my tabs", async ({ page, tauri }) => {
  await openApp(page, tauri);
  await searchFor(page, "Oasis");

  const pageLayer = page.locator("#page");
  await expect(pageLayer.getByRole("heading", { name: "Search" })).toBeVisible();
  const songsterr = pageLayer.locator('[data-slot="songsterr"]');
  const local = pageLayer.locator('[data-slot="local"]');
  await expect(songsterr.locator(".row-title")).toHaveText(["Wonderwall", "Champagne Supernova", "Open Songsterr's search page"]);
  await expect(local.locator(".row-title")).toHaveText(["Wonderwall", "Champagne Supernova"]);
  expect(tauri.callsTo("songsterr_search").at(-1)?.args.query).toBe("Oasis");

  // A new query from the page's own form replaces the results.
  await pageLayer.getByRole("searchbox", { name: "Search" }).fill("Supernova");
  await pageLayer.getByRole("button", { name: "Search", exact: true }).click();
  await expect(songsterr.locator(".row-title")).toHaveText(["Champagne Supernova", "Open Songsterr's search page"]);
  await expect(local.locator(".row-title")).toHaveText(["Champagne Supernova"]);

  // A Songsterr result opens in the embedded Songsterr view.
  await songsterr.getByRole("button", { name: /Champagne Supernova/ }).click();
  await expect(page.locator("#page")).toBeHidden();
  await expect(page.locator("#tb-title")).toHaveText("Songsterr · Oasis – Champagne Supernova");
  expect(tauri.embedded().at(-1)).toBe("https://www.songsterr.com/a/wa/song?id=12");

  // One of my tabs opens in the local viewer.
  await searchFor(page, "Supernova");
  await local.getByRole("button", { name: /Champagne Supernova/ }).click();
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Oasis – Champagne Supernova");
  await expect(page.locator("#tab .at-surface svg").first()).toBeVisible();
  await expect(page.locator("#page")).toBeHidden();
});

test("search says when Songsterr can't be reached, and still finds my tabs", async ({ page, tauri }) => {
  tauri.songsterrDown = true;
  await openApp(page, tauri);
  await searchFor(page, "Oasis");
  await expect(page.locator('#page [data-slot="songsterr"]')).toContainText("Couldn't reach Songsterr. You may be offline.");
  await expect(page.locator('#page [data-slot="local"] .row-title')).toHaveText(["Wonderwall", "Champagne Supernova"]);
});
