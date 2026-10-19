import { test as base, expect, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import type { SongsterrResult, Track } from "../src/types";
import type { SeedTab } from "./tauri-mock";

/** A tiny alphaTex tab: two bars of open strings. */
export const TINY_TAB = `\\title "E2E tab"
\\tempo 120
.
\\track "Guitar"
\\staff {tabs}
:4 0.6 0.5 0.4 0.3 | 0.2 0.1 (0.6 0.1) r |
`;

export function track(over: Partial<Track> & Pick<Track, "title" | "artist">): Track {
  return {
    album: "E2E Album",
    durationMs: 200_000,
    positionMs: 65_000,
    isPlaying: true,
    spotifyId: null,
    artworkUrl: null,
    source: "os",
    player: "Spotify",
    ...over,
  };
}

const tab = (title: string, artist: string, over: Partial<SeedTab> = {}): SeedTab => ({
  title,
  artist,
  name: `${title}.alphatex`,
  format: "alphatex",
  text: TINY_TAB,
  ...over,
});

export const WONDERWALL = track({ title: "Wonderwall", artist: "Oasis", spotifyId: "sp-wonderwall" });
export const UNKNOWN = track({ title: "Obscure Demo", artist: "Nobody Band", spotifyId: "sp-obscure", positionMs: 10_000 });
/** The tabs on the device at the start of each test (see FakeTauri.seed). */
export const CATALOGUE: SeedTab[] = [
  tab("Wonderwall", "Oasis"),
  // Close to UNKNOWN, but not close enough to open on its own (73%).
  tab("Obscure Demo Sessions", "Nobody Band"),
  tab("Champagne Supernova", "Oasis"),
];
export const SONGSTERR: SongsterrResult[] = [
  { songId: 11, title: "Wonderwall", artist: "Oasis", instruments: ["Guitar"], url: "https://www.songsterr.com/a/wa/song?id=11" },
  { songId: 12, title: "Champagne Supernova", artist: "Oasis", instruments: ["Guitar"], url: "https://www.songsterr.com/a/wa/song?id=12" },
];

/** Settings that show the local (alphaTab) viewer instead of the Songsterr page. */
export const LOCAL_VIEW = { "tabsync.settings": { version: 2, songsterrPanel: false } };

export interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

/** tauri-mock.ts, bundled once per worker for the browser. */
const MOCK_SCRIPT = buildSync({
  entryPoints: [fileURLToPath(new URL("./tauri-mock.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  logLevel: "error",
}).outputFiles[0].text;

/**
 * The Tauri side of the app, scripted by the test: the now-playing plugin, the
 * songsterr_search command, the opener and the native webview plumbing. Tests set
 * `nowPlaying` to "change the song", flip `songsterrDown` to make the Songsterr
 * search fail, and read `calls` to see what the app asked for.
 */
export class FakeTauri {
  nowPlaying: Track | null = null;
  songsterr: SongsterrResult[] = [...SONGSTERR];
  songsterrDown = false;
  /** Answers of the `song_key` command by "artist|title"; other songs have no known key. */
  songKeys: Record<string, { tonic: number; mode: "major" | "minor"; tempo: number | null; via: "spotify-id" | "isrc" }> = {};
  capabilities = { transport: true, seek: true, volume: false, events: false };
  /** The tabs on the device when the test's page first loads. */
  seed: SeedTab[] = [...CATALOGUE];
  calls: Call[] = [];

  async install(page: Page): Promise<void> {
    await page.exposeFunction("__e2eInvoke", (cmd: string, args: Record<string, unknown>) => this.handle(cmd, args));
    await page.addInitScript((seed) => (window.__e2eSeed = seed), this.seed);
    await page.addInitScript({ content: MOCK_SCRIPT });
  }

  callsTo(cmd: string): Call[] {
    return this.calls.filter((c) => c.cmd === cmd);
  }

  /** URLs the app opened in a native Songsterr webview. */
  embedded(): string[] {
    return this.callsTo("plugin:webview|create_webview").map((c) => String((c.args.options as { url: string }).url));
  }

  private handle(cmd: string, args: Record<string, unknown>): unknown {
    this.calls.push({ cmd, args });
    switch (cmd) {
      case "plugin:nowplaying|get_now_playing":
        return { track: this.nowPlaying };
      case "plugin:nowplaying|get_capabilities":
        return this.capabilities;
      case "plugin:nowplaying|check_permission":
        return { granted: true };
      case "songsterr_search": {
        // The real command rejects with a message (offline, timeout, HTTP error).
        if (this.songsterrDown) throw new Error("Songsterr search failed: io: Connection refused");
        const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
        return this.songsterr.filter((r) => words.some((w) => `${r.artist} ${r.title}`.toLowerCase().includes(w)));
      }
      case "song_key":
        return this.songKeys[`${args.artist}|${args.title}`] ?? null;
      case "plugin:app|version":
        return "0.4.0";
      default:
        // Player controls, the opener, and the native webview/window plumbing.
        return null;
    }
  }
}

export const test = base.extend<{ tauri: FakeTauri }>({
  tauri: async ({ page }, use) => {
    // The update check asks GitHub for the latest release; never hit the network.
    await page.route("https://api.github.com/**", (route) => route.fulfill({ status: 404, body: "{}" }));
    await use(new FakeTauri());
  },
});

export { expect };

/**
 * Opens the app with `localStorage` seeded (only before the first load of this
 * page). With `tauri` null, the UI runs as in a plain browser, without the mocks.
 */
export async function openApp(page: Page, tauri: FakeTauri | null, storage: Record<string, unknown> = {}): Promise<void> {
  if (tauri) await tauri.install(page);
  if (Object.keys(storage).length) {
    await page.addInitScript((items) => {
      if (sessionStorage.getItem("e2e.seeded")) return;
      sessionStorage.setItem("e2e.seeded", "1");
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, JSON.stringify(v));
    }, storage);
  }
  await page.goto("/");
}
