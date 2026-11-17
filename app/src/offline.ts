import { isConfidentMatch } from "./match";
import type { Track } from "./types";

/**
 * Pages saved for offline use: copies of Songsterr pages the user was viewing,
 * taken by the app shell (src-tauri/src/snapshot.rs) as images (PNG strips) or a
 * PDF, kept in the webview's IndexedDB. Each page keeps what identifies its song,
 * so the playing song's saved copy can be found while offline.
 *
 * Object stores (database "guitarfish-offline", version 1):
 * - `pages` { id, url, songId, title, artist, trackKey, savedAt, parts: [{ mime, size }] }
 *           key: id (auto), index url
 * - `parts` { id: "<page id>:<index>", data: Blob }
 * The images are kept apart so listing pages never loads them.
 */
export const OFFLINE_DB = "guitarfish-offline";
const DB_VERSION = 1;

export type PartMime = "image/png" | "application/pdf";

export interface SavedPage {
  id: number;
  url: string;
  /** Songsterr's song id (0 when unknown). */
  songId: number;
  title: string;
  artist: string;
  /** The playing track it was saved for (library.trackKey), if any. */
  trackKey: string | null;
  savedAt: number;
  parts: { mime: PartMime; size: number }[];
}

export type NewSavedPage = Omit<SavedPage, "id" | "savedAt" | "parts">;

export interface SnapshotPart {
  mime: PartMime;
  data: Uint8Array;
}

/**
 * The parts in `snapshot_webview`'s answer: "GFSN", a version byte, a part count
 * (u32 LE), then each part as kind (u8: 0 PNG, 1 PDF), length (u32 LE) and bytes.
 */
export function parseSnapshot(buf: ArrayBuffer | Uint8Array | number[]): SnapshotPart[] {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 9 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== "GFSN") throw new Error("Not a saved page");
  if (b[4] !== 1) throw new Error(`Unknown saved page version ${b[4]}`);
  const count = view.getUint32(5, true);
  const parts: SnapshotPart[] = [];
  let at = 9;
  for (let i = 0; i < count; i++) {
    if (at + 5 > b.length) throw new Error("The saved page is cut short");
    const kind = b[at];
    const len = view.getUint32(at + 1, true);
    at += 5;
    if (at + len > b.length) throw new Error("The saved page is cut short");
    if (kind !== 0 && kind !== 1) throw new Error(`Unknown part kind ${kind}`);
    parts.push({ mime: kind === 0 ? "image/png" : "application/pdf", data: b.slice(at, at + len) });
    at += len;
  }
  return parts;
}

/**
 * The saved page for a playing track: the one saved for that very track, else
 * one whose title and artist match it (as Songsterr's search would decide).
 */
export function findForTrack<P extends Pick<SavedPage, "trackKey" | "title" | "artist" | "songId" | "savedAt">>(
  pages: readonly P[],
  track: Pick<Track, "title" | "artist">,
  trackKey: string,
): P | null {
  const newest = (list: P[]) => list.sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
  return (
    newest(pages.filter((p) => p.trackKey === trackKey)) ??
    newest(pages.filter((p) => isConfidentMatch(track, { title: p.title, artist: p.artist, songId: p.songId || 1 })))
  );
}

/** "12.3 MB" */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

const partKey = (pageId: number, i: number) => `${pageId}:${i}`;

export class OfflineStore {
  private constructor(private db: IDBDatabase) {}

  static open(factory: IDBFactory = indexedDB, name = OFFLINE_DB): Promise<OfflineStore> {
    return new Promise((resolve, reject) => {
      const r = factory.open(name, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("pages", { keyPath: "id", autoIncrement: true }).createIndex("url", "url");
        db.createObjectStore("parts", { keyPath: "id" });
      };
      r.onsuccess = () => resolve(new OfflineStore(r.result));
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error("The saved pages are open in an older version of Guitarfish"));
    });
  }

  close(): void {
    this.db.close();
  }

  /** Every saved page, newest first. */
  async pages(): Promise<SavedPage[]> {
    const tx = this.db.transaction("pages");
    const all = await req<SavedPage[]>(tx.objectStore("pages").getAll());
    return all.sort((a, b) => b.savedAt - a.savedAt);
  }

  async page(id: number): Promise<SavedPage | null> {
    return (await req<SavedPage | undefined>(this.db.transaction("pages").objectStore("pages").get(id))) ?? null;
  }

  /**
   * Saves a page. Saving the same URL again replaces the earlier copy (the page
   * may have changed), so each Songsterr page is kept once.
   */
  async save(meta: NewSavedPage, parts: SnapshotPart[], now = Date.now()): Promise<SavedPage> {
    if (!parts.length) throw new Error("Nothing to save");
    const tx = this.db.transaction(["pages", "parts"], "readwrite");
    const done = committed(tx);
    const pages = tx.objectStore("pages");
    const blobs = tx.objectStore("parts");
    for (const old of await req<SavedPage[]>(pages.index("url").getAll(meta.url))) {
      for (let i = 0; i < old.parts.length; i++) await req(blobs.delete(partKey(old.id, i)));
      await req(pages.delete(old.id));
    }
    const record = { ...meta, savedAt: now, parts: parts.map((p) => ({ mime: p.mime, size: p.data.byteLength })) };
    const id = Number(await req(pages.add(record)));
    for (const [i, p] of parts.entries()) {
      await req(blobs.put({ id: partKey(id, i), data: new Blob([p.data as Uint8Array<ArrayBuffer>], { type: p.mime }) }));
    }
    await done;
    return { ...record, id };
  }

  /** A page's images (or PDF), in order. */
  async parts(page: Pick<SavedPage, "id" | "parts">): Promise<Blob[]> {
    const store = this.db.transaction("parts").objectStore("parts");
    const out: Blob[] = [];
    for (let i = 0; i < page.parts.length; i++) {
      const rec = await req<{ data: Blob } | undefined>(store.get(partKey(page.id, i)));
      if (!rec) throw new Error("Part of the saved page is missing");
      out.push(rec.data);
    }
    return out;
  }

  async remove(id: number): Promise<void> {
    const tx = this.db.transaction(["pages", "parts"], "readwrite");
    const done = committed(tx);
    const page = await req<SavedPage | undefined>(tx.objectStore("pages").get(id));
    if (page) {
      for (let i = 0; i < page.parts.length; i++) await req(tx.objectStore("parts").delete(partKey(id, i)));
      await req(tx.objectStore("pages").delete(id));
    }
    await done;
  }
}
