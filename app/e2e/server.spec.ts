import { CATALOGUE, expect, FakeServer, openApp, song, test, UNKNOWN, WONDERWALL } from "./fixtures";

test("changing the server URL looks the current song up on the new server", async ({ page, server }) => {
  server.nowPlaying = UNKNOWN;
  const other = new FakeServer("http://127.0.0.1:8899");
  other.nowPlaying = UNKNOWN;
  other.catalogue = [...CATALOGUE, song(4, "Obscure Demo", "Nobody Band")];
  await other.install(page);

  await openApp(page);
  await expect(page.locator("#panel")).toContainText("Not in the local catalogue");

  const field = page.getByRole("textbox", { name: "Tab server" });
  await expect(field).toHaveValue("http://127.0.0.1:8787");
  await field.fill("http://127.0.0.1:8899/");
  await field.press("Enter");
  await field.blur();

  await expect(page.locator("#tb-title")).toHaveText("Local tab · Nobody Band – Obscure Demo");
  await expect(page.locator("#panel")).toBeHidden();
  expect(other.callsTo("/v1/tabs/lookup").length).toBeGreaterThan(0);
  expect(other.callsTo("/auth/spotify/status").length).toBeGreaterThan(0);

  // Saved without the trailing slash, and used again after a reload.
  await page.reload();
  await expect(field).toHaveValue("http://127.0.0.1:8899");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("tabsync.settings") ?? "{}").serverUrl);
  expect(stored).toBe("http://127.0.0.1:8899");
});

test("the Test button checks the server", async ({ page, server }) => {
  await openApp(page);
  const button = page.locator("#btn-test");
  await button.click();
  await expect(button).toHaveText("OK ✓");
  server.offline = true;
  await expect(button).toHaveText("Test");
  await button.click();
  await expect(button).toHaveText("Unreachable");
});

test("a server outage shows a banner, and the app recovers when it's back", async ({ page, server }) => {
  server.nowPlaying = WONDERWALL;
  server.down = true;
  await openApp(page);

  const banner = page.locator("#banner");
  await expect(banner).toContainText("Can't reach the tab server at http://127.0.0.1:8787");
  await expect(page.locator("#status-pill")).toContainText("Tab server unreachable");

  server.down = false;
  // Both the Songsterr search and the catalogue lookup retry every 5 s.
  await expect(banner).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("#status-pill")).toContainText("Tablature found");
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Oasis – Wonderwall", { timeout: 15_000 });
  await expect(page.locator("#tab .at-surface svg").first()).toBeVisible();
});
