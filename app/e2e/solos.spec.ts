import { expect, LOCAL_VIEW, openApp, test, WONDERWALL } from "./fixtures";

test("Solos reads the key from the local tab and draws the chosen scale", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri, LOCAL_VIEW);
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Oasis – Wonderwall");

  await page.getByRole("button", { name: "Solos", exact: true }).first().click();
  const solos = page.locator("#page .solos");
  await expect(solos.getByRole("heading", { name: "Solos" })).toBeVisible();
  await expect(solos).toContainText("Oasis – Wonderwall");
  // The tiny tab is the six open strings: E A D G B E.
  await expect(solos.locator(".solos-key-name")).toHaveText("E minor");
  await expect(solos).toContainText("Detected from the local tab's notes");
  await expect(solos).toContainText("Standard (E A D G B E), from the local tab");

  await solos.getByLabel("Scale", { exact: true }).selectOption("blues");
  await expect(solos.getByRole("heading", { name: "E Blues (minor)" })).toBeVisible();
  await expect(solos.locator(".solos-chips b")).toHaveText(["E", "G", "A", "Bb", "B", "D"]);

  await solos.getByRole("group", { name: "Position" }).getByRole("button", { name: "1", exact: true }).click();
  await expect(solos.locator(".solos-tab pre")).toContainText("E|-0-3-");
  await expect(solos.locator(".neck .dot.dim").first()).toBeAttached();
});

test("a key picked by hand sticks to the song across reloads", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri, LOCAL_VIEW);
  await page.getByRole("button", { name: "Solos", exact: true }).first().click();
  const solos = page.locator("#page .solos");
  await expect(solos.locator(".solos-key-name")).toHaveText("E minor");

  await solos.getByLabel("Key note").selectOption({ label: "A" });
  await expect(solos.locator(".solos-key-name")).toHaveText("A minor");
  await expect(solos).toContainText("Set by you");
  await expect(solos.locator(".solos-chips b")).toHaveText(["A", "C", "D", "E", "G"]);

  await page.reload();
  await page.getByRole("button", { name: "Solos", exact: true }).first().click();
  await expect(page.locator("#page .solos .solos-key-name")).toHaveText("A minor");
});

test("the toolbar button switches between the tab and Solos", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri, LOCAL_VIEW);
  const button = page.locator("#btn-solos");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#page .solos")).toBeVisible();
  await expect(page.locator("#local")).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#local")).toBeVisible();
});

test("the song's key is looked up online as it starts, beats the tab's guess, and is kept", async ({ page, tauri }) => {
  tauri.songKeys["Oasis|Wonderwall"] = { tonic: 6, mode: "minor", tempo: 87.4, via: "spotify-id" };
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri, LOCAL_VIEW);
  await expect(page.locator("#tb-title")).toHaveText("Local tab · Oasis – Wonderwall");
  expect(tauri.callsTo("song_key").map((c) => c.args)).toEqual([{ title: "Wonderwall", artist: "Oasis", spotifyId: "sp-wonderwall" }]);

  await page.locator("#btn-solos").click();
  const solos = page.locator("#page .solos");
  await expect(solos.locator(".solos-key-name")).toHaveText("F# minor");
  await expect(solos).toContainText("Looked up online");
  await expect(solos).toContainText("87 BPM");

  // Next time the song plays, the stored key shows without asking again.
  await page.reload();
  await page.locator("#btn-solos").click();
  await expect(page.locator("#page .solos .solos-key-name")).toHaveText("F# minor");
  expect(tauri.callsTo("song_key")).toHaveLength(1);
});

test("Look up online says when the song's key isn't known", async ({ page, tauri }) => {
  tauri.nowPlaying = WONDERWALL;
  await openApp(page, tauri, LOCAL_VIEW);
  await page.locator("#btn-solos").click();
  const solos = page.locator("#page .solos");
  await expect(solos.locator(".solos-key-name")).toHaveText("E minor"); // from the tab
  await solos.getByRole("button", { name: "Look up online" }).click();
  await expect(solos).toContainText("isn't in the online database");
  await expect(solos.locator(".solos-key-name")).toHaveText("E minor");
});
