import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedLookup, HttpError, TabApi, trackKey } from "../src/api";
import type { LookupResponse, Song, TabInfo, Track } from "../src/types";

const DAY = 24 * 60 * 60 * 1000;
const BASE = "http://tabs.test";

const track = (extra: Partial<Track> = {}): Track => ({ title: "Uprising", artist: "Muse", isPlaying: true, source: "os", player: "Spotify", ...extra });
const tab: TabInfo = { id: 5, format: "gp", name: "song.gp" };
const song: Song = { id: 7, title: "Uprising", artist: "Muse", durationMs: 304_000, tabs: [tab] };
const hit: LookupResponse = { match: song, confidence: 0.9, method: "fuzzy", candidates: [song] };
const none: LookupResponse = { match: null, confidence: 0, method: "none", candidates: [] };

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let fetchMock: ReturnType<typeof vi.fn>;
let storage: ReturnType<typeof memoryStorage>;
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  fetchMock = vi.fn(async () => json(none));
  vi.stubGlobal("fetch", fetchMock);
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("trackKey", () => {
  it("uses the Spotify ID when known", () => {
    expect(trackKey(track({ spotifyId: "abc" }))).toBe("sp:abc");
  });

  it("otherwise uses artist and title, case- and space-insensitive", () => {
    expect(trackKey(track({ artist: " MUSE ", title: "Uprising  " }))).toBe("at:muse|uprising");
    expect(trackKey(track({ spotifyId: null }))).toBe(trackKey(track({ artist: "muse", title: "UPRISING" })));
  });
});

describe("lookup", () => {
  it("queries the server with title, artist, duration and Spotify ID", async () => {
    const api = new TabApi(BASE);
    await api.lookup(track({ durationMs: 304_000, spotifyId: "abc" }));
    const u = new URL(urls()[0]);
    expect(u.origin + u.pathname).toBe(`${BASE}/v1/tabs/lookup`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ title: "Uprising", artist: "Muse", durationMs: "304000", spotifyId: "abc" });
  });

  it("omits unknown duration and Spotify ID", async () => {
    await new TabApi(BASE).lookup(track());
    expect([...new URL(urls()[0]).searchParams.keys()]).toEqual(["title", "artist"]);
  });

  it("caches a match on the device and serves it without the server", async () => {
    const api = new TabApi(BASE);
    fetchMock.mockResolvedValueOnce(json(hit));
    expect(await api.lookup(track())).toEqual(hit);
    expect(storage.keys()).toEqual(["tabsync.lookup.at:muse|uprising"]);

    const again = await api.lookup(track());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again).toEqual({ match: song, confidence: 1, method: "external-id", candidates: [song] });
  });

  it("does not cache a miss", async () => {
    const api = new TabApi(BASE);
    await api.lookup(track());
    await api.lookup(track());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storage.keys()).toEqual([]);
  });

  it("expires the cached match after 7 days", async () => {
    const api = new TabApi(BASE);
    fetchMock.mockResolvedValueOnce(json(hit));
    await api.lookup(track());
    vi.advanceTimersByTime(7 * DAY - 1);
    await api.lookup(track());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await api.lookup(track());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a corrupt cache entry", async () => {
    storage.setItem("tabsync.lookup.at:muse|uprising", "{not json");
    await new TabApi(BASE).lookup(track());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("works without localStorage", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    fetchMock.mockImplementation(async () => json(hit));
    const api = new TabApi(BASE);
    expect((await api.lookup(track())).match).toEqual(song);
    await api.lookup(track());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clearCachedLookup forgets the match", async () => {
    const api = new TabApi(BASE);
    fetchMock.mockImplementation(async () => json(hit));
    await api.lookup(track());
    clearCachedLookup(track());
    await api.lookup(track());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-OK response", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "boom" }, 500));
    await expect(new TabApi(BASE).lookup(track())).rejects.toThrow(/GET \/v1\/tabs\/lookup\?.* → 500/);
  });
});

