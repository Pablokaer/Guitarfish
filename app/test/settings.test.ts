import { describe, expect, it } from "vitest";
import { defaultSettings, dropLegacyStorage, parseSettings } from "../src/settings";

describe("parseSettings", () => {
  it("defaults to Songsterr, following Spotify, automatic search", () => {
    expect(parseSettings(null)).toMatchObject({ songsterrPanel: true, followSpotify: true, autoSearch: true, theme: "graphite", version: 2 });
  });

  it("moves v1 users to Songsterr once, keeping their other settings", () => {
    const s = parseSettings({ songsterrPanel: false, zoom: 1.2, follow: false });
    expect(s).toMatchObject({ songsterrPanel: true, zoom: 1.2, follow: false, version: 2 });
  });

  it("respects a v2 choice of the local tab", () => {
    expect(parseSettings({ version: 2, songsterrPanel: false }).songsterrPanel).toBe(false);
  });

  it("rejects unknown themes", () => {
    expect(parseSettings({ version: 2, theme: "neon" }).theme).toBe("graphite");
  });

  it("forgets settings that no longer exist (tab server, Web API fallback, library sync)", () => {
    const s = parseSettings({ version: 2, zoom: 1.2, serverUrl: "http://192.168.1.20:8787", spotifyFallback: true, librarySync: false });
    expect(s).toEqual({ ...defaultSettings(), zoom: 1.2 });
    expect(Object.keys(s).sort()).toEqual(Object.keys(defaultSettings()).sort());
  });
});

describe("dropLegacyStorage", () => {
  function storage(entries: Record<string, string>) {
    const m = new Map(Object.entries(entries));
    return {
      get length() {
        return m.size;
      },
      key: (i: number) => [...m.keys()][i] ?? null,
      removeItem: (k: string) => void m.delete(k),
      keys: () => [...m.keys()].sort(),
    };
  }

  it("removes what only the server needed: cached lookups and the library sync queue", () => {
    const s = storage({
      "tabsync.lookup.sp:abc": "{}",
      "tabsync.lookup.at:muse|uprising": "{}",
      "tabsync.library.pending": "{}",
      "tabsync.library.seeded": "1",
      "tabsync.settings": "{}",
      "tabsync.history": "[]",
      "tabsync.favorites": "[]",
      "tabsync.songsterr.picks": "{}",
      "tabsync.practice": "{}",
      "tabsync.layout": "{}",
      "other.app": "x",
    });
    dropLegacyStorage(s);
    expect(s.keys()).toEqual([
      "other.app",
      "tabsync.favorites",
      "tabsync.history",
      "tabsync.layout",
      "tabsync.practice",
      "tabsync.settings",
      "tabsync.songsterr.picks",
    ]);
  });

  it("ignores storage that can't be read", () => {
    const broken = {
      get length(): number {
        throw new Error("denied");
      },
      key: () => null,
      removeItem: () => {},
    };
    expect(() => dropLegacyStorage(broken)).not.toThrow();
  });
});
