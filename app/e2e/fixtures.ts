import { test as base, expect, type Page, type Request, type Route } from "@playwright/test";
import type { LookupResponse, Song, SongsterrResult, Track } from "../src/types";

/** Where the app looks for the server unless the settings say otherwise. */
export const DEFAULT_SERVER = "http://127.0.0.1:8787";

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
    source: "spotify-api",
    player: "Spotify Web API",
    ...over,
  };
}

export function song(id: number, title: string, artist: string, tabIds: number[] = [id * 100]): Song {
  return {
    id,
    title,
    artist,
    durationMs: 200_000,
    tabs: tabIds.map((t) => ({ id: t, instrument: "guitar", tuning: null, format: "alphatex", version: 1, rating: null, isPlaceholder: false })),
  };
}

export const WONDERWALL = track({ title: "Wonderwall", artist: "Oasis", spotifyId: "sp-wonderwall" });
export const UNKNOWN = track({ title: "Obscure Demo", artist: "Nobody Band", spotifyId: "sp-obscure", positionMs: 10_000 });
export const CATALOGUE: Song[] = [song(1, "Wonderwall", "Oasis"), song(2, "Obscure Demo (Live)", "Nobody Band"), song(3, "Champagne Supernova", "Oasis")];
export const SONGSTERR: SongsterrResult[] = [
  { songId: 11, title: "Wonderwall", artist: "Oasis", instruments: ["Guitar"], url: "https://www.songsterr.com/a/wsa/oasis-wonderwall-tab-s11" },
  { songId: 12, title: "Champagne Supernova", artist: "Oasis", instruments: ["Guitar"], url: "https://www.songsterr.com/a/wsa/oasis-champagne-supernova-tab-s12" },
];

type Entry = { url: string; songId: number; title: string; artist: string; at: number };
type Tombstone = { songId: number; deletedAt: number };

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/**
 * A scripted Guitarfish server (and, through it, Spotify) answering the app's
 * requests to `baseUrl`. Tests change `nowPlaying` to "change the song", flip
 * `down` to make the tab endpoints fail, and read `calls` to see what was asked.
 */
export class FakeServer {
  nowPlaying: Track | null = null;
  catalogue: Song[] = [...CATALOGUE];
  songsterr: SongsterrResult[] = [...SONGSTERR];
  tabText = TINY_TAB;
  /** The tab endpoints (lookup, search, songs, tabs) fail; Spotify still answers. */
  down = false;
  /** Every request fails, as if nothing listened on the port. */
  offline = false;
  spotify = { configured: true, connected: true };
  calls: Call[] = [];
  private library: Record<"history" | "favorites", Entry[]> = { history: [], favorites: [] };

  constructor(readonly baseUrl = DEFAULT_SERVER) {}

  async install(page: Page): Promise<void> {
    await page.route(`${this.baseUrl}/**`, (route) => this.handle(route));
  }

  /** Calls to `path` (exact, without query), optionally only those with `method`. */
  callsTo(path: string, method?: string): Call[] {
    return this.calls.filter((c) => c.path === path && (!method || c.method === method));
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors() });
    const url = new URL(req.url());
    const call: Call = { method: req.method(), path: url.pathname, query: url.searchParams, body: parseBody(req) };
    this.calls.push(call);
    if (this.offline) return route.abort("connectionrefused");

    const json = (body: unknown, status = 200) => route.fulfill({ status, headers: cors(), contentType: "application/json", body: JSON.stringify(body) });
    const p = url.pathname;
    const q = url.searchParams;

    if (p === "/health") return json({ ok: true });
    if (p === "/auth/spotify/status") return json(this.spotify);
    if (p === "/v1/spotify/now-playing") return json({ track: this.nowPlaying });
    if (p === "/v1/library" || p === "/v1/library/sync") return json(this.syncLibrary(call.body));

    if (this.down) return route.abort("connectionrefused");
    if (p === "/v1/tabs/lookup") return json(this.lookup(q.get("title") ?? "", q.get("artist") ?? "", q.get("spotifyId")));
    if (p === "/v1/songs") return json({ results: this.searchCatalogue(q.get("q") ?? "") });
    if (p === "/v1/songsterr/search") return json({ results: this.searchSongsterr(q.get("q") ?? "") });
    const ext = p.match(/^\/v1\/songs\/(\d+)\/external-ids$/);
    if (ext && req.method() === "POST") return json({ ok: true }, 201);
    const tab = p.match(/^\/v1\/tabs\/(\d+)\/content$/);
    if (tab) {
      return route.fulfill({
        status: 200,
        headers: { ...cors(), "X-Tab-Format": "alphatex", "Access-Control-Expose-Headers": "X-Tab-Format" },
        contentType: "text/plain; charset=utf-8",
        body: this.tabText,
      });
    }
    return json({ error: "not found" }, 404);
  }

  private lookup(title: string, artist: string, spotifyId: string | null): LookupResponse {
    void spotifyId;
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const match = this.catalogue.find((s) => same(s.title, title) && same(s.artist, artist)) ?? null;
    if (match) return { match, confidence: 1, method: "exact", candidates: [match] };
    const candidates = this.catalogue.filter((s) => same(s.artist, artist)).map((s) => ({ ...s, score: 0.72 }));
    return { match: null, confidence: 0, method: "none", candidates };
  }

  private searchCatalogue(q: string): Song[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return this.catalogue.filter((s) => words.some((w) => `${s.artist} ${s.title}`.toLowerCase().includes(w)));
  }

  private searchSongsterr(q: string): SongsterrResult[] {
    const text = q.toLowerCase();
    return this.songsterr.filter((r) => text.includes(r.title.toLowerCase()) || text.includes(r.artist.toLowerCase()));
  }

  /** Same contract as the real server: apply entries and removals, reply with the live lists. */
  private syncLibrary(body: unknown): Record<"history" | "favorites", Entry[]> {
    const changes = (body && typeof body === "object" ? body : {}) as Partial<Record<"history" | "favorites", (Entry | Tombstone)[]>>;
    for (const list of ["history", "favorites"] as const) {
      for (const c of changes[list] ?? []) {
        const rest = this.library[list].filter((e) => e.songId !== c.songId);
        this.library[list] = "deletedAt" in c ? rest : [c, ...rest];
      }
    }
    return { history: [...this.library.history], favorites: [...this.library.favorites] };
  }
}

function cors(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function parseBody(req: Request): unknown {
  try {
    return req.postDataJSON();
  } catch {
    return req.postData();
  }
}

export const test = base.extend<{ server: FakeServer }>({
  server: async ({ page }, use) => {
    const server = new FakeServer();
    await server.install(page);
    await use(server);
  },
});

export { expect };

/** Opens the app with `localStorage` seeded (only before the first load of this page). */
export async function openApp(page: Page, storage: Record<string, unknown> = {}): Promise<void> {
  if (Object.keys(storage).length) {
    await page.addInitScript((items) => {
      if (sessionStorage.getItem("e2e.seeded")) return;
      sessionStorage.setItem("e2e.seeded", "1");
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, JSON.stringify(v));
    }, storage);
  }
  await page.goto("/");
}
