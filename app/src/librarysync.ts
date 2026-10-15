import { HttpError, type TabApi } from "./api";
import { type Change, type EntryStore, HISTORY_LIMIT, isEntry, type LibraryLists, pushHistory, type Removal, type TabEntry } from "./library";

/**
 * Changes not yet accepted by the server, per list. Kept across restarts, so what is
 * done offline syncs later.
 */
export const LIBRARY_QUEUE_KEY = "tabsync.library.pending";
/** Set once this device has pushed its full lists to the server. */
export const LIBRARY_SEEDED_KEY = "tabsync.library.seeded";
/** The server's limit of changes per list in one request. */
export const MAX_CHANGES = 500;
export const SYNC_EVERY_MS = 60_000;
/** Wait after a local change, so a burst of changes goes in one request. */
export const SYNC_DEBOUNCE_MS = 2_000;

export type ListName = "history" | "favorites";
const LISTS: ListName[] = ["history", "favorites"];

type SyncStorage = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

export function isRemoval(c: Change): c is Removal {
  return "deletedAt" in c;
}

function isChange(v: unknown): v is Change {
  if (isEntry(v)) return true;
  const r = v as Removal;
  return !!r && typeof r.songId === "number" && typeof r.deletedAt === "number";
}

/** When a change happened. */
export function stampOf(c: Change): number {
  return isRemoval(c) ? c.deletedAt : c.at;
}

/** Last writer wins, a removal on a tie (the server's rule). */
function supersedes(next: Change, prev: Change): boolean {
  const a = stampOf(next);
  const b = stampOf(prev);
  return a > b || (a === b && isRemoval(next) && !isRemoval(prev));
}

const sameChange = (a: Change, b: Change) => a.songId === b.songId && stampOf(a) === stampOf(b) && isRemoval(a) === isRemoval(b);

/** Pending changes in localStorage, one per song and list (the newest). */
export class ChangeQueue {
  private lists: Record<ListName, Change[]>;

  constructor(
    private storage: SyncStorage = localStorage,
    private key = LIBRARY_QUEUE_KEY,
  ) {
    this.lists = { history: [], favorites: [] };
    try {
      const raw = JSON.parse(this.storage.getItem(this.key) ?? "{}");
      for (const l of LISTS) {
        const items = raw?.[l];
        if (Array.isArray(items)) this.lists[l] = items.filter(isChange);
      }
    } catch {
      /* corrupt or unavailable: start empty */
    }
  }

  list(name: ListName): readonly Change[] {
    return this.lists[name];
  }

  get size(): number {
    return this.lists.history.length + this.lists.favorites.length;
  }

  add(name: ListName, c: Change): void {
    const items = this.lists[name];
    const i = items.findIndex((x) => x.songId === c.songId);
    if (i === -1) items.push(c);
    else if (supersedes(c, items[i])) items[i] = c;
    else return;
    this.save();
  }

  /** Drops changes the server accepted. A newer change for the same song stays. */
  remove(name: ListName, sent: readonly Change[]): void {
    this.lists[name] = this.lists[name].filter((c) => !sent.some((s) => sameChange(s, c)));
    this.save();
  }

  private save(): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.lists));
    } catch {
      /* storage unavailable: queued for this session only */
    }
  }
}

