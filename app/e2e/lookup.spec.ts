import { expect, LOCAL_VIEW, openApp, test, UNKNOWN, WONDERWALL } from "./fixtures";
import type { Page } from "@playwright/test";

/** alphaTab draws the score as SVG into #tab. */
const renderedTab = (page: Page) => page.locator("#tab .at-surface svg").first();

test("song change looks the new track up on the device and shows its local tab", async ({ page, tauri }) => {
  tauri.nowPlaying = UNKNOWN;
  await openApp(page, tauri, LOCAL_VIEW);
  await expect(page.locator("#np-title")).toHaveText("Obscure Demo");
  await expect(page.locator("#panel")).toContainText("Not in the local catalogue");

  tauri.nowPlaying = WONDERWALL;
  await expect(page.locator("#np-title")).toHaveText("Wonderwall");
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Oasis – Wonderwall");
  await expect(renderedTab(page)).toBeVisible();
  await expect(page.locator("#match-info")).toContainText("Local catalogue: Oasis – Wonderwall · exact");
  await expect(page.locator("#status-pill")).toContainText("Tablature found");
  await expect(page.locator("#panel")).toBeHidden();
  // Songsterr was searched for both tracks too, through the app shell's command.
  expect(tauri.callsTo("songsterr_search").map((c) => c.args.query)).toEqual(["Nobody Band Obscure Demo", "Oasis Wonderwall"]);
});

test("a track missing from the catalogue offers candidates", async ({ page, tauri }) => {
  tauri.nowPlaying = UNKNOWN;
  await openApp(page, tauri, LOCAL_VIEW);
  const panel = page.locator("#panel");
  await expect(panel.getByRole("heading", { name: "Not in the local catalogue" })).toBeVisible();
  await expect(panel).toContainText("Is it one of these?");
  await expect(panel.getByRole("button", { name: /Obscure Demo Sessions/ })).toContainText("73%");
  await expect(panel.getByRole("button", { name: /Wonderwall/ })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Show Songsterr instead" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Import a tab for it…" })).toBeVisible();
});

test("choosing a candidate links the track to it on the device", async ({ page, tauri }) => {
  tauri.nowPlaying = UNKNOWN;
  await openApp(page, tauri, LOCAL_VIEW);
  await page.locator("#panel").getByRole("button", { name: /Obscure Demo Sessions/ }).click();

  await expect(page.locator("#tb-title")).toHaveText("Local tab · Nobody Band – Obscure Demo Sessions");
  await expect(page.locator("#match-info")).toContainText("your pick");
  await expect(page.locator("#panel")).toBeHidden();
  await expect(renderedTab(page)).toBeVisible();

  // The Spotify ID is linked in the device catalogue: after a reload the track opens it without asking.
  await page.reload();
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Nobody Band – Obscure Demo Sessions");
  await expect(page.locator("#match-info")).toContainText("Local catalogue: Nobody Band – Obscure Demo Sessions · external-id");
  await expect(page.locator("#panel")).toBeHidden();
});

test("by default the song's Songsterr page opens, with a switch to the local tab", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri);
  await expect(page.locator("#status-pill")).toContainText("Tablature found");
  await expect(page.locator("#tb-title")).toHaveText("Songsterr · Oasis – Wonderwall");
  expect(tauri.embedded()).toEqual(["https://www.songsterr.com/a/wa/song?id=11"]);

  const sources = page.getByRole("group", { name: "Tab source" });
  await expect(sources).toBeVisible();
  await sources.getByRole("button", { name: "Local tab" }).click();
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Oasis – Wonderwall");
  await expect(renderedTab(page)).toBeVisible();
});
