import { describe, expect, it } from "vitest";
import { EntryStore, isSongPage, PickStore, pushHistory, toEntry, toggleFavorite, trackKey, type TabEntry } from "../src/library";
import type { Track } from "../src/types";

const e = (songId: number, at = songId): TabEntry => ({ url: `https://www.songsterr.com/a/wa/song?id=${songId}`, songId, title: `T${songId}`, artist: "A", at });

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("history", () => {
  it("keeps one entry per song, most recent first, capped", () => {
    let h: TabEntry[] = [];
    h = pushHistory(h, e(1));
    h = pushHistory(h, e(2));
    h = pushHistory(h, e(1, 99));
    expect(h.map((x) => [x.songId, x.at])).toEqual([[1, 99], [2, 2]]);
    for (let i = 10; i < 20; i++) h = pushHistory(h, e(i), 5);
    expect(h).toHaveLength(5);
    expect(h[0].songId).toBe(19);
  });

  it("ignores Songsterr search pages", () => {
    expect(isSongPage({ songId: 0 })).toBe(false);
    expect(isSongPage({ songId: 42 })).toBe(true);
  });
});

describe("favorites", () => {
  it("toggles by song id", () => {
    const f = toggleFavorite([], e(1));
    expect(f.map((x) => x.songId)).toEqual([1]);
    expect(toggleFavorite(f, e(1, 5))).toEqual([]);
  });

  it("stores url and metadata locally and survives a reload", () => {
    const storage = memoryStorage();
    const a = new EntryStore("fav", storage);
    a.update((l) => toggleFavorite(l, toEntry({ songId: 7, title: "Song", artist: "Band", instruments: [], url: "https://x/7" }, 1)));
    const b = new EntryStore("fav", storage);
    expect(b.all).toEqual([{ songId: 7, title: "Song", artist: "Band", url: "https://x/7", at: 1 }]);
    expect(b.has(7)).toBe(true);
  });

  it("drops malformed stored entries", () => {
    const storage = memoryStorage();
    storage.setItem("h", JSON.stringify([e(1), { songId: "x" }, null]));
    expect(new EntryStore("h", storage).all).toEqual([e(1)]);
    storage.setItem("h", "oops");
    expect(new EntryStore("h", storage).all).toEqual([]);
  });
});

describe("picks", () => {
  it("remembers and forgets the user's tab for a track", () => {
    const storage = memoryStorage();
    const r = { songId: 3, title: "S", artist: "A", instruments: [], url: "https://x/3" };
    new PickStore("p", storage).set("sp:abc", r);
    const p = new PickStore("p", storage);
    expect(p.get("sp:abc")).toEqual(r);
    p.set("sp:abc", null);
    expect(new PickStore("p", storage).get("sp:abc")).toBeNull();
  });
});

describe("trackKey", () => {
  const track = (extra: Partial<Track> = {}): Track => ({ title: "Uprising", artist: "Muse", isPlaying: true, source: "os", player: "Spotify", ...extra });

  it("uses the Spotify ID when known", () => {
    expect(trackKey(track({ spotifyId: "abc" }))).toBe("sp:abc");
  });

  it("otherwise uses artist and title, case- and space-insensitive", () => {
    expect(trackKey(track({ artist: " MUSE ", title: "Uprising  " }))).toBe("at:muse|uprising");
    expect(trackKey(track({ spotifyId: null }))).toBe(trackKey(track({ artist: "muse", title: "UPRISING" })));
  });
});
