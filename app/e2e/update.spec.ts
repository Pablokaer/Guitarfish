import { expect, openApp, test } from "./fixtures";

const release = (tag: string) => ({
  tag_name: tag,
  name: `Guitarfish ${tag.slice(1)}`,
  html_url: `https://github.com/Pablokaer/Guitarfish/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
});

test("the sidebar button says when the app is up to date", async ({ page, tauri }) => {
  await page.route("https://api.github.com/**", (route) => route.fulfill({ json: release("v0.4.0") }));
  await openApp(page, tauri);
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.locator("#banner")).toContainText("Guitarfish 0.4.0 is the latest version.");
});

test("the sidebar button reports a failed check", async ({ page, tauri }) => {
  await openApp(page, tauri);
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.locator("#banner")).toContainText("Couldn't check for updates");
  await expect(page.locator("#banner")).toHaveClass(/\bwarn\b/);
});

test("the sidebar button installs a newer release, falling back to its page", async ({ page, tauri }) => {
  await page.route("https://api.github.com/**", (route) => route.fulfill({ json: release("v0.5.0") }));
  await openApp(page, tauri);
  // The startup check announces 0.5.0; the button installs it anyway.
  await page.getByRole("button", { name: "Check for updates" }).click();
  // The mocked updater finds no manifest, so the release page opens instead.
  await expect(page.locator("#banner")).toContainText("Couldn't install Guitarfish 0.5.0 here");
  expect(tauri.callsTo("plugin:updater|check")).toHaveLength(1);
  expect(tauri.callsTo("plugin:opener|open_url").map((c) => c.args.url)).toContain(
    "https://github.com/Pablokaer/Guitarfish/releases/tag/v0.5.0",
  );
});

test("there is no update button in a plain browser", async ({ page }) => {
  await openApp(page, null);
  await expect(page.getByRole("button", { name: "Check for updates" })).toBeHidden();
});
