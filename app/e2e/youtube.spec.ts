import { expect, openApp, test, track } from "./fixtures";

/** A YouTube video in Chrome, as the plugin reports it: the video's title and the channel. */
const VIDEO = track({
  title: "Oasis - Wonderwall (Official Video)",
  artist: "OasisVEVO",
  album: null,
  service: "youtube",
  player: "YouTube (Chrome, macOS)",
});

test("a YouTube video is followed as its song: title, artist and tab", async ({ page, tauri }) => {
  tauri.nowPlaying = VIDEO;
  await openApp(page, tauri);
  await expect(page.locator("#np-title")).toHaveText("Wonderwall");
  await expect(page.locator("#np-artist")).toHaveText("Oasis");
  await expect(page.locator("#tools-source")).toHaveText("YouTube (Chrome, macOS)");
  await expect(page.locator("#tools-player-title")).toHaveText("YouTube");
  // Searched as the song, not as the video's title.
  await expect.poll(() => tauri.callsTo("songsterr_search").map((c) => c.args.query)).toContain("Oasis Wonderwall");
  await expect(page.locator("#status-pill")).toContainText("Tablature found");

  // The controls drive the video.
  await page.getByRole("button", { name: "Next track" }).click();
  await expect.poll(() => tauri.callsTo("plugin:nowplaying|control").map((c) => c.args.action)).toEqual(["next"]);
});

test("switching from Spotify to a YouTube video follows the new song", async ({ page, tauri }) => {
  tauri.nowPlaying = track({ title: "Champagne Supernova", artist: "Oasis", spotifyId: "sp-cs", service: "spotify", player: "Spotify (Windows)" });
  await openApp(page, tauri);
  await expect(page.locator("#tools-player-title")).toHaveText("Spotify");
  tauri.nowPlaying = { ...VIDEO, player: "Chrome (Windows)", service: "browser" };
  await expect(page.locator("#np-title")).toHaveText("Wonderwall");
  await expect(page.locator("#tools-player-title")).toHaveText("Chrome");
  await expect.poll(() => tauri.callsTo("songsterr_search").map((c) => c.args.query)).toContain("Oasis Wonderwall");
});
