import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, LOCAL_VIEW, openApp, test, WONDERWALL } from "./fixtures";

// The camera films a real guitar: a frame of the code-and-chords "guitar-frets-segmenter"
// dataset (CC BY 4.0), played by Chromium as its fake camera (a one-frame Motion JPEG).
const clip = join(tmpdir(), "guitarfish-e2e-neck.mjpeg");
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "neck.jpg"), clip);

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${clip}`] },
  permissions: ["camera"],
});

test("the model finds the neck in the camera picture and the scale is drawn on it", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri, LOCAL_VIEW);
  await page.getByRole("button", { name: "Solos", exact: true }).first().click();
  await expect(page.locator("#page .solos .solos-key-name")).toHaveText("E minor");

  await page.getByRole("button", { name: "On my guitar" }).click();
  const cam = page.getByRole("dialog", { name: "Scale on camera" });
  await expect(cam).toContainText("E Minor pentatonic");
  // No marking: the frets are found by the model (it loads with the first frame).
  await expect(cam.locator(".fretcam-msg")).toHaveText("Root notes are green.", { timeout: 30_000 });

  const lit = await cam.locator("canvas").evaluate((c: HTMLCanvasElement) => {
    const { data } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  });
  expect(lit).toBeGreaterThan(2000);

  const pos = cam.getByRole("group", { name: "Position" });
  await pos.getByRole("button", { name: "2", exact: true }).click();
  await expect(page.locator("#page .solos .solos-tab h3")).toContainText("Position 2");
  await cam.getByRole("button", { name: "Done" }).click();
  await expect(cam).toBeHidden();
});
