import { move } from "./queue";

/**
 * The local music library: MP3 tracks, their cover art and the user's playlists, in
 * the webview's IndexedDB (a database of its own, apart from the tab catalogue).
 *
 * A track is either a file on disk, referenced by its path (desktop: the file stays
 * where it is and is never copied or changed), or a copy kept here (Android and the
 * browser, which can't reopen a path after a restart).
 *
 * Object stores (database "guitarfish-music", version 1):
 * - `tracks`    { id, title, artist, album, durationMs, fileName, size, fingerprint,
 *                 path, artId, addedAt }                    key: id (auto), indexes fingerprint, path, artId
 * - `blobs`     { id, data: Blob }                          key: id (= the track's id)
 * - `art`       { id, data: Blob }                          key: id (content hash, shared by an album's tracks)
 * - `playlists` { id, name, trackIds, createdAt }           key: id (auto)
 *
 * Audio and art are kept apart from the track records, so listing the library never
 * loads them; a Blob read from IndexedDB is backed by disk, not memory.
 */
export const MUSIC_DB = "guitarfish-music";
const DB_VERSION = 1;

export interface LocalTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  /** The imported file's name. */
  fileName: string;
  size: number;
  /** Content hash of the file's start and its size: the same file imported twice has the same one. */
  fingerprint: string;
  /** The file on disk (desktop), or null when the audio is kept in the library (`blobs`). */
  path: string | null;
  artId: string | null;
  addedAt: number;
}

export type NewLocalTrack = Omit<LocalTrack, "id" | "addedAt" | "artId">;

export interface Playlist {
  id: number;
  name: string;
  trackIds: number[];
  createdAt: number;
}

interface BlobRecord {
  id: number | string;
  data: Blob;
}

type StoreName = "tracks" | "blobs" | "art" | "playlists";

export const MAX_PLAYLIST_NAME = 80;

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

/** A playlist name as stored: trimmed, single-spaced and capped; null when blank. */
export function cleanPlaylistName(name: string): string | null {
  const n = name.replace(/\s+/g, " ").trim().slice(0, MAX_PLAYLIST_NAME);
  return n || null;
}

export class MusicLibrary {
  private constructor(private db: IDBDatabase) {}

