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

test("a short window scrolls the navigation sidebar instead of clipping it", async ({ page, tauri }) => {
  await page.setViewportSize({ width: 1100, height: 420 });
  await openApp(page, tauri);
  const compact = page.getByRole("button", { name: "Compact sidebar" });
  await expect(compact).not.toBeInViewport();
  // Scroll the way a user does: programmatic scrolling reaches even a clipped panel.
  await page.locator("#nav .brand").hover();
  await page.mouse.wheel(0, 2000);
  await expect(compact).toBeInViewport();
  await compact.click();
  await expect(page.locator("#nav")).toHaveAttribute("data-state", "compact");
});

test("in a short window long lists scroll on their own, and compact mode drops them", async ({ page, tauri }) => {
  await page.setViewportSize({ width: 1100, height: 600 });
  const history = Array.from({ length: 8 }, (_, i) => ({ url: `https://www.songsterr.com/a/wa/song?id=${i + 1}`, songId: i + 1, title: `Song ${i + 1}`, artist: "Band", at: Date.now() - i * 60_000 }));
  await openApp(page, tauri, { "tabsync.history": history });
  // Twelve playlists, written where the app keeps them; the reload shows them.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("guitarfish-music");
        open.onsuccess = () => {
          const tx = open.result.transaction("playlists", "readwrite");
          for (let i = 1; i <= 12; i++) tx.objectStore("playlists").add({ name: `Playlist ${i}`, trackIds: [], createdAt: i });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );
  await page.reload();
  await expect(page.locator("#playlists li")).toHaveCount(12);
  await expect(page.locator("#recent li")).toHaveCount(8);

  const overflow = (sel: string) => page.locator(sel).evaluate((el) => el.scrollHeight - el.clientHeight);
  // Each list shrinks to its floor (about two rows) and scrolls inside itself, so the sidebar as a
  // whole only scrolls by what the fixed items need (with the lists at full length it was ~800 px).
  for (const list of ["#playlists", "#recent"]) {
    expect(await overflow(list)).toBeGreaterThan(0);
    expect(await page.locator(list).evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(90);
  }
  expect(await overflow("#nav .nav-inner")).toBeLessThan(200);
  const compact = page.getByRole("button", { name: "Compact sidebar" });
  await page.locator("#nav .brand").hover();
  await page.mouse.wheel(0, 300);
  await expect(compact).toBeInViewport();

  // Compact: no room for the lists. They leave the layout, and the narrow sidebar fits.
  await compact.click();
  await expect(page.locator("#nav")).toHaveAttribute("data-state", "compact");
  await expect(page.locator("#playlists")).toBeHidden();
  await expect(page.locator("#recent")).toBeHidden();
  expect(await overflow("#nav .nav-inner")).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeInViewport();
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
