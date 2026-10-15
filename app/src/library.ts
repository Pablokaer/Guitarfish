import type { SongsterrResult } from "./types";

/** A Songsterr tab the user opened or saved. Only metadata and the link are kept. */
export interface TabEntry {
  url: string;
  songId: number;
  title: string;
  artist: string;
  /** Epoch ms of the last time it was opened (history) or saved (favorites). */
  at: number;
}

/** A tab removed from a list (unsaved, or history cleared), as synced to the server. */
export interface Removal {
  songId: number;
  /** Epoch ms of the removal. */
  deletedAt: number;
}

/** One change to a synced list: an entry added or bumped, or a removal. */
export type Change = TabEntry | Removal;

/** History and favorites as the server returns them, newest first. */
export interface LibraryLists {
  history: TabEntry[];
  favorites: TabEntry[];
}

export const HISTORY_LIMIT = 50;

/** Search pages ("search “…”") have no songId and are not worth remembering. */
export function isSongPage(r: Pick<SongsterrResult, "songId">): boolean {
  return r.songId > 0;
}

export function toEntry(r: SongsterrResult, at = Date.now()): TabEntry {
  return { url: r.url, songId: r.songId, title: r.title, artist: r.artist, at };
}

export function toResult(e: TabEntry): SongsterrResult {
  return { songId: e.songId, title: e.title, artist: e.artist, instruments: [], url: e.url };
}

/** Moves (or adds) `entry` to the front, one entry per song. */
export function pushHistory(list: TabEntry[], entry: TabEntry, limit = HISTORY_LIMIT): TabEntry[] {
  return [entry, ...list.filter((e) => e.songId !== entry.songId)].slice(0, limit);
}

export function toggleFavorite(list: TabEntry[], entry: TabEntry): TabEntry[] {
  return list.some((e) => e.songId === entry.songId)
    ? list.filter((e) => e.songId !== entry.songId)
    : [entry, ...list];
}

export function isEntry(v: unknown): v is TabEntry {
  const e = v as TabEntry;
  return !!e && typeof e.url === "string" && typeof e.songId === "number" && typeof e.title === "string" && typeof e.artist === "string" && typeof e.at === "number";
}

/** A list of tab entries kept in localStorage. */
export class EntryStore {
  private items: TabEntry[];

  constructor(
    private key: string,
    private storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  ) {
    this.items = this.read();
  }

  private read(): TabEntry[] {
    try {
      const raw = JSON.parse(this.storage.getItem(this.key) ?? "[]");
      return Array.isArray(raw) ? raw.filter(isEntry) : [];
    } catch {
      return [];
    }
  }

  get all(): readonly TabEntry[] {
    return this.items;
  }

  has(songId: number): boolean {
    return this.items.some((e) => e.songId === songId);
  }

  update(fn: (items: TabEntry[]) => TabEntry[]): void {
    this.items = fn(this.items);
    try {
      this.storage.setItem(this.key, JSON.stringify(this.items));
    } catch {
      /* storage unavailable: kept for this session only */
    }
  }
}

/**
 * Songsterr pages the user chose for specific tracks ("Wrong tab?" → pick), keyed
 * by trackKey. Checked before searching, so a correction sticks.
 */
export class PickStore {
  private picks: Record<string, SongsterrResult>;

  constructor(
    private key = "tabsync.songsterr.picks",
    private storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  ) {
    try {
      const raw = JSON.parse(this.storage.getItem(this.key) ?? "{}");
      this.picks = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      this.picks = {};
    }
  }

  get(trackKey: string): SongsterrResult | null {
    const p = this.picks[trackKey];
    return p && typeof p.url === "string" && typeof p.songId === "number" ? p : null;
  }

  set(trackKey: string, r: SongsterrResult | null): void {
    if (r) this.picks[trackKey] = r;
    else delete this.picks[trackKey];
    try {
      this.storage.setItem(this.key, JSON.stringify(this.picks));
    } catch {
      /* kept for this session only */
    }
  }
}
