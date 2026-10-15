import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/api";
import { EntryStore, HISTORY_LIMIT, type Change, type LibraryLists, type TabEntry } from "../src/library";
import {
  applyChanges,
  ChangeQueue,
  chunk,
  LIBRARY_QUEUE_KEY,
  LIBRARY_SEEDED_KEY,
  LibrarySync,
  type LibrarySyncDeps,
  MAX_CHANGES,
  SYNC_DEBOUNCE_MS,
  SYNC_EVERY_MS,
  syncHint,
} from "../src/librarysync";

const e = (songId: number, at = songId): TabEntry => ({ url: `https://www.songsterr.com/a/wa/song?id=${songId}`, songId, title: `T${songId}`, artist: "A", at });
const gone = (songId: number, deletedAt: number): Change => ({ songId, deletedAt });
const ids = (l: readonly TabEntry[]) => l.map((x) => x.songId);

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

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

const NOW = 1_000_000;
const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(opts: { history?: TabEntry[]; favorites?: TabEntry[]; seeded?: boolean; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const storage = opts.storage ?? memoryStorage();
  const history = new EntryStore("tabsync.history", storage);
  const favorites = new EntryStore("tabsync.favorites", storage);
  if (opts.history) history.update(() => opts.history!);
  if (opts.favorites) favorites.update(() => opts.favorites!);
  if (opts.seeded ?? true) storage.setItem(LIBRARY_SEEDED_KEY, "1");
  /** What the fake server holds; sync requests merge into it. */
  const server: LibraryLists = { history: [], favorites: [] };
  const api = {
    library: vi.fn(async (): Promise<LibraryLists> => structuredClone(server)),
    syncLibrary: vi.fn(async (req: { history?: Change[]; favorites?: Change[] }): Promise<LibraryLists> => {
      server.history = applyChanges(server.history, req.history ?? [], HISTORY_LIMIT);
      server.favorites = applyChanges(server.favorites, req.favorites ?? []);
      return structuredClone(server);
    }),
  };
  const settings = { enabled: true };
  const onChange = vi.fn();
  const onStatus = vi.fn();
  const deps: LibrarySyncDeps = {
    api,
    history,
    favorites,
    enabled: () => settings.enabled,
    storage,
    now: () => Date.now(),
    onChange,
    onStatus,
  };
  const lib = new LibrarySync(deps);
  return { lib, api, server, history, favorites, storage, settings, onChange, onStatus, deps };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChangeQueue", () => {
  it("persists pending changes per list under a tabsync. key", () => {
    const storage = memoryStorage();
    const q = new ChangeQueue(storage);
    q.add("history", e(1, 10));
    q.add("favorites", gone(2, 20));
    expect(LIBRARY_QUEUE_KEY.startsWith("tabsync.")).toBe(true);
    expect(storage.raw.has(LIBRARY_QUEUE_KEY)).toBe(true);
    const again = new ChangeQueue(storage);
    expect(again.list("history")).toEqual([e(1, 10)]);
    expect(again.list("favorites")).toEqual([gone(2, 20)]);
    expect(again.size).toBe(2);
  });

  it("keeps one change per song: the newest, a removal on a tie", () => {
    const q = new ChangeQueue(memoryStorage());
    q.add("favorites", e(1, 10));
    q.add("favorites", gone(1, 20));
    expect(q.list("favorites")).toEqual([gone(1, 20)]);
    q.add("favorites", e(1, 15)); // older than the removal
    expect(q.list("favorites")).toEqual([gone(1, 20)]);
    q.add("favorites", e(1, 20)); // tie: removal wins
    expect(q.list("favorites")).toEqual([gone(1, 20)]);
    q.add("favorites", e(1, 30));
    expect(q.list("favorites")).toEqual([e(1, 30)]);
    q.add("history", e(1, 5)); // lists are independent
    expect(q.size).toBe(2);
  });

  it("removes only the changes that were sent", () => {
    const q = new ChangeQueue(memoryStorage());
    q.add("history", e(1, 10));
    q.add("history", e(2, 10));
    const sent = [...q.list("history")];
    q.add("history", e(1, 30)); // changed again while the request was in flight
    q.remove("history", sent);
    expect(q.list("history")).toEqual([e(1, 30)]);
  });

  it("ignores corrupt storage and malformed items", () => {
    const storage = memoryStorage();
    storage.setItem(LIBRARY_QUEUE_KEY, "{nope");
    expect(new ChangeQueue(storage).size).toBe(0);
    storage.setItem(LIBRARY_QUEUE_KEY, JSON.stringify({ history: [e(1), { songId: "x" }, null], favorites: "bad" }));
    const q = new ChangeQueue(storage);
    expect(q.list("history")).toEqual([e(1)]);
    expect(q.list("favorites")).toEqual([]);
  });

  it("works without storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const q = new ChangeQueue(broken);
    q.add("history", e(1));
    expect(q.size).toBe(1);
  });
});

