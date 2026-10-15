import { expect, openApp, test, UNKNOWN, WONDERWALL } from "./fixtures";
import type { Page } from "@playwright/test";

/** alphaTab draws the score as SVG into #tab. */
const renderedTab = (page: Page) => page.locator("#tab .at-surface svg").first();

test("song change looks the new track up and shows the local tab", async ({ page, server }) => {
  server.nowPlaying = UNKNOWN;
  await openApp(page);
  await expect(page.locator("#np-title")).toHaveText("Obscure Demo");

  server.nowPlaying = WONDERWALL;
  await expect(page.locator("#np-title")).toHaveText("Wonderwall");
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Oasis – Wonderwall");
  await expect(renderedTab(page)).toBeVisible();
  await expect(page.locator("#match-info")).toContainText("Local catalogue: Oasis – Wonderwall · exact");
  await expect(page.locator("#status-pill")).toContainText("Tablature found");
  await expect(page.locator("#panel")).toBeHidden();

  const lookups = server.callsTo("/v1/tabs/lookup");
  expect(lookups.map((c) => c.query.get("title"))).toEqual(["Obscure Demo", "Wonderwall"]);
  expect(lookups[1].query.get("spotifyId")).toBe("sp-wonderwall");
  expect(server.callsTo("/v1/tabs/100/content")).toHaveLength(1);
});

test("a track missing from the catalogue offers candidates", async ({ page, server }) => {
  server.nowPlaying = UNKNOWN;
  await openApp(page);
  const panel = page.locator("#panel");
  await expect(panel.getByRole("heading", { name: "Not in the local catalogue" })).toBeVisible();
  await expect(panel).toContainText("Is it one of these?");
  await expect(panel.getByRole("button", { name: /Obscure Demo \(Live\)/ })).toContainText("72%");
  // Songsterr can't be embedded in a browser, so there is no switch to it.
  await expect(panel.getByRole("button", { name: "Show Songsterr instead" })).toBeHidden();
});

test("choosing a candidate confirms it and opens its tab", async ({ page, server }) => {
  server.nowPlaying = UNKNOWN;
  await openApp(page);
  await page.locator("#panel").getByRole("button", { name: /Obscure Demo \(Live\)/ }).click();

  await expect(page.locator("#tb-title")).toHaveText("Local tab · Nobody Band – Obscure Demo (Live)");
  await expect(page.locator("#match-info")).toContainText("your pick");
  await expect(page.locator("#panel")).toBeHidden();
  await expect(renderedTab(page)).toBeVisible();
  await expect.poll(() => server.callsTo("/v1/songs/2/external-ids", "POST").length).toBe(1);
  expect(server.callsTo("/v1/songs/2/external-ids", "POST")[0].body).toEqual({ provider: "spotify", externalId: "sp-obscure" });

  // Remembered on the device: after a reload the track opens the pick without asking.
  await page.reload();
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Nobody Band – Obscure Demo (Live)");
  await expect(page.locator("#panel")).toBeHidden();
});
