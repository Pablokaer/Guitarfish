import type { Page } from "@playwright/test";
import { silentMp3 } from "../test/mp3fixture";
import { expect, openApp, test, WONDERWALL, type FakeTauri } from "./fixtures";

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
const music = (page: Page) => page.locator("#page");
const rows = (page: Page) => music(page).locator(".track-row .row-title");

/** Three tagged MP3s and a text file on the fake disk, all offered by the file picker. */
function disk(tauri: FakeTauri) {
  tauri.files = {
    "/music/wonderwall.mp3": silentMp3({ seconds: 30, id3: 3, title: "Wonderwall", artist: "Oasis", album: "Morning Glory" }),
    "/music/supernova.mp3": silentMp3({ seconds: 20, id3: 4, title: "Champagne Supernova", artist: "Oasis" }),
    "/music/Demo_Take_2.mp3": silentMp3({ seconds: 10 }),
    "/music/notes.txt": new TextEncoder().encode("not music"),
  };
  tauri.picked = Object.keys(tauri.files);
}

async function importAll(page: Page) {
  await nav(page, "Music");
  await music(page).getByRole("button", { name: "Import MP3s…" }).first().click();
  await expect(music(page).locator(".music-message")).toContainText("Added 3 songs.");
}

const audio = (page: Page) => page.locator("#local-audio");
const audioProp = <T>(page: Page, prop: keyof HTMLAudioElement) => audio(page).evaluate((a, p) => (a as unknown as Record<string, T>)[p as string], prop);

test("import MP3s, play one, and its tab is looked up while Spotify is paused", async ({ page, tauri }) => {
  disk(tauri);
  tauri.nowPlaying = WONDERWALL; // Spotify is playing
  await openApp(page, tauri);
  await nav(page, "Music");
  await expect(music(page)).toContainText("Your music library is empty");

  await music(page).getByRole("button", { name: "Import MP3s…" }).first().click();
  await expect(music(page).locator(".music-message")).toContainText("Added 3 songs. Couldn't import notes.txt (not an .mp3 file).");
  // Newest first; the untagged file is named after itself.
  await expect(rows(page)).toHaveText(["Demo Take 2", "Champagne Supernova", "Wonderwall"]);
  await expect(music(page).locator(".track-row").filter({ hasText: "Wonderwall" })).toContainText("Oasis · Morning Glory");

  // Importing the same files again adds nothing.
  await music(page).getByRole("button", { name: "Import MP3s…" }).first().click();
  await expect(music(page).locator(".music-message")).toContainText("3 songs already in your library.");
  await expect(rows(page)).toHaveCount(3);

  await music(page).locator(".track-row").filter({ hasText: "Wonderwall" }).getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("#mode-switch [data-mode='local']")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#np-title")).toHaveText("Wonderwall");
  await expect(page.locator("#np-artist")).toHaveText("Oasis · Morning Glory");
  await expect(page.locator("#tools-source")).toHaveText("Local files");
  await expect(page.locator("#player")).toHaveAttribute("data-playing", "true");
  await expect(page.locator("#np-pos")).not.toHaveText("0:00");
  await expect(page.locator("#np-dur")).toHaveText(/^0:(29|30)$/);
  // Spotify was paused, once.
  await expect.poll(() => tauri.callsTo("plugin:nowplaying|control").map((c) => c.args.action)).toEqual(["playpause"]);
  // The tab is searched for the MP3, as for a Spotify song.
  await expect.poll(() => tauri.callsTo("songsterr_search").map((c) => c.args.query)).toContain("Oasis Wonderwall");
  await expect(music(page).locator(".track-row.playing .row-title")).toHaveText("Wonderwall");

  // Removing it from the library stops it; the file on disk is untouched.
  const row = music(page).locator(".track-row").filter({ hasText: "Wonderwall" });
  await row.hover();
  await row.getByRole("button", { name: /Remove from library/ }).click();
  await row.getByRole("button", { name: /Remove/ }).click();
  await expect(music(page).locator(".music-message")).toContainText("Removed “Wonderwall” from your library. The file itself wasn't touched.");
  await expect(rows(page)).toHaveText(["Demo Take 2", "Champagne Supernova"]);
  await expect(page.locator("#np-title")).toHaveText("Nothing playing");
});