describe("chunk", () => {
  it("splits into groups of at most MAX_CHANGES", () => {
    expect(MAX_CHANGES).toBe(500);
    const items = Array.from({ length: 1200 }, (_, i) => i);
    expect(chunk(items).map((c) => c.length)).toEqual([500, 500, 200]);
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunk([])).toEqual([]);
  });
});

describe("applyChanges", () => {
  it("adds and replaces entries by song, newest first", () => {
    const list = [e(1, 30), e(2, 20)];
    expect(applyChanges(list, [e(3, 25), e(2, 40)])).toEqual([e(2, 40), e(1, 30), e(3, 25)]);
  });

  it("ignores changes older than what the list has", () => {
    const list = [e(1, 30)];
    expect(applyChanges(list, [e(1, 10)])).toEqual([e(1, 30)]);
    expect(applyChanges(list, [gone(1, 10)])).toEqual([e(1, 30)]);
  });

  it("removes on a removal at least as new as the entry", () => {
    expect(applyChanges([e(1, 30), e(2, 20)], [gone(1, 30), gone(9, 5)])).toEqual([e(2, 20)]);
  });

  it("caps the list", () => {
    expect(ids(applyChanges([e(1), e(2)], [e(3)], 2))).toEqual([3, 2]);
  });
});

describe("recording local changes", () => {
  it("open() moves the tab to the front of history and queues it with the current time", () => {
    const s = setup({ history: [e(1, 5)] });
    s.lib.open(e(2, 1));
    expect(s.history.all).toEqual([e(2, NOW), e(1, 5)]);
    expect(s.lib.queue.list("history")).toEqual([e(2, NOW)]);
  });

  it("toggleFavorite() queues the entry when saved and a removal when unsaved", () => {
    const s = setup();
    expect(s.lib.toggleFavorite(e(3, 1))).toBe(true);
    expect(s.favorites.all).toEqual([e(3, NOW)]);
    expect(s.lib.queue.list("favorites")).toEqual([e(3, NOW)]);
    vi.setSystemTime(NOW + 1000);
    expect(s.lib.toggleFavorite(e(3, 1))).toBe(false);
    expect(s.favorites.all).toEqual([]);
    expect(s.lib.queue.list("favorites")).toEqual([gone(3, NOW + 1000)]);
  });

  it("clearHistory() queues a removal for every entry", () => {
    const s = setup({ history: [e(1), e(2)] });
    s.lib.clearHistory();
    expect(s.history.all).toEqual([]);
    expect(s.lib.queue.list("history")).toEqual([gone(1, NOW), gone(2, NOW)]);
  });

  it("keeps changes queued across restarts", () => {
    const s = setup();
    s.lib.open(e(1));
    const restarted = setup({ storage: s.storage });
    expect(restarted.lib.queue.list("history")).toEqual([e(1, NOW)]);
  });
});