export function chunk<T>(items: readonly T[], size = MAX_CHANGES): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Applies changes to a list the way the server merges them: newest first, capped. */
export function applyChanges(list: readonly TabEntry[], changes: readonly Change[], limit = Infinity): TabEntry[] {
  const bySong = new Map(list.map((e) => [e.songId, e] as const));
  for (const c of changes) {
    const prev = bySong.get(c.songId);
    if (prev && !supersedes(c, prev)) continue;
    if (isRemoval(c)) bySong.delete(c.songId);
    else bySong.set(c.songId, c);
  }
  return [...bySong.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}

export interface LibrarySyncStatus {
  /** idle: not synced yet this session. off: turned off in settings. */
  state: "off" | "idle" | "syncing" | "synced" | "offline";
  lastSyncAt: number | null;
  pending: number;
}

type ListStore = Pick<EntryStore, "all" | "update">;

export interface LibrarySyncDeps {
  api: Pick<TabApi, "library" | "syncLibrary">;
  history: ListStore;
  favorites: ListStore;
  /** Read on every sync, so the setting applies immediately. */
  enabled: () => boolean;
  storage?: SyncStorage;
  /** Clock for change timestamps. Default: Date.now. */
  now?: () => number;
  /** The lists changed from a sync: re-render what shows them. */
  onChange?: () => void;
  onStatus?: (s: LibrarySyncStatus) => void;
}

/**
 * Keeps History and Favorites in step with the tab server. Local changes update the
 * localStorage lists at once (the offline cache) and are queued; a sync pushes the
 * queue, then adopts the server's merged lists, re-applying anything changed while
 * the request was in flight.
 */
export class LibrarySync {
  readonly queue: ChangeQueue;
  private storage: SyncStorage;
  private now: () => number;
  private _status: LibrarySyncStatus;
  private running: Promise<boolean> | null = null;
  private again = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: LibrarySyncDeps) {
    this.storage = deps.storage ?? localStorage;
    this.now = deps.now ?? Date.now;
    this.queue = new ChangeQueue(this.storage);
    this._status = { state: "idle", lastSyncAt: null, pending: this.queue.size };
  }

  get status(): LibrarySyncStatus {
    return this._status;
  }

  // ---- Local changes ----

  /** A tab was opened: to the front of history. */
  open(entry: TabEntry): void {
    const e = { ...entry, at: this.now() };
    this.deps.history.update((l) => pushHistory(l, e));
    this.record("history", e);
  }

  /** Saves or unsaves a tab; returns whether it is now a favorite. */
  toggleFavorite(entry: TabEntry): boolean {
    const at = this.now();
    const saved = this.deps.favorites.all.some((x) => x.songId === entry.songId);
    if (saved) {
      this.deps.favorites.update((l) => l.filter((x) => x.songId !== entry.songId));
      this.record("favorites", { songId: entry.songId, deletedAt: at });
    } else {
      const e = { ...entry, at };
      this.deps.favorites.update((l) => [e, ...l]);
      this.record("favorites", e);
    }
    return !saved;
  }

  clearHistory(): void {
    const at = this.now();
    for (const e of this.deps.history.all) this.queue.add("history", { songId: e.songId, deletedAt: at });
    this.deps.history.update(() => []);
    this.scheduleSoon();
  }

  private record(name: ListName, c: Change): void {
    this.queue.add(name, c);
    this.scheduleSoon();
  }

  private scheduleSoon(): void {
    this.setStatus({ pending: this.queue.size });
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.syncNow();
    }, SYNC_DEBOUNCE_MS);
  }

  // ---- Syncing ----

  /** Syncs now, then every SYNC_EVERY_MS and whenever `focusTarget` regains focus. */
  async start(focusTarget?: Pick<EventTarget, "addEventListener">): Promise<void> {
    focusTarget?.addEventListener("focus", () => void this.syncNow());
    setInterval(() => void this.syncNow(), SYNC_EVERY_MS);
    await this.syncNow();
  }

  /** The next sync pushes the full local lists again (e.g. after a server change). */
  resetSeed(): void {
    try {
      this.storage.removeItem?.(LIBRARY_SEEDED_KEY);
    } catch {
      /* ignore */
    }
  }

  /**
   * Pushes pending changes (or just reads the library) and adopts the result. A call
   * during a sync shares it and makes it run once more. Resolves to whether it worked.
   */
  syncNow(): Promise<boolean> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let ok: boolean;
      do {
        this.again = false;
        ok = await this.run();
      } while (ok && this.again);
      return ok;
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async run(): Promise<boolean> {
    if (!this.deps.enabled()) {
      this.setStatus({ state: "off" });
      return false;
    }
    this.setStatus({ state: "syncing" });
    this.seedOnce();
    let changed = false;
    try {
      let sent = false;
      // Changes made while a request is out are sent by the next round.
      while (this.queue.size > 0) {
        const batch = {
          history: this.queue.list("history").slice(0, MAX_CHANGES),
          favorites: this.queue.list("favorites").slice(0, MAX_CHANGES),
        };
        const body: { history?: Change[]; favorites?: Change[] } = {};
        if (batch.history.length) body.history = batch.history;
        if (batch.favorites.length) body.favorites = batch.favorites;
        let lists: LibraryLists | null = null;
        try {
          lists = await this.deps.api.syncLibrary(body);
        } catch (e) {
          // Malformed input will never be accepted: drop it rather than block the queue.
          if (!(e instanceof HttpError && e.status === 400)) throw e;
          console.warn("library sync: server rejected changes, dropping them", e);
        }
        if (lists) parseLists(lists);
        this.queue.remove("history", batch.history);
        this.queue.remove("favorites", batch.favorites);
        if (lists) changed = this.adopt(lists) || changed;
        sent = true;
      }
      if (!sent) changed = this.adopt(parseLists(await this.deps.api.library())) || changed;
      this.setStatus({ state: "synced", lastSyncAt: this.now() });
      return true;
    } catch (e) {
      console.warn("library sync failed", e);
      this.setStatus({ state: "offline" });
      return false;
    } finally {
      if (changed) this.deps.onChange?.();
    }
  }

  /** The first sync on a device (or server) pushes everything it has. Safe to repeat. */
  private seedOnce(): void {
    try {
      if (this.storage.getItem(LIBRARY_SEEDED_KEY)) return;
    } catch {
      return;
    }
    for (const e of this.deps.history.all) this.queue.add("history", e);
    for (const e of this.deps.favorites.all) this.queue.add("favorites", e);
    try {
      this.storage.setItem(LIBRARY_SEEDED_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  /** Replaces the local lists with the server's, plus what is still pending. */
  private adopt(lists: LibraryLists): boolean {
    let changed = false;
    for (const [name, store, limit] of [
      ["history", this.deps.history, HISTORY_LIMIT],
      ["favorites", this.deps.favorites, Infinity],
    ] as const) {
      const next = applyChanges(lists[name], this.queue.list(name), limit);
      if (JSON.stringify(next) !== JSON.stringify(store.all)) {
        store.update(() => next);
        changed = true;
      }
    }
    return changed;
  }

  private setStatus(patch: Partial<LibrarySyncStatus>): void {
    this._status = { ...this._status, pending: this.queue.size, ...patch };
    this.deps.onStatus?.(this._status);
  }
}

function parseLists(raw: unknown): LibraryLists {
  const r = raw as Partial<LibraryLists> | null;
  if (!r || !Array.isArray(r.history) || !Array.isArray(r.favorites)) throw new Error("malformed library reply");
  return { history: r.history.filter(isEntry), favorites: r.favorites.filter(isEntry) };
}

function ago(at: number, now: number): string {
  const m = Math.round((now - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Short status line for the Tools sidebar. */
export function syncHint(s: LibrarySyncStatus, now = Date.now()): string {
  switch (s.state) {
    case "off":
      return "Sync off";
    case "idle":
      return "Not synced yet";
    case "syncing":
      return "Syncing…";
    case "synced":
      return `Synced ${ago(s.lastSyncAt ?? now, now)}`;
    case "offline":
      if (s.pending > 0) return "Offline, will sync";
      return s.lastSyncAt === null ? "Offline" : `Offline · synced ${ago(s.lastSyncAt, now)}`;
  }
}
