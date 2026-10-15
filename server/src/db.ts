import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { LISTS, isTombstone, liveEntries, mergeList, type Change, type ListName, type TabEntry } from "./library.js";
import { normalizeArtist, normalizeTitle } from "./normalize.js";

export type TabFormat = "alphatex" | "gp" | "musicxml";

export interface SongRow {
  id: number;
  title: string;
  artist: string;
  title_norm: string;
  artist_norm: string;
  duration_ms: number | null;
  isrc: string | null;
}

export interface TabRow {
  id: number;
  song_id: number;
  instrument: string;
  tuning: string | null;
  format: TabFormat;
  content: Buffer;
  version: number;
  rating: number | null;
  is_placeholder: number;
}

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS songs (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  title_norm  TEXT NOT NULL,
  artist_norm TEXT NOT NULL,
  duration_ms INTEGER,
  isrc        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS songs_norm ON songs(artist_norm, title_norm);

-- Links external track IDs (e.g. a Spotify track ID) to our songs.
-- Filled when the user confirms a match, so the next lookup is an exact hit.
CREATE TABLE IF NOT EXISTS song_external_ids (
  song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  PRIMARY KEY (provider, external_id)
);

CREATE TABLE IF NOT EXISTS tabs (
  id             INTEGER PRIMARY KEY,
  song_id        INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  instrument     TEXT NOT NULL DEFAULT 'guitar',
  tuning         TEXT,
  format         TEXT NOT NULL CHECK (format IN ('alphatex','gp','musicxml')),
  content        BLOB NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  rating         REAL,
  is_placeholder INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tabs_song ON tabs(song_id);

-- Small key/value store (Spotify tokens for the optional fallback).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- History and favorites synced across devices (see library.ts): one row per
-- (list, Songsterr song), either a live entry (at) or a tombstone (deleted_at).
CREATE TABLE IF NOT EXISTS library_entries (
  list       TEXT NOT NULL CHECK (list IN ('history','favorites')),
  song_id    INTEGER NOT NULL,
  url        TEXT,
  title      TEXT,
  artist     TEXT,
  at         INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY (list, song_id),
  CHECK ((at IS NULL) <> (deleted_at IS NULL))
);
`;

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function insertSong(
  db: Db,
  s: { title: string; artist: string; durationMs?: number | null; isrc?: string | null },
): SongRow {
  const info = db
    .prepare(
      `INSERT INTO songs (title, artist, title_norm, artist_norm, duration_ms, isrc)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(s.title, s.artist, normalizeTitle(s.title), normalizeArtist(s.artist), s.durationMs ?? null, s.isrc ?? null);
  return getSong(db, Number(info.lastInsertRowid))!;
}

export function findSongExact(db: Db, title: string, artist: string): SongRow | undefined {
  return db
    .prepare(`SELECT * FROM songs WHERE title_norm = ? AND artist_norm = ? LIMIT 1`)
    .get(normalizeTitle(title), normalizeArtist(artist)) as SongRow | undefined;
}

export function getSong(db: Db, id: number): SongRow | undefined {
  return db.prepare(`SELECT * FROM songs WHERE id = ?`).get(id) as SongRow | undefined;
}

export function allSongs(db: Db): SongRow[] {
  return db.prepare(`SELECT * FROM songs`).all() as SongRow[];
}

export function insertTab(
  db: Db,
  t: {
    songId: number;
    format: TabFormat;
    content: Buffer;
    instrument?: string;
    tuning?: string | null;
    isPlaceholder?: boolean;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO tabs (song_id, instrument, tuning, format, content, is_placeholder)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(t.songId, t.instrument ?? "guitar", t.tuning ?? null, t.format, t.content, t.isPlaceholder ? 1 : 0);
  return Number(info.lastInsertRowid);
}

/** Tab metadata for a song (no content). */
export function tabsForSong(db: Db, songId: number) {
  return db
    .prepare(
      `SELECT id, instrument, tuning, format, version, rating, is_placeholder
       FROM tabs WHERE song_id = ? ORDER BY is_placeholder ASC, rating DESC NULLS LAST, id ASC`,
    )
    .all(songId) as Omit<TabRow, "content" | "song_id">[];
}

export function getTab(db: Db, id: number): TabRow | undefined {
  return db.prepare(`SELECT * FROM tabs WHERE id = ?`).get(id) as TabRow | undefined;
}

export function songByExternalId(db: Db, provider: string, externalId: string): SongRow | undefined {
  return db
    .prepare(
      `SELECT s.* FROM song_external_ids e JOIN songs s ON s.id = e.song_id
       WHERE e.provider = ? AND e.external_id = ?`,
    )
    .get(provider, externalId) as SongRow | undefined;
}

export function linkExternalId(db: Db, songId: number, provider: string, externalId: string): void {
  db.prepare(
    `INSERT INTO song_external_ids (song_id, provider, external_id) VALUES (?, ?, ?)
     ON CONFLICT(provider, external_id) DO UPDATE SET song_id = excluded.song_id`,
  ).run(songId, provider, externalId);
}

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function deleteSetting(db: Db, key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

interface LibraryRow {
  song_id: number;
  url: string | null;
  title: string | null;
  artist: string | null;
  at: number | null;
  deleted_at: number | null;
}

/** Stored records of one list: live entries newest first, then tombstones newest first. */
export function loadLibraryList(db: Db, list: ListName): Change[] {
  const rows = db
    .prepare(
      `SELECT song_id, url, title, artist, at, deleted_at FROM library_entries WHERE list = ?
       ORDER BY deleted_at IS NOT NULL, COALESCE(at, deleted_at) DESC, song_id ASC`,
    )
    .all(list) as LibraryRow[];
  return rows.map((r): Change =>
    r.deleted_at !== null
      ? { songId: r.song_id, deletedAt: r.deleted_at }
      : { url: r.url!, songId: r.song_id, title: r.title!, artist: r.artist!, at: r.at! },
  );
}

/** Replaces the stored records of one list. */
export function saveLibraryList(db: Db, list: ListName, records: readonly Change[]): void {
  const insert = db.prepare(
    `INSERT INTO library_entries (list, song_id, url, title, artist, at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM library_entries WHERE list = ?`).run(list);
    for (const c of records) {
      if (isTombstone(c)) insert.run(list, c.songId, null, null, null, null, c.deletedAt);
      else insert.run(list, c.songId, c.url, c.title, c.artist, c.at, null);
    }
  })();
}

/** Merges a device's changes into the stored lists (atomically) and returns the live entries. */
export function syncLibrary(
  db: Db,
  changes: Partial<Record<ListName, readonly Change[]>>,
): Record<ListName, TabEntry[]> {
  return db.transaction(() => {
    const out = {} as Record<ListName, TabEntry[]>;
    for (const list of LISTS) {
      let records = loadLibraryList(db, list);
      const pushed = changes[list];
      if (pushed?.length) {
        records = mergeList(list, records, pushed);
        saveLibraryList(db, list, records);
      }
      out[list] = liveEntries(records);
    }
    return out;
  })();
}