describe("syncNow", () => {
  it("pushes queued changes, adopts the merged lists and clears what was sent", async () => {
    const s = setup();
    s.server.favorites = [e(7, 50)]; // saved on another device
    s.lib.open(e(1));
    expect(await s.lib.syncNow()).toBe(true);
    expect(s.api.syncLibrary).toHaveBeenCalledWith({ history: [e(1, NOW)] });
    expect(s.favorites.all).toEqual([e(7, 50)]);
    expect(s.history.all).toEqual([e(1, NOW)]);
    expect(s.lib.queue.size).toBe(0);
    expect(s.onChange).toHaveBeenCalledTimes(1);
    expect(s.lib.status).toEqual({ state: "synced", lastSyncAt: NOW, pending: 0 });
  });

  it("only reads the library when nothing is pending, and reports a change only if there is one", async () => {
    const s = setup({ history: [e(1)] });
    s.server.history = [e(1)];
    await s.lib.syncNow();
    expect(s.api.syncLibrary).not.toHaveBeenCalled();
    expect(s.api.library).toHaveBeenCalledTimes(1);
    expect(s.onChange).not.toHaveBeenCalled();
    s.server.history = [e(2), e(1)];
    await s.lib.syncNow();
    expect(ids(s.history.all)).toEqual([2, 1]);
    expect(s.onChange).toHaveBeenCalledTimes(1);
  });

  it("replaces local lists with the server's: removals from other devices apply", async () => {
    const s = setup({ favorites: [e(1), e(2)] });
    s.server.favorites = [e(2)];
    await s.lib.syncNow();
    expect(ids(s.favorites.all)).toEqual([2]);
  });

  it("first sync on a device pushes the full local lists, once", async () => {
    const s = setup({ seeded: false, history: [e(1, 10), e(2, 5)], favorites: [e(3, 7)] });
    await s.lib.syncNow();
    expect(s.api.syncLibrary).toHaveBeenCalledWith({ history: [e(1, 10), e(2, 5)], favorites: [e(3, 7)] });
    expect(s.storage.getItem(LIBRARY_SEEDED_KEY)).not.toBeNull();
    await s.lib.syncNow();
    expect(s.api.syncLibrary).toHaveBeenCalledTimes(1);
    expect(s.api.library).toHaveBeenCalledTimes(1);
  });

  it("resetSeed() pushes the full lists again (e.g. a new server)", async () => {
    const s = setup({ history: [e(1, 10)] });
    s.lib.resetSeed();
    await s.lib.syncNow();
    expect(s.api.syncLibrary).toHaveBeenCalledWith({ history: [e(1, 10)] });
  });

  it("splits more than MAX_CHANGES per list into several requests", async () => {
    const s = setup();
    for (let i = 1; i <= 1200; i++) s.lib.queue.add("history", e(i, i));
    for (let i = 1; i <= 3; i++) s.lib.queue.add("favorites", e(i, i));
    await s.lib.syncNow();
    const sizes = s.api.syncLibrary.mock.calls.map(([r]) => [r.history?.length ?? 0, r.favorites?.length ?? 0]);
    expect(sizes).toEqual([[500, 3], [500, 0], [200, 0]]);
    expect(s.lib.queue.size).toBe(0);
    expect(s.history.all).toHaveLength(HISTORY_LIMIT);
  });

  it("keeps the queue and the local lists when the server can't be reached, then retries", async () => {
    const s = setup({ history: [e(1)] });
    s.lib.open(e(2));
    s.api.syncLibrary.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await s.lib.syncNow()).toBe(false);
    expect(s.lib.queue.list("history")).toEqual([e(2, NOW)]);
    expect(ids(s.history.all)).toEqual([2, 1]);
    expect(s.lib.status).toEqual({ state: "offline", lastSyncAt: null, pending: 1 });
    expect(await s.lib.syncNow()).toBe(true);
    expect(s.lib.queue.size).toBe(0);
    expect(s.server.history).toEqual([e(2, NOW)]);
  });

  it("treats server errors and malformed replies as failures", async () => {
    const s = setup();
    s.lib.open(e(1));
    s.api.syncLibrary.mockRejectedValueOnce(new HttpError(503, "POST /v1/library/sync → 503"));
    expect(await s.lib.syncNow()).toBe(false);
    s.api.syncLibrary.mockResolvedValueOnce({ history: "nope" } as unknown as LibraryLists);
    expect(await s.lib.syncNow()).toBe(false);
    expect(s.lib.queue.size).toBe(1);
    expect(s.history.all).toEqual([e(1, NOW)]);
    const idle = setup();
    expect(await idle.lib.syncNow()).toBe(true);
    idle.api.library.mockRejectedValueOnce(new Error("down"));
    expect(await idle.lib.syncNow()).toBe(false);
    expect(idle.lib.status).toEqual({ state: "offline", lastSyncAt: NOW, pending: 0 });
  });

  it("drops a batch the server rejects as malformed (400), so it can't block the queue", async () => {
    const s = setup();
    s.lib.open(e(1));
    s.api.syncLibrary.mockRejectedValueOnce(new HttpError(400, "POST /v1/library/sync → 400"));
    expect(await s.lib.syncNow()).toBe(true);
    expect(s.lib.queue.size).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it("keeps changes made during a request, applies them over the reply, and sends them next", async () => {
    const s = setup();
    const reply = deferred<LibraryLists>();
    s.api.syncLibrary.mockReturnValueOnce(reply.promise);
    s.lib.open(e(1));
    const running = s.lib.syncNow();
    expect(s.lib.status.state).toBe("syncing");
    vi.setSystemTime(NOW + 10);
    s.lib.toggleFavorite(e(5));
    reply.resolve({ history: [e(1, NOW)], favorites: [] });
    expect(await running).toBe(true);
    expect(s.favorites.all).toEqual([e(5, NOW + 10)]);
    expect(s.api.syncLibrary).toHaveBeenCalledTimes(2);
    expect(s.api.syncLibrary).toHaveBeenLastCalledWith({ favorites: [e(5, NOW + 10)] });
    expect(s.lib.queue.size).toBe(0);
  });

  it("shares a running sync, and runs once more if asked during it", async () => {
    const s = setup();
    const reply = deferred<LibraryLists>();
    s.api.library.mockReturnValueOnce(reply.promise);
    const a = s.lib.syncNow();
    const b = s.lib.syncNow();
    expect(s.api.library).toHaveBeenCalledTimes(1);
    reply.resolve({ history: [], favorites: [] });
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(s.api.library).toHaveBeenCalledTimes(2);
  });

  it("does nothing when sync is off, but keeps recording for later", async () => {
    const s = setup();
    s.settings.enabled = false;
    s.lib.open(e(1));
    expect(await s.lib.syncNow()).toBe(false);
    expect(s.api.syncLibrary).not.toHaveBeenCalled();
    expect(s.api.library).not.toHaveBeenCalled();
    expect(s.lib.status.state).toBe("off");
    s.settings.enabled = true;
    await s.lib.syncNow();
    expect(s.server.history).toEqual([e(1, NOW)]);
  });

  it("reports status changes", async () => {
    const s = setup();
    await s.lib.syncNow();
    expect(s.onStatus.mock.calls.map(([st]) => st.state)).toEqual(["syncing", "synced"]);
  });
});

describe("scheduling", () => {
  it("start() syncs now and then every SYNC_EVERY_MS", async () => {
    const s = setup();
    await s.lib.start();
    expect(s.api.library).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SYNC_EVERY_MS * 2);
    expect(s.api.library).toHaveBeenCalledTimes(3);
  });

  it("syncs when the window regains focus", async () => {
    const s = setup();
    const win = new EventTarget();
    await s.lib.start(win);
    win.dispatchEvent(new Event("focus"));
    await flush();
    expect(s.api.library).toHaveBeenCalledTimes(2);
  });

  it("syncs shortly after local changes, once for a burst", async () => {
    const s = setup();
    s.lib.open(e(1));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS / 2);
    s.lib.toggleFavorite(e(2));
    s.lib.open(e(3));
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS - 1);
    expect(s.api.syncLibrary).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.api.syncLibrary).toHaveBeenCalledTimes(1);
    expect(ids(s.server.history)).toEqual([3, 1]);
    expect(ids(s.server.favorites)).toEqual([2]);
  });

  it("a failed sync is retried by the next periodic sync", async () => {
    const s = setup();
    s.api.library.mockRejectedValueOnce(new Error("offline"));
    await s.lib.start();
    expect(s.lib.status.state).toBe("offline");
    await vi.advanceTimersByTimeAsync(SYNC_EVERY_MS);
    expect(s.lib.status.state).toBe("synced");
  });
});

describe("syncHint", () => {
  const st = (state: "off" | "idle" | "syncing" | "synced" | "offline", lastSyncAt: number | null = null, pending = 0) => ({ state, lastSyncAt, pending });

  it("describes each state", () => {
    expect(syncHint(st("off"), NOW)).toBe("Sync off");
    expect(syncHint(st("idle"), NOW)).toBe("Not synced yet");
    expect(syncHint(st("syncing"), NOW)).toBe("Syncing…");
    expect(syncHint(st("synced", NOW - 10_000), NOW)).toBe("Synced just now");
    expect(syncHint(st("synced", NOW - 2 * 60_000), NOW)).toBe("Synced 2 min ago");
    expect(syncHint(st("synced", NOW - 3 * 3_600_000), NOW)).toBe("Synced 3 h ago");
    expect(syncHint(st("offline", null, 2), NOW)).toBe("Offline, will sync");
    expect(syncHint(st("offline", NOW - 60_000, 0), NOW)).toBe("Offline · synced 1 min ago");
    expect(syncHint(st("offline"), NOW)).toBe("Offline");
  });
});
