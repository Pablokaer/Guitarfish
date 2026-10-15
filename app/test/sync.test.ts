import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackKey } from "../src/api";
import { songsterrSearchPage } from "../src/match";
import { EVENT_POLL_MS, POLL_MS, pollIntervalFor, RETRY_MS, SyncController, type SyncDeps, type SyncUi } from "../src/sync";
import type { LookupResponse, Song, SongsterrResult, Track } from "../src/types";

const track = (title: string, artist: string, extra: Partial<Track> = {}): Track => ({
  title,
  artist,
  isPlaying: true,
  source: "os",
  player: "Spotify",
  ...extra,
});
const result = (songId: number, title: string, artist: string): SongsterrResult => ({
  songId,
  title,
  artist,
  instruments: ["Guitar"],
  url: `https://www.songsterr.com/a/wsa/${songId}`,
});
const song = (id: number, title: string, artist: string): Song => ({ id, title, artist, durationMs: null, tabs: [] });
const miss = (candidates: Song[] = []): LookupResponse => ({ match: null, confidence: 0, method: "none", candidates });

const uprising = track("Uprising", "Muse", { spotifyId: "sp1" });
const uprisingTab = result(29482, "Uprising", "Muse");
const wonderwall = track("Wonderwall - Remastered", "Oasis");
const wonderwallTab = result(1, "Wonderwall", "Oasis");

