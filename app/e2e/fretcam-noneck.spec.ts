import { expect, LOCAL_VIEW, openApp, test, WONDERWALL } from "./fixtures";

// Chromium's own fake camera: a test pattern, no guitar in it.
test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["camera"],
});

test("with no guitar in the picture the camera view says what to do, and closes with Escape", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri, LOCAL_VIEW);
  await page.getByRole("button", { name: "Solos", exact: true }).first().click();
  await page.getByRole("button", { name: "On my guitar" }).click();
  const cam = page.getByRole("dialog", { name: "Scale on camera" });
  // The model loads with the first frame (slower without a GPU).
  await expect(cam.locator(".fretcam-msg")).toContainText("Looking for the neck", { timeout: 30_000 });
  await page.waitForTimeout(1000);
  await expect(cam.locator(".fretcam-msg")).not.toHaveText("Root notes are green.");
  await page.keyboard.press("Escape");
  await expect(cam).toBeHidden();
});
