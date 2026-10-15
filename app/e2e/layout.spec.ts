import { expect, openApp, test } from "./fixtures";

test("sidebars hide and show, and the layout persists across reloads", async ({ page, tauri }) => {
  await openApp(page, tauri);
  const nav = page.locator("#nav");
  const tools = page.locator("#tools");
  await expect(nav).toHaveAttribute("data-state", "expanded");
  await expect(tools).toHaveAttribute("data-visible", "true");

  await page.getByRole("button", { name: "Hide navigation sidebar" }).click();
  await page.getByRole("button", { name: "Hide tools sidebar" }).click();
  await expect(nav).toHaveAttribute("data-state", "hidden");
  await expect(tools).toHaveAttribute("data-visible", "false");
  await expect(page.getByRole("button", { name: "Toggle navigation sidebar" })).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  await expect(nav).toHaveAttribute("data-state", "hidden");
  await expect(tools).toHaveAttribute("data-visible", "false");

  await page.getByRole("button", { name: "Toggle navigation sidebar" }).click();
  await page.getByRole("button", { name: "Toggle tools sidebar" }).click();
  await expect(nav).toHaveAttribute("data-state", "expanded");
  await expect(tools).toHaveAttribute("data-visible", "true");
  await page.reload();
  await expect(nav).toHaveAttribute("data-state", "expanded");
  await expect(tools).toHaveAttribute("data-visible", "true");
});

test("Focus Mode hides everything, survives a reload, and Esc exits it", async ({ page, tauri }) => {
  await openApp(page, tauri);
  // Start from a customised layout, which Focus Mode must give back.
  await page.getByRole("button", { name: "Collapse player" }).click();
  await expect(page.locator("#player")).toHaveAttribute("data-state", "collapsed");

  await page.getByRole("button", { name: "Focus Mode" }).click();
  const expectFocused = async () => {
    await expect(page.locator("#player")).toHaveAttribute("data-state", "hidden");
    await expect(page.locator("#player")).toHaveClass(/\bfocus\b/);
    await expect(page.locator("#nav")).toHaveAttribute("data-state", "hidden");
    await expect(page.locator("#tools")).toHaveAttribute("data-visible", "false");
    await expect(page.locator("#toolbar")).toHaveAttribute("data-visible", "false");
    await expect(page.getByRole("button", { name: "Exit Focus", exact: true })).toBeVisible();
  };
  await expectFocused();

  await page.reload();
  await expectFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator("#player")).toHaveAttribute("data-state", "collapsed");
  await expect(page.locator("#player")).not.toHaveClass(/\bfocus\b/);
  await expect(page.locator("#nav")).toHaveAttribute("data-state", "expanded");
  await expect(page.locator("#tools")).toHaveAttribute("data-visible", "true");
  await expect(page.locator("#toolbar")).toHaveAttribute("data-visible", "true");

  await page.reload();
  await expect(page.locator("#player")).not.toHaveClass(/\bfocus\b/);
  await expect(page.locator("#toolbar")).toHaveAttribute("data-visible", "true");
});