/** A promise resolved or rejected from the test, to control ordering. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function memoryPicks() {
  const m = new Map<string, SongsterrResult>();
  return {
    get: vi.fn((k: string) => m.get(k) ?? null),
    set: vi.fn((k: string, r: SongsterrResult | null) => void (r ? m.set(k, r) : m.delete(k))),
  };
}

function setup(over: Partial<SyncDeps> = {}) {
  let reading: Track | null = null;
  let clock = 0;
  const ui = {
    nowPlaying: vi.fn(),
    trackChanged: vi.fn(),
    status: vi.fn(),
    openSongsterr: vi.fn(),
    serverUnreachable: vi.fn(),
    localMatch: vi.fn(async () => {}),
    localMiss: vi.fn(),
    renderStage: vi.fn(),
    renderAll: vi.fn(),
  } satisfies SyncUi;
  const api = {
    lookup: vi.fn(async (): Promise<LookupResponse> => miss()),
    songsterrSearch: vi.fn(async (q: string): Promise<SongsterrResult[]> => (q.includes("Uprising") ? [uprisingTab] : [])),
  };
  const picks = memoryPicks();
  const settings = { followSpotify: true, autoSearch: true };
  const forgetLookup = vi.fn();
  const deps: SyncDeps = {
    detector: { read: vi.fn(async () => reading) },
    api,
    picks,
    settings,
    ui,
    now: () => clock,
    forgetLookup,
    ...over,
  };
  const sync = new SyncController(deps);
  return {
    sync,
    ui,
    api,
    picks,
    settings,
    forgetLookup,
    detector: deps.detector,
    play: (t: Track | null) => (reading = t),
    tick: (ms: number) => (clock += ms),
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("polling", () => {
  it("reports each reading, then refreshes the status", async () => {
    const s = setup();
    await s.sync.poll();
    expect(s.ui.nowPlaying).toHaveBeenCalledWith(null);
    expect(s.ui.status).toHaveBeenCalled();
    expect(s.sync.current).toBeNull();
    expect(s.api.songsterrSearch).not.toHaveBeenCalled();
    expect(s.api.lookup).not.toHaveBeenCalled();
  });

  it("looks a track up only when its identity changes", async () => {
    const s = setup();
    s.play(uprising);
    await s.sync.poll();
    await flush();
    s.play({ ...uprising, positionMs: 5000 });
    await s.sync.poll();
    await flush();
    expect(s.ui.trackChanged).toHaveBeenCalledTimes(1);
    expect(s.api.songsterrSearch).toHaveBeenCalledTimes(1);
    expect(s.api.lookup).toHaveBeenCalledTimes(1);
    expect(s.sync.current?.positionMs).toBe(5000);
  });

  it("ignores a poll while the previous one is still reading", async () => {
    const read = deferred<Track | null>();
    const s = setup({ detector: { read: vi.fn(() => read.promise) } });
    const first = s.sync.poll();
    await s.sync.poll();
    expect(s.detector.read).toHaveBeenCalledTimes(1);
    read.resolve(null);
    await first;
    await s.sync.poll();
    expect(s.detector.read).toHaveBeenCalledTimes(2);
  });

  it("start() polls now and then every POLL_MS", async () => {
    const s = setup();
    await s.sync.start();
    expect(s.detector.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(s.detector.read).toHaveBeenCalledTimes(4);
  });

  it("relookup() makes the next poll look the same track up again", async () => {
    const s = setup();
    s.play(uprising);
    await s.sync.poll();
    s.sync.relookup();
    await s.sync.poll();
    await flush();
    expect(s.ui.trackChanged).toHaveBeenCalledTimes(2);
  });
});

describe("event-driven polling", () => {
  it("polls every POLL_MS without playback events, every EVENT_POLL_MS with them", () => {
    expect(pollIntervalFor(null)).toBe(POLL_MS);
    expect(pollIntervalFor({ transport: true, seek: true, volume: true })).toBe(POLL_MS);
    expect(pollIntervalFor({ transport: true, seek: true, volume: true, events: false })).toBe(POLL_MS);
    expect(pollIntervalFor({ transport: true, seek: true, volume: true, events: true })).toBe(EVENT_POLL_MS);
    expect(EVENT_POLL_MS).toBeGreaterThan(POLL_MS);
  });

  it("start() takes the interval to poll at", async () => {
    const s = setup();
    await s.sync.start(EVENT_POLL_MS);
    expect(s.detector.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EVENT_POLL_MS - 1);
    expect(s.detector.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.detector.read).toHaveBeenCalledTimes(2);
  });

  it("setPollInterval() changes the interval of a running loop", async () => {
    const s = setup();
    await s.sync.start();
    s.sync.setPollInterval(EVENT_POLL_MS);
    await vi.advanceTimersByTimeAsync(EVENT_POLL_MS * 2);
    expect(s.detector.read).toHaveBeenCalledTimes(3);
  });

  it("wake() polls at once and restarts the interval", async () => {
    const s = setup();
    await s.sync.start(EVENT_POLL_MS);
    await vi.advanceTimersByTimeAsync(EVENT_POLL_MS - 1000);
    s.play(uprising);
    await s.sync.wake();
    expect(s.detector.read).toHaveBeenCalledTimes(2);
    expect(s.sync.current).toEqual(uprising);
    // The next regular poll is a full interval after the wake-up.
    await vi.advanceTimersByTimeAsync(EVENT_POLL_MS - 1);
    expect(s.detector.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.detector.read).toHaveBeenCalledTimes(3);
  });

  it("wake() during a poll reads again once that poll finishes", async () => {
    const read = deferred<Track | null>();
    const s = setup();
    s.detector.read = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(wonderwall);
    const first = s.sync.poll();
    const woken = s.sync.wake();
    expect(s.detector.read).toHaveBeenCalledTimes(1);
    read.resolve(uprising);
    await first;
    await woken;
    expect(s.detector.read).toHaveBeenCalledTimes(2);
    expect(s.sync.current).toEqual(wonderwall);
  });

  it("wake() before start() only polls", async () => {
    const s = setup();
    await s.sync.wake();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(s.detector.read).toHaveBeenCalledTimes(1);
  });
});

describe("track change", () => {
  it("opens a confident Songsterr match automatically", async () => {
    const s = setup();
    const search = deferred<SongsterrResult[]>();
    s.api.songsterrSearch.mockReturnValueOnce(search.promise);
    s.play(uprising);
    await s.sync.poll();
    expect(s.sync.phase).toBe("searching");
    search.resolve([uprisingTab]);
    await flush();
    expect(s.api.songsterrSearch).toHaveBeenCalledWith("Muse Uprising");
    expect(s.sync.phase).toBe("found");
    expect(s.sync.best).toEqual(uprisingTab);
    expect(s.sync.results).toEqual([uprisingTab]);
    expect(s.ui.openSongsterr).toHaveBeenCalledWith(uprisingTab);
    expect(s.ui.renderAll).not.toHaveBeenCalled();
  });

  it("drops the previous track's state before searching", async () => {
    const s = setup();
    s.play(uprising);
    await s.sync.poll();
    await flush();
    const search = deferred<SongsterrResult[]>();
    s.api.songsterrSearch.mockReturnValueOnce(search.promise);
    s.play(wonderwall);
    await s.sync.poll();
    expect(s.ui.trackChanged).toHaveBeenLastCalledWith(wonderwall);
    expect(s.sync.best).toBeNull();
    expect(s.sync.results).toEqual([]);
    expect(s.ui.renderStage).toHaveBeenCalled();
  });

  it("strips Spotify title noise from the query", async () => {
    const s = setup();
    s.api.songsterrSearch.mockResolvedValueOnce([wonderwallTab]);
    s.play(wonderwall);
    await s.sync.poll();
    await flush();
    expect(s.api.songsterrSearch).toHaveBeenCalledWith("Oasis Wonderwall");
    expect(s.sync.phase).toBe("found");
  });

  it("opens the closest result when none is a confident match", async () => {
    const s = setup();
    const other = result(9, "Something Else", "Someone");
    s.api.songsterrSearch.mockResolvedValueOnce([other, uprisingTab]);
    s.play(wonderwall);
    await s.sync.poll();
    await flush();
    expect(s.sync.phase).toBe("uncertain");
    expect(s.sync.best).toEqual(other);
    expect(s.ui.openSongsterr).toHaveBeenCalledWith(other);
  });

  it("prefers a confident match over search order", async () => {
    const s = setup();
    const other = result(9, "Uprising Live Bootleg Mix", "Tribute Band");
    s.api.songsterrSearch.mockResolvedValueOnce([other, uprisingTab]);
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(s.sync.best).toEqual(uprisingTab);
  });

  it("falls back to Songsterr's search page when there are no results", async () => {
    const s = setup();
    s.play(wonderwall);
    await s.sync.poll();
    await flush();
    expect(s.sync.phase).toBe("none");
    expect(s.sync.best).toEqual(songsterrSearchPage("Oasis Wonderwall"));
    expect(s.ui.openSongsterr).toHaveBeenCalledWith(songsterrSearchPage("Oasis Wonderwall"));
  });

  it("with Follow Spotify off, finds the tab but only re-renders", async () => {
    const s = setup();
    s.settings.followSpotify = false;
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(s.sync.phase).toBe("found");
    expect(s.sync.best).toEqual(uprisingTab);
    expect(s.ui.openSongsterr).not.toHaveBeenCalled();
    expect(s.ui.renderAll).toHaveBeenCalled();
  });

  it("with automatic search off, waits until asked", async () => {
    const s = setup();
    s.settings.autoSearch = false;
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(s.sync.phase).toBe("paused");
    expect(s.api.songsterrSearch).not.toHaveBeenCalled();
    expect(s.api.lookup).toHaveBeenCalledWith(uprising); // the local catalogue still looks
    await s.sync.searchCurrent();
    expect(s.sync.phase).toBe("found");
    expect(s.ui.openSongsterr).toHaveBeenCalledWith(uprisingTab);
  });

  it("searchCurrent() does nothing without a track", async () => {
    const s = setup();
    await s.sync.searchCurrent();
    expect(s.api.songsterrSearch).not.toHaveBeenCalled();
  });

  it("reports phase changes through status()", async () => {
    const s = setup();
    const phases: string[] = [];
    s.ui.status.mockImplementation(() => phases.push(s.sync.phase));
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(phases).toContain("searching");
    expect(phases).toContain("found");
  });
});

describe("stale results", () => {
  it("discards a Songsterr result that arrives after the track changed", async () => {
    const s = setup();
    const slow = deferred<SongsterrResult[]>();
    s.api.songsterrSearch.mockReturnValueOnce(slow.promise);
    s.play(uprising);
    await s.sync.poll();
    s.api.songsterrSearch.mockResolvedValueOnce([wonderwallTab]);
    s.play(wonderwall);
    await s.sync.poll();
    await flush();
    expect(s.sync.best).toEqual(wonderwallTab);

    slow.resolve([uprisingTab]);
    await flush();
    expect(s.sync.best).toEqual(wonderwallTab);
    expect(s.sync.phase).toBe("found");
    expect(s.ui.openSongsterr).not.toHaveBeenCalledWith(uprisingTab);
  });

  it("discards a stale Songsterr error (no banner, no retry)", async () => {
    const s = setup();
    const slow = deferred<SongsterrResult[]>();
    s.api.songsterrSearch.mockReturnValueOnce(slow.promise);
    s.play(uprising);
    await s.sync.poll();
    s.play(wonderwall);
    await s.sync.poll();
    await flush();
    slow.reject(new Error("offline"));
    await flush();
    expect(s.ui.serverUnreachable).not.toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(s.api.songsterrSearch).toHaveBeenCalledTimes(2);
  });

  it("discards a local catalogue result that arrives after the track changed", async () => {
    const s = setup();
    const slow = deferred<LookupResponse>();
    s.api.lookup.mockReturnValueOnce(slow.promise);
    s.play(uprising);
    await s.sync.poll();
    s.play(wonderwall);
    await s.sync.poll();
    await flush();
    slow.resolve({ match: song(1, "Uprising", "Muse"), confidence: 1, method: "exact", candidates: [] });
    await flush();
    expect(s.ui.localMatch).not.toHaveBeenCalled();
    expect(s.ui.localMiss).toHaveBeenCalledTimes(1);
    expect(s.ui.localMiss).toHaveBeenCalledWith(wonderwall, []);
  });
});

describe("server errors", () => {
  it("shows Songsterr's search page and retries until the server answers", async () => {
    const s = setup();
    s.api.songsterrSearch.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    s.play(uprising);
    await s.sync.poll();
    await flush();
    const page = songsterrSearchPage("Muse Uprising");
    expect(s.sync.phase).toBe("server-error");
    expect(s.ui.serverUnreachable).toHaveBeenCalledWith(true);
    expect(s.sync.best).toEqual(page);
    expect(s.ui.openSongsterr).toHaveBeenCalledWith(page);

    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(s.api.songsterrSearch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.api.songsterrSearch).toHaveBeenCalledTimes(2);
    expect(s.sync.phase).toBe("server-error");

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.api.songsterrSearch).toHaveBeenCalledTimes(3);
    expect(s.sync.phase).toBe("found");
    expect(s.ui.serverUnreachable).toHaveBeenLastCalledWith(false);
    expect(s.ui.openSongsterr).toHaveBeenLastCalledWith(uprisingTab);

    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(s.api.songsterrSearch).toHaveBeenCalledTimes(3);
  });

  it("does not open the search page with Follow Spotify off", async () => {
    const s = setup();
    s.settings.followSpotify = false;
    s.api.songsterrSearch.mockRejectedValueOnce(new Error("offline"));
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(s.sync.phase).toBe("server-error");
    expect(s.ui.openSongsterr).not.toHaveBeenCalled();
  });

  it("stops retrying once the track changed", async () => {
    const s = setup();
    s.api.songsterrSearch.mockRejectedValueOnce(new Error("offline"));
    s.play(uprising);
    await s.sync.poll();
    await flush();
    s.api.songsterrSearch.mockResolvedValueOnce([wonderwallTab]);
    s.play(wonderwall);
    await s.sync.poll();
    await flush();
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(s.api.songsterrSearch).toHaveBeenCalledTimes(2);
    expect(s.api.songsterrSearch).toHaveBeenLastCalledWith("Oasis Wonderwall");
  });

  it("stops retrying when the phase moved on (e.g. the user picked a tab)", async () => {
    const s = setup();
    s.api.songsterrSearch.mockRejectedValueOnce(new Error("offline"));
    s.play(uprising);
    await s.sync.poll();
    await flush();
    s.sync.pick(uprising, uprisingTab);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(s.api.songsterrSearch).toHaveBeenCalledTimes(1);
  });
});

describe("local catalogue", () => {
  it("opens an exact match", async () => {
    const s = setup();
    const m = song(3, "Uprising", "Muse");
    s.api.lookup.mockResolvedValueOnce({ match: m, confidence: 1, method: "exact", candidates: [m] });
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(s.ui.localMatch).toHaveBeenCalledWith(m, "exact");
  });

  it("describes a fuzzy match with its score", async () => {
    const s = setup();
    const m = song(3, "Uprisin", "Muse");
    s.api.lookup.mockResolvedValueOnce({ match: m, confidence: 0.874, method: "fuzzy", candidates: [m] });
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(s.ui.localMatch).toHaveBeenCalledWith(m, "fuzzy 87%");
  });

  it("offers candidates when there is no match", async () => {
    const s = setup();
    const c = [song(4, "Uprise", "Muse")];
    s.api.lookup.mockResolvedValueOnce(miss(c));
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(s.ui.localMiss).toHaveBeenCalledWith(uprising, c);
  });

  it("retries a failed lookup every RETRY_MS while the track plays", async () => {
    const s = setup();
    s.api.lookup.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(s.api.lookup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.api.lookup).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.api.lookup).toHaveBeenCalledTimes(3);
    expect(s.ui.localMiss).toHaveBeenCalledWith(uprising, []);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(s.api.lookup).toHaveBeenCalledTimes(3);
  });

  it("stops retrying the lookup once the track changed", async () => {
    const s = setup();
    s.api.lookup.mockRejectedValueOnce(new Error("offline"));
    s.play(uprising);
    await s.sync.poll();
    await flush();
    s.play(wonderwall);
    await s.sync.poll();
    await flush();
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(s.api.lookup.mock.calls.map((c) => (c as unknown as [Track])[0].title)).toEqual(["Uprising", "Wonderwall - Remastered"]);
  });
});

describe("picks", () => {
  it("uses the user's pick instead of searching", async () => {
    const s = setup();
    const pick = result(77, "Uprising (Acoustic)", "Muse");
    s.picks.set(trackKey(uprising), pick);
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(s.sync.phase).toBe("picked");
    expect(s.sync.best).toEqual(pick);
    expect(s.ui.openSongsterr).toHaveBeenCalledWith(pick);
    expect(s.api.songsterrSearch).not.toHaveBeenCalled();
    expect(s.api.lookup).toHaveBeenCalled();
  });

  it("does not open the pick with Follow Spotify off", async () => {
    const s = setup();
    s.settings.followSpotify = false;
    s.picks.set(trackKey(uprising), uprisingTab);
    s.play(uprising);
    await s.sync.poll();
    expect(s.sync.phase).toBe("picked");
    expect(s.ui.openSongsterr).not.toHaveBeenCalled();
  });

  it("pick() remembers a choice for the playing track", async () => {
    const s = setup();
    s.play(uprising);
    await s.sync.poll();
    await flush();
    const pick = result(77, "Uprising (Acoustic)", "Muse");
    expect(s.sync.pick(uprising, pick)).toBe(true);
    expect(s.picks.get(trackKey(uprising))).toEqual(pick);
    expect(s.sync.best).toEqual(pick);
    expect(s.sync.phase).toBe("picked");
  });

  it("pick() ignores a track that is no longer playing", async () => {
    const s = setup();
    s.play(uprising);
    await s.sync.poll();
    await flush();
    expect(s.sync.pick(wonderwall, wonderwallTab)).toBe(false);
    expect(s.picks.set).not.toHaveBeenCalled();
    expect(s.sync.best).toEqual(uprisingTab);
  });

  it("searchAgain() forgets the pick and the cached lookup, then searches both sides", async () => {
    const s = setup();
    s.picks.set(trackKey(uprising), result(77, "Uprising (Acoustic)", "Muse"));
    s.play(uprising);
    await s.sync.poll();
    await flush();
    await s.sync.searchAgain();
    await flush();
    expect(s.picks.get(trackKey(uprising))).toBeNull();
    expect(s.forgetLookup).toHaveBeenCalledWith(uprising);
    expect(s.api.songsterrSearch).toHaveBeenCalledTimes(1);
    expect(s.api.lookup).toHaveBeenCalledTimes(2);
    expect(s.sync.phase).toBe("found");
    expect(s.sync.best).toEqual(uprisingTab);
  });

  it("searchAgain() does nothing without a track", async () => {
    const s = setup();
    await s.sync.searchAgain();
    expect(s.forgetLookup).not.toHaveBeenCalled();
    expect(s.api.lookup).not.toHaveBeenCalled();
  });
});

describe("position", () => {
  it("advances the last reading while playing, up to the song's end", async () => {
    const s = setup();
    s.play({ ...uprising, positionMs: 1000, durationMs: 5000 });
    await s.sync.poll();
    expect(s.sync.livePosition()).toBe(1000);
    s.tick(1500);
    expect(s.sync.livePosition()).toBe(2500);
    s.tick(10_000);
    expect(s.sync.livePosition()).toBe(5000);
  });

  it("stays put while paused and is null without a position", async () => {
    const s = setup();
    expect(s.sync.livePosition()).toBeNull();
    s.play({ ...uprising, positionMs: 1000, isPlaying: false });
    await s.sync.poll();
    s.tick(1500);
    expect(s.sync.livePosition()).toBe(1000);
    s.play({ ...uprising, positionMs: null });
    await s.sync.poll();
    expect(s.sync.livePosition()).toBeNull();
  });

  it("patchCurrent() applies an optimistic change from now", async () => {
    const s = setup();
    s.play({ ...uprising, positionMs: 1000 });
    await s.sync.poll();
    s.tick(500);
    s.sync.patchCurrent({ positionMs: s.sync.livePosition(), isPlaying: false });
    s.tick(500);
    expect(s.sync.current?.isPlaying).toBe(false);
    expect(s.sync.livePosition()).toBe(1500);
  });

  it("patchCurrent() does nothing without a track", () => {
    const s = setup();
    s.sync.patchCurrent({ positionMs: 10 });
    expect(s.sync.current).toBeNull();
  });
});
