import { normalizeArtist, normalizeTitle } from "./normalize";
import type { Song, TabFormat, TabInfo } from "./types";

/**
 * The local tab catalogue: songs, their imported tab files and the Spotify tracks
 * the user confirmed for them, in the webview's IndexedDB. Everything stays on
 * the device.
 *
 * Object stores (database "guitarfish", version 1):
 * - `songs`  { id, title, artist, durationMs, addedAt }            key: id (auto)
 * - `tabs`   { id, songId, format, name, addedAt }                 key: id (auto), index songId
 * - `files`  { id, data: ArrayBuffer }                             key: id (= the tab's id)
 * - `links`  { provider: "spotify", externalId, songId }           key: [provider, externalId], index songId
 *
 * Files are kept apart from the tab metadata so listing songs never loads them.
 */
export const DB_NAME = "guitarfish";
const DB_VERSION = 1;

interface SongRecord {
  id: number;
  title: string;
  artist: string;
  durationMs: number | null;
  addedAt: number;
}

interface TabRecord {
  id: number;
  songId: number;
  format: TabFormat;
  name: string;
  addedAt: number;
}

interface FileRecord {
  id: number;
  data: ArrayBuffer;
}

/** A tab file to add, and the song it belongs to. */
export interface NewTab {
  title: string;
  artist: string;
  durationMs?: number | null;
  format: TabFormat;
  name: string;
  data: ArrayBuffer;
}

type StoreName = "songs" | "tabs" | "files" | "links";

/** Resolves with the request's result once it succeeds. */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Resolves once the transaction has committed. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

const toInfo = (t: TabRecord): TabInfo => ({ id: t.id, format: t.format, name: t.name });

const toSong = (s: SongRecord, tabs: TabRecord[]): Song => ({
  id: s.id,
  title: s.title,
  artist: s.artist,
  durationMs: s.durationMs,
  tabs: tabs.filter((t) => t.songId === s.id).sort((a, b) => a.id - b.id).map(toInfo),
});

const byArtistThenTitle = (a: Song, b: Song) =>
  a.artist.localeCompare(b.artist, undefined, { sensitivity: "base" }) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

export class Catalogue {
  private constructor(private db: IDBDatabase) {}

  /** Opens (and on first use creates) the catalogue database. */
  static open(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<Catalogue> {
    return new Promise((resolve, reject) => {
      const r = factory.open(name, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("songs", { keyPath: "id", autoIncrement: true });
        db.createObjectStore("tabs", { keyPath: "id", autoIncrement: true }).createIndex("songId", "songId");
        db.createObjectStore("files", { keyPath: "id" });
        db.createObjectStore("links", { keyPath: ["provider", "externalId"] }).createIndex("songId", "songId");
      };
      r.onsuccess = () => resolve(new Catalogue(r.result));
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error("The tab catalogue is open in an older version of Guitarfish"));
    });
  }

  close(): void {
    this.db.close();
  }

  private tx(stores: StoreName[], mode: IDBTransactionMode = "readonly") {
    const tx = this.db.transaction(stores, mode);
    return { tx, store: (n: StoreName) => tx.objectStore(n) };
  }

  /** Every song with its tabs, by artist then title. */
  async songs(): Promise<Song[]> {
    const { store } = this.tx(["songs", "tabs"]);
    const [songs, tabs] = await Promise.all([req<SongRecord[]>(store("songs").getAll()), req<TabRecord[]>(store("tabs").getAll())]);
    return songs.map((s) => toSong(s, tabs)).sort(byArtistThenTitle);
  }

  async song(id: number): Promise<Song | null> {
    const { store } = this.tx(["songs", "tabs"]);
    const [s, tabs] = await Promise.all([req<SongRecord | undefined>(store("songs").get(id)), req<TabRecord[]>(store("tabs").index("songId").getAll(id))]);
    return s ? toSong(s, tabs) : null;
  }

  /**
   * Adds a tab file. It goes to the song with the same normalized title and artist
   * when there is one, otherwise to a new song.
   */
  async addTab(t: NewTab): Promise<{ song: Song; tab: TabInfo }> {
    const { tx, store } = this.tx(["songs", "tabs", "files"], "readwrite");
    const done = committed(tx);
    const titleNorm = normalizeTitle(t.title);
    const artistNorm = normalizeArtist(t.artist);
    const now = Date.now();
    const existing = (await req<SongRecord[]>(store("songs").getAll())).find(
      (s) => normalizeTitle(s.title) === titleNorm && normalizeArtist(s.artist) === artistNorm,
    );
    const songId =
      existing?.id ??
      Number(await req(store("songs").add({ title: t.title, artist: t.artist, durationMs: t.durationMs ?? null, addedAt: now } as Omit<SongRecord, "id">)));
    const tabId = Number(await req(store("tabs").add({ songId, format: t.format, name: t.name, addedAt: now } as Omit<TabRecord, "id">)));
    await req(store("files").put({ id: tabId, data: t.data } satisfies FileRecord));
    await done;
    const song = await this.song(songId);
    return { song: song!, tab: song!.tabs.find((x) => x.id === tabId)! };
  }

  /** A tab's file and format. */
  async tab(id: number): Promise<{ format: TabFormat; data: ArrayBuffer }> {
    const { store } = this.tx(["tabs", "files"]);
    const [t, f] = await Promise.all([req<TabRecord | undefined>(store("tabs").get(id)), req<FileRecord | undefined>(store("files").get(id))]);
    if (!t || !f) throw new Error(`Tab ${id} is not in the catalogue`);
    return { format: t.format, data: f.data };
  }

  /** Deletes a tab; a song left without tabs goes too, with its confirmed tracks. */
  async deleteTab(id: number): Promise<void> {
    const { tx, store } = this.tx(["songs", "tabs", "files", "links"], "readwrite");
    const done = committed(tx);
    const t = await req<TabRecord | undefined>(store("tabs").get(id));
    if (t) {
      await req(store("tabs").delete(id));
      await req(store("files").delete(id));
      const left = await req(store("tabs").index("songId").count(t.songId));
      if (left === 0) {
        await req(store("songs").delete(t.songId));
        const links = await req(store("links").index("songId").getAllKeys(t.songId));
        for (const k of links) await req(store("links").delete(k));
      }
    }
    await done;
  }
}