describe("other endpoints", () => {
  it("strips trailing slashes from the base URL", async () => {
    const api = new TabApi(BASE);
    api.setBaseUrl(`${BASE}//`);
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    expect(await api.health()).toEqual({ ok: true });
    expect(urls()).toEqual([`${BASE}/health`]);
  });

  it("searches the catalogue and Songsterr", async () => {
    const api = new TabApi(BASE);
    fetchMock.mockResolvedValueOnce(json({ results: [song] })).mockResolvedValueOnce(json({ results: [{ songId: 1 }] }));
    expect(await api.search("muse up")).toEqual({ results: [song] });
    expect(await api.songsterrSearch("muse up")).toEqual([{ songId: 1 }]);
    expect(urls()).toEqual([`${BASE}/v1/songs?q=muse+up`, `${BASE}/v1/songsterr/search?q=muse+up`]);
  });

  it("confirm caches the pick and links the Spotify ID on the server", async () => {
    const api = new TabApi(BASE);
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await api.confirm(track({ spotifyId: "abc" }), song);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/songs/7/external-ids`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ provider: "spotify", externalId: "abc" });

    expect((await api.lookup(track({ spotifyId: "abc" }))).match).toEqual(song);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("confirm without a Spotify ID stays on the device", async () => {
    const api = new TabApi(BASE);
    await api.confirm(track(), song);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await api.lookup(track())).match).toEqual(song);
  });

  it("reports a failed confirm as an error", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404));
    await expect(new TabApi(BASE).confirm(track({ spotifyId: "abc" }), song)).rejects.toThrow("POST /v1/songs/7/external-ids → 404");
  });

  it("downloads tab content once, using the server's format header", async () => {
    const api = new TabApi(BASE);
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "X-Tab-Format": "musicxml" } }));
    const a = await api.tab(tab);
    expect(a.format).toBe("musicxml");
    expect([...new Uint8Array(a.data)]).toEqual([1, 2, 3]);
    expect(await api.tab(tab)).toBe(a);
    expect(urls()).toEqual([`${BASE}/v1/tabs/5/content`]);
  });

  it("falls back to the tab's own format and throws on errors", async () => {
    const api = new TabApi(BASE);
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1])));
    expect((await api.tab(tab)).format).toBe("gp");
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(api.tab({ ...tab, id: 6 })).rejects.toThrow("tab 6 → 404");
  });

  it("reads the synced library", async () => {
    const api = new TabApi(BASE);
    const lists = { history: [], favorites: [] };
    fetchMock.mockResolvedValueOnce(json(lists));
    expect(await api.library()).toEqual(lists);
    expect(urls()).toEqual([`${BASE}/v1/library`]);
  });

  it("posts library changes as JSON and returns the merged lists", async () => {
    const api = new TabApi(BASE);
    const merged = { history: [{ url: "u", songId: 1, title: "T", artist: "A", at: 5 }], favorites: [] };
    fetchMock.mockResolvedValueOnce(json(merged));
    const body = { favorites: [{ songId: 2, deletedAt: 9 }] };
    expect(await api.syncLibrary(body)).toEqual(merged);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/library/sync`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("reports the HTTP status of a failed request", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "bad" }, 400));
    const err = await new TabApi(BASE).syncLibrary({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(String(err)).toMatch(/POST \/v1\/library\/sync → 400/);
  });

  it("Spotify fallback endpoints", async () => {
    const api = new TabApi(BASE);
    const t = track({ source: "spotify-api" });
    fetchMock.mockResolvedValueOnce(json({ configured: true, connected: false })).mockResolvedValueOnce(json({ track: t }));
    expect(await api.spotifyStatus()).toEqual({ configured: true, connected: false });
    expect(await api.spotifyNowPlaying()).toEqual(t);
    expect(api.spotifyLoginUrl()).toBe(`${BASE}/auth/spotify/login`);
    expect(urls()).toEqual([`${BASE}/auth/spotify/status`, `${BASE}/v1/spotify/now-playing`]);
  });
});
