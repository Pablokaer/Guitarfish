import { expect, LOCAL_VIEW, openApp, test, TINY_TAB, UNKNOWN } from "./fixtures";
import type { Page } from "@playwright/test";

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const tabFile = (name: string, text = TINY_TAB) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });

test("import a tab for the song playing now: it opens at once and stays on the device", async ({ page, tauri }) => {
  tauri.seed = [];
  tauri.nowPlaying = UNKNOWN;
  await openApp(page, tauri, LOCAL_VIEW);
  const panel = page.locator("#panel");
  await expect(panel).toContainText("Not in the local catalogue");
  await expect(panel).toContainText("No candidates");

  await panel.getByRole("button", { name: "Import a tab for it…" }).click();
  const form = page.locator("#page form");
  await expect(page.locator("#page").getByRole("heading", { name: "Import a tab" })).toBeVisible();
  // Prefilled from the playing track, and linked to it.
  await expect(form.getByLabel("Artist")).toHaveValue("Nobody Band");
  await expect(form.getByLabel("Title")).toHaveValue("Obscure Demo");
  await expect(form.getByRole("checkbox", { name: /Use it for the song playing now/ })).toBeChecked();

  // Not a tab file: refused with a reason.
  await form.getByLabel("Tab file").setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  await form.getByRole("button", { name: "Import" }).click();
  await expect(form.getByRole("alert")).toContainText("Unsupported file type");

  await form.getByLabel("Tab file").setInputFiles(tabFile("obscure.alphatex"));
  await form.getByRole("button", { name: "Import" }).click();
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Nobody Band – Obscure Demo");
  await expect(page.locator("#tab .at-surface svg").first()).toBeVisible();
  await expect(page.locator("#match-info")).toContainText("Local catalogue: Nobody Band – Obscure Demo · external-id");
  await expect(panel).toBeHidden();

  await nav(page, "My tabs");
  await expect(page.locator("#page .row-title")).toHaveText(["Obscure Demo"]);
  await expect(page.locator("#page .tab-file-name")).toHaveText(["obscure.alphatex"]);

  // Stored in the device's IndexedDB: still there after a restart.
  await page.reload();
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Nobody Band – Obscure Demo");
});

test("import from My tabs, add a second file to the song, then delete both", async ({ page, tauri }) => {
  tauri.seed = [];
  await openApp(page, tauri);
  await nav(page, "My tabs");
  const pageLayer = page.locator("#page");
  await expect(pageLayer).toContainText("No tabs yet.");

  await pageLayer.getByRole("button", { name: "Import tab…" }).click();
  const form = pageLayer.locator("form");
  // Nothing playing: nothing to prefill or link.
  await expect(form.getByLabel("Artist")).toHaveValue("");
  await expect(form.getByRole("checkbox")).toHaveCount(0);
  await form.getByLabel("Tab file").setInputFiles(tabFile("riff.alphatex"));
  await form.getByRole("button", { name: "Import" }).click();
  await expect(form.getByRole("alert")).toHaveText("Enter the artist.");
  await form.getByLabel("Artist").fill("The Band");
  await form.getByLabel("Title").fill("Riff");
  await form.getByRole("button", { name: "Import" }).click();
  await expect(pageLayer.locator(".notice")).toHaveText("Imported riff.alphatex for “Riff” by The Band.");

  // Same song after normalization: the file joins it.
  await page.getByRole("button", { name: "Import tab…" }).first().click();
  await form.getByLabel("Tab file").setInputFiles(tabFile("riff-solo.atex"));
  await form.getByLabel("Artist").fill("band");
  await form.getByLabel("Title").fill("riff");
  await form.getByRole("button", { name: "Import" }).click();
  await expect(pageLayer.locator(".row-title")).toHaveText(["Riff"]);
  await expect(pageLayer.locator(".tab-file-name")).toHaveText(["riff.alphatex", "riff-solo.atex"]);
  await expect(pageLayer.locator(".song-group .row-meta").first()).toHaveText("2 tabs");

  // Deleting takes a confirmation click.
  const del = pageLayer.getByRole("button", { name: "Delete riff.alphatex" });
  await del.click();
  await expect(del).toHaveText("Confirm delete");
  await del.click();
  await expect(pageLayer.locator(".notice")).toHaveText("Deleted riff.alphatex.");
  await expect(pageLayer.locator(".tab-file-name")).toHaveText(["riff-solo.atex"]);

  await pageLayer.getByRole("button", { name: "Delete riff-solo.atex" }).click();
  await pageLayer.getByRole("button", { name: "Delete riff-solo.atex" }).click();
  await expect(pageLayer).toContainText("No tabs yet.");

  await page.reload();
  await nav(page, "My tabs");
  await expect(page.locator("#page")).toContainText("No tabs yet.");
});