test("search, sort and edit the details used to find the tab", async ({ page, tauri }) => {
  disk(tauri);
  await openApp(page, tauri);
  await importAll(page);
  await music(page).getByPlaceholder("Search title, artist, album").fill("glory");
  await expect(rows(page)).toHaveText(["Wonderwall"]);
  await music(page).getByPlaceholder("Search title, artist, album").fill("");
  await music(page).getByLabel("Sort by").selectOption("title");
  await expect(rows(page)).toHaveText(["Champagne Supernova", "Demo Take 2", "Wonderwall"]);

  const demo = music(page).locator(".track-row").filter({ hasText: "Demo Take 2" });
  await demo.hover();
  await demo.getByRole("button", { name: "Edit Demo Take 2" }).click();
  await demo.getByLabel("Title").fill("Live Forever");
  await demo.getByLabel("Artist").fill("Oasis");
  await demo.getByRole("button", { name: "Save" }).click();
  await expect(rows(page)).toHaveText(["Champagne Supernova", "Live Forever", "Wonderwall"]);

  await music(page).locator(".track-row").filter({ hasText: "Live Forever" }).getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => tauri.callsTo("songsterr_search").map((c) => c.args.query)).toContain("Oasis Live Forever");

  // The Tools card fixes the details of the song playing, and searches again.
  const card = page.locator("#mp3-card");
  await card.getByLabel("Title").fill("Live Forever (Remastered)");
  await card.getByRole("button", { name: "Save and search again" }).click();
  await expect(page.locator("#np-title")).toHaveText("Live Forever (Remastered)");
  await expect.poll(() => tauri.callsTo("songsterr_search").length).toBeGreaterThan(1);
});

test("speed keeps the pitch, presets and keys change it, and the A–B loop repeats a section", async ({ page, tauri }) => {
  disk(tauri);
  await openApp(page, tauri);
  await importAll(page);
  await music(page).locator(".track-row").filter({ hasText: "Wonderwall" }).getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("#player")).toHaveAttribute("data-playing", "true");

  await page.locator("#mp3-speed-presets").getByRole("button", { name: "0.5×" }).click();
  await expect(page.locator("#btn-speed")).toHaveText("0.50×");
  await expect.poll(() => audioProp<number>(page, "playbackRate")).toBe(0.5);
  expect(await audioProp<boolean>(page, "preservesPitch")).toBe(true);

  await page.locator("#btn-faster").click();
  await expect(page.locator("#btn-speed")).toHaveText("0.55×");
  await page.locator("body").press("]");
  await expect(page.locator("#btn-speed")).toHaveText("0.60×");
  await page.locator("body").press("0");
  await expect(page.locator("#btn-speed")).toHaveText("1.00×");
  await expect.poll(() => audioProp<number>(page, "playbackRate")).toBe(1);
  // The slider stops at 1.5×.
  for (let i = 0; i < 12; i++) await page.locator("body").press("]");
  await expect(page.locator("#btn-speed")).toHaveText("1.50×");
  await expect(page.locator("#btn-faster")).toBeDisabled();
  await page.locator("#btn-speed").click();

  // Loop 1 s → 2 s: playback keeps returning to A.
  await audio(page).evaluate((a: HTMLAudioElement) => (a.currentTime = 1));
  await page.locator("#mp3-set-a").click();
  await audio(page).evaluate((a: HTMLAudioElement) => (a.currentTime = 2));
  await page.locator("#mp3-set-b").click();
  await expect(page.locator("#mp3-loop-text")).toHaveText("0:01 → 0:02");
  await expect(page.locator("#btn-loop")).toHaveClass(/looping/);
  await expect(page.locator("#np-loop")).toBeVisible();
  await page.waitForTimeout(2500);
  const t = await audioProp<number>(page, "currentTime");
  expect(t).toBeGreaterThanOrEqual(0.9);
  expect(t).toBeLessThan(2.2);
  await page.locator("body").press("l"); // third press of L: loop off
  await expect(page.locator("#mp3-loop-text")).toHaveText("Off");

  // Space pauses and resumes (on a focused button it presses the button instead).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator("body").press(" ");
  await expect(page.locator("#player")).toHaveAttribute("data-playing", "false");
  await page.locator("body").press(" ");
  await expect(page.locator("#player")).toHaveAttribute("data-playing", "true");
});

