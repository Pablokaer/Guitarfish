import { expect, openApp, test } from "./fixtures";

test.beforeEach(async ({ context }) => {
  // Songsterr pages open in a new window in the browser build; never hit the real site.
  await context.route("https://www.songsterr.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Songsterr</title>" }));
});

test("the Search page asks for a query when there is none", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Search" }).click();
  const pageLayer = page.locator("#page");
  await expect(pageLayer.getByRole("heading", { name: "Search" })).toBeVisible();
  await expect(pageLayer.getByText("Type an artist or song.")).toHaveCount(2);
  await expect(pageLayer.getByRole("searchbox", { name: "Search" })).toBeFocused();
});

test("manual search lists Songsterr and catalogue results", async ({ page, server }) => {
  await openApp(page);
  await page.getByRole("searchbox", { name: "Search Songsterr" }).fill("Oasis");
  await page.getByRole("searchbox", { name: "Search Songsterr" }).press("Enter");

  const pageLayer = page.locator("#page");
  await expect(pageLayer.getByRole("heading", { name: "Search" })).toBeVisible();
  const songsterr = pageLayer.locator('[data-slot="songsterr"]');
  const local = pageLayer.locator('[data-slot="local"]');
  await expect(songsterr.locator(".row-title")).toHaveText(["Wonderwall", "Champagne Supernova", "Open Songsterr's search page"]);
  await expect(local.locator(".row-title")).toHaveText(["Wonderwall", "Champagne Supernova"]);
  expect(server.callsTo("/v1/songsterr/search").at(-1)?.query.get("q")).toBe("Oasis");
  expect(server.callsTo("/v1/songs").at(-1)?.query.get("q")).toBe("Oasis");

  // A new query from the page's own form replaces the results.
  await pageLayer.getByRole("searchbox", { name: "Search" }).fill("Supernova");
  await pageLayer.getByRole("button", { name: "Search", exact: true }).click();
  await expect(songsterr.locator(".row-title")).toHaveText(["Champagne Supernova", "Open Songsterr's search page"]);
  await expect(local.locator(".row-title")).toHaveText(["Champagne Supernova"]);

  // Songsterr results can't be embedded in a browser: they open in a new window.
  const popup = page.waitForEvent("popup");
  await songsterr.getByRole("button", { name: /Champagne Supernova/ }).click();
  expect((await popup).url()).toBe("https://www.songsterr.com/a/wsa/oasis-champagne-supernova-tab-s12");

  // A catalogue result opens the local tab.
  await local.getByRole("button", { name: /Champagne Supernova/ }).click();
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Oasis – Champagne Supernova");
  await expect(page.locator("#tab .at-surface svg").first()).toBeVisible();
  await expect(page.locator("#page")).toBeHidden();
});

test("search shows when the server can't be reached", async ({ page, server }) => {
  server.down = true;
  await openApp(page);
  await page.getByRole("searchbox", { name: "Search Songsterr" }).fill("Oasis");
  await page.getByRole("searchbox", { name: "Search Songsterr" }).press("Enter");
  await expect(page.locator('#page [data-slot="songsterr"]')).toContainText("Search failed");
  await expect(page.locator('#page [data-slot="local"]')).toContainText("Tab server unreachable.");
});