  static open(factory: IDBFactory = indexedDB, name = MUSIC_DB): Promise<MusicLibrary> {
    return new Promise((resolve, reject) => {
      const r = factory.open(name, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        const tracks = db.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
        tracks.createIndex("fingerprint", "fingerprint");
        tracks.createIndex("path", "path");
        tracks.createIndex("artId", "artId");
        db.createObjectStore("blobs", { keyPath: "id" });
        db.createObjectStore("art", { keyPath: "id" });
        db.createObjectStore("playlists", { keyPath: "id", autoIncrement: true });
      };
      r.onsuccess = () => resolve(new MusicLibrary(r.result));
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error("The music library is open in an older version of Guitarfish"));
    });
  }

  close(): void {
    this.db.close();
  }

  private tx(stores: StoreName[], mode: IDBTransactionMode = "readonly") {
    const tx = this.db.transaction(stores, mode);
    return { tx, store: (n: StoreName) => tx.objectStore(n) };
  }

  /** Every track, oldest first. */
  async tracks(): Promise<LocalTrack[]> {
    const { store } = this.tx(["tracks"]);
    return req<LocalTrack[]>(store("tracks").getAll());
  }

  async track(id: number): Promise<LocalTrack | null> {
    const { store } = this.tx(["tracks"]);
    return (await req<LocalTrack | undefined>(store("tracks").get(id))) ?? null;
  }

  /** The track already in the library for this file (same path, or same content), if any. */
  async findDuplicate(fingerprint: string, path: string | null): Promise<LocalTrack | null> {
    const { store } = this.tx(["tracks"]);
    const s = store("tracks");
    if (path) {
      const byPath = await req<LocalTrack | undefined>(s.index("path").get(path));
      if (byPath) return byPath;
    }
    return (await req<LocalTrack | undefined>(s.index("fingerprint").get(fingerprint))) ?? null;
  }

  /**
   * Adds a track, with its audio when it is kept here (`blob`) and its cover art
   * (stored once per distinct image, under `art.id`). A file already in the library
   * is not added again: the existing track comes back with `duplicate`.
   */
  async addTrack(t: NewLocalTrack, extra: { blob?: Blob; art?: { id: string; data: Blob } | null } = {}): Promise<{ track: LocalTrack; duplicate: boolean }> {
    const existing = await this.findDuplicate(t.fingerprint, t.path);
    if (existing) return { track: existing, duplicate: true };
    const { tx, store } = this.tx(["tracks", "blobs", "art"], "readwrite");
    const done = committed(tx);
    const art = extra.art ?? null;
    if (art && !(await req(store("art").count(art.id)))) await req(store("art").put({ id: art.id, data: art.data } satisfies BlobRecord));
    const record = { ...t, artId: art?.id ?? null, addedAt: Date.now() };
    const id = Number(await req(store("tracks").add(record)));
    if (extra.blob) await req(store("blobs").put({ id, data: extra.blob } satisfies BlobRecord));
    await done;
    return { track: { ...record, id }, duplicate: false };
  }

  /** A track's file moved: point the track at its new path. */
  async relocateTrack(id: number, path: string, fileName: string): Promise<LocalTrack | null> {
    const { tx, store } = this.tx(["tracks"], "readwrite");
    const done = committed(tx);
    const t = await req<LocalTrack | undefined>(store("tracks").get(id));
    let updated: LocalTrack | null = null;
    if (t) {
      updated = { ...t, path, fileName };
      await req(store("tracks").put(updated));
    }
    await done;
    return updated;
  }

  /** Changes a track's details (e.g. title and artist, for a better tab search). */
  async updateTrack(id: number, patch: Partial<Pick<LocalTrack, "title" | "artist" | "album" | "durationMs">>): Promise<LocalTrack | null> {
    const { tx, store } = this.tx(["tracks"], "readwrite");
    const done = committed(tx);
    const t = await req<LocalTrack | undefined>(store("tracks").get(id));
    let updated: LocalTrack | null = null;
    if (t) {
      updated = { ...t, ...patch };
      await req(store("tracks").put(updated));
    }
    await done;
    return updated;
  }

  /**
   * Removes a track from the library and from every playlist. A file on disk is
   * left alone; a copy kept here is deleted, and so is art no other track uses.
   */
  async removeTrack(id: number): Promise<void> {
    const { tx, store } = this.tx(["tracks", "blobs", "art", "playlists"], "readwrite");
    const done = committed(tx);
    const t = await req<LocalTrack | undefined>(store("tracks").get(id));
    if (t) {
      await req(store("tracks").delete(id));
      await req(store("blobs").delete(id));
      if (t.artId) {
        if (!(await req(store("tracks").index("artId").count(t.artId)))) await req(store("art").delete(t.artId));
      }
      for (const p of await req<Playlist[]>(store("playlists").getAll())) {
        if (p.trackIds.includes(id)) await req(store("playlists").put({ ...p, trackIds: p.trackIds.filter((x) => x !== id) }));
      }
    }
    await done;
  }

  /** The audio of a track kept in the library (null for files on disk). */
  async blob(id: number): Promise<Blob | null> {
    const { store } = this.tx(["blobs"]);
    return (await req<BlobRecord | undefined>(store("blobs").get(id)))?.data ?? null;
  }

  async art(id: string): Promise<Blob | null> {
    const { store } = this.tx(["art"]);
    return (await req<BlobRecord | undefined>(store("art").get(id)))?.data ?? null;
  }

  // ---- Playlists ------------------------------------------------------------------
  /** Every playlist, in the order they were created. */
  async playlists(): Promise<Playlist[]> {
    const { store } = this.tx(["playlists"]);
    return req<Playlist[]>(store("playlists").getAll());
  }

  async playlist(id: number): Promise<Playlist | null> {
    const { store } = this.tx(["playlists"]);
    return (await req<Playlist | undefined>(store("playlists").get(id))) ?? null;
  }

  async createPlaylist(name: string, trackIds: number[] = []): Promise<Playlist> {
    const clean = cleanPlaylistName(name);
    if (!clean) throw new Error("A playlist needs a name");
    const { tx, store } = this.tx(["playlists"], "readwrite");
    const done = committed(tx);
    const record = { name: clean, trackIds: [...new Set(trackIds)], createdAt: Date.now() };
    const id = Number(await req(store("playlists").add(record)));
    await done;
    return { ...record, id };
  }

  /** Applies `fn` to a playlist in one transaction; returns the result (null if it doesn't exist). */
  private async editPlaylist(id: number, fn: (p: Playlist) => Playlist): Promise<Playlist | null> {
    const { tx, store } = this.tx(["playlists"], "readwrite");
    const done = committed(tx);
    const p = await req<Playlist | undefined>(store("playlists").get(id));
    let out: Playlist | null = null;
    if (p) {
      out = fn(p);
      await req(store("playlists").put(out));
    }
    await done;
    return out;
  }

  async renamePlaylist(id: number, name: string): Promise<Playlist | null> {
    const clean = cleanPlaylistName(name);
    if (!clean) throw new Error("A playlist needs a name");
    return this.editPlaylist(id, (p) => ({ ...p, name: clean }));
  }

  async deletePlaylist(id: number): Promise<void> {
    const { tx, store } = this.tx(["playlists"], "readwrite");
    await req(store("playlists").delete(id));
    await committed(tx);
  }

  /** Appends tracks; those already in the playlist are skipped (a playlist holds each song once). */
  async addToPlaylist(id: number, trackIds: number[]): Promise<{ playlist: Playlist | null; added: number; skipped: number }> {
    let added = 0;
    let skipped = 0;
    const playlist = await this.editPlaylist(id, (p) => {
      const ids = [...p.trackIds];
      for (const t of trackIds) {
        if (ids.includes(t)) skipped++;
        else {
          ids.push(t);
          added++;
        }
      }
      return { ...p, trackIds: ids };
    });
    return { playlist, added, skipped };
  }

  async removeFromPlaylist(id: number, trackId: number): Promise<Playlist | null> {
    return this.editPlaylist(id, (p) => ({ ...p, trackIds: p.trackIds.filter((t) => t !== trackId) }));
  }

  /** Moves the song at `from` to `to` in the playlist. */
  async reorderPlaylist(id: number, from: number, to: number): Promise<Playlist | null> {
    return this.editPlaylist(id, (p) => ({ ...p, trackIds: move(p.trackIds, from, to) }));
  }
}