test("playlists: create, add, reorder by dragging, and play back in that order across restarts", async ({ page, tauri }) => {
  disk(tauri);
  await openApp(page, tauri);
  await importAll(page);

  // New playlist from the sidebar, named on the spot.
  await page.getByRole("button", { name: "New playlist" }).click();
  await music(page).getByLabel("Playlist name").fill("Warm-ups");
  await music(page).getByRole("button", { name: "Save" }).click();
  await expect(music(page).getByRole("heading", { name: "Warm-ups" })).toBeVisible();
  await expect(music(page)).toContainText("This playlist is empty");
  await expect(page.locator("#playlists")).toContainText("Warm-ups0 songs");

  await nav(page, "Music");
  for (const title of ["Wonderwall", "Champagne Supernova", "Demo Take 2"]) {
    const row = music(page).locator(".track-row").filter({ hasText: title });
    await row.hover();
    await row.getByRole("button", { name: `Add ${title} to a playlist` }).click();
    await row.getByRole("menuitem", { name: "Warm-ups" }).click();
    await expect(music(page).locator(".music-message")).toContainText(`Added “${title}” to “Warm-ups”.`);
  }

  await page.locator("#playlists").getByRole("button", { name: /Warm-ups/ }).click();
  await expect(rows(page)).toHaveText(["Wonderwall", "Champagne Supernova", "Demo Take 2"]);

  // Drag the last song to the top by its grip.
  const grip = music(page).locator(".track-row").nth(2).locator(".track-grip");
  const first = await music(page).locator(".track-row").first().boundingBox();
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, first!.y + 5, { steps: 8 });
  await page.mouse.up();
  await expect(rows(page)).toHaveText(["Demo Take 2", "Wonderwall", "Champagne Supernova"]);

  // Alt+↓ on a grip moves that song down one place.
  await music(page).locator(".track-row").first().locator(".track-grip").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(rows(page)).toHaveText(["Wonderwall", "Demo Take 2", "Champagne Supernova"]);

  await music(page).locator('.music-tools [data-act="play"]').click();
  await expect(page.locator("#np-title")).toHaveText("Wonderwall");
  await page.getByRole("button", { name: /^Next/ }).click();
  await expect(page.locator("#np-title")).toHaveText("Demo Take 2");
  await page.locator("#btn-repeat").click();
  await expect(page.locator("#btn-repeat")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#player").getByRole("button", { name: "Pause" }).click();

  // After a restart: the playlist, its order, the paused song and repeat are all back.
  await page.reload();
  await expect(page.locator("#mode-switch [data-mode='local']")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#np-title")).toHaveText("Demo Take 2");
  await expect(page.locator("#player")).toHaveAttribute("data-playing", "false");
  await expect(page.locator("#btn-repeat")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#playlists").getByRole("button", { name: /Warm-ups/ }).click();
  await expect(rows(page)).toHaveText(["Wonderwall", "Demo Take 2", "Champagne Supernova"]);
  await page.locator("#player").getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("#player")).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: /^Next/ }).click();
  await expect(page.locator("#np-title")).toHaveText("Champagne Supernova");

  // Removing a song from the playlist keeps it in the library.
  const row = music(page).locator(".track-row").filter({ hasText: "Wonderwall" });
  await row.hover();
  await row.getByRole("button", { name: "Remove from playlist: Wonderwall" }).click();
  await expect(rows(page)).toHaveText(["Demo Take 2", "Champagne Supernova"]);
  await nav(page, "Music");
  await expect(rows(page)).toHaveCount(3);
});

test("switching modes never plays both: Spotify mode pauses the local player and follows Spotify again", async ({ page, tauri }) => {
  disk(tauri);
  await openApp(page, tauri);
  await importAll(page);
  await music(page).locator(".track-row").filter({ hasText: "Wonderwall" }).getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("#player")).toHaveAttribute("data-playing", "true");
  expect(await audioProp<boolean>(page, "paused")).toBe(false);

  tauri.nowPlaying = { ...WONDERWALL, title: "Some Might Say", spotifyId: "sp-smt", isPlaying: false };
  await page.locator("#mode-switch").getByRole("button", { name: "Streaming" }).click();
  await expect.poll(() => audioProp<boolean>(page, "paused")).toBe(true);
  await expect(page.locator("#np-title")).toHaveText("Some Might Say");
  await expect(page.locator("#speed-chip")).toBeHidden();
  await expect(page.locator("#mp3-card")).toBeHidden();
  // Spotify was paused already: nothing to silence.
  expect(tauri.callsTo("plugin:nowplaying|control")).toEqual([]);
  // In Spotify mode Space and the arrows are left to the page: no player command.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator("body").press(" ");
  await page.locator("body").press("ArrowRight");
  await page.waitForTimeout(300);
  expect(tauri.callsTo("plugin:nowplaying|control")).toEqual([]);

  // Back to local: the song is still there, paused where it was.
  await page.locator("#mode-switch").getByRole("button", { name: "Local" }).click();
  await expect(page.locator("#np-title")).toHaveText("Wonderwall");
  await expect(page.locator("#player")).toHaveAttribute("data-playing", "false");
  await expect(page.locator("#speed-chip")).toBeVisible();
});

test("a file that disappeared is reported, and the queue moves on", async ({ page, tauri }) => {
  disk(tauri);
  await openApp(page, tauri);
  await importAll(page);
  delete tauri.files["/music/supernova.mp3"]; // moved away after the import
  await music(page).getByLabel("Sort by").selectOption("title");
  await music(page).locator(".track-row").filter({ hasText: "Champagne Supernova" }).getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("#banner")).toContainText("Can't play “Champagne Supernova”: the file is no longer there (/music/supernova.mp3).");
  await expect(page.locator("#np-title")).toHaveText("Demo Take 2");
  await expect(page.locator("#player")).toHaveAttribute("data-playing", "true");
});
