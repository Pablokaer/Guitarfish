import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLibraryList, openDb, saveLibraryList, syncLibrary } from "../src/db.js";
import type { Change, TabEntry } from "../src/library.js";

const entry = (songId: number, at: number): TabEntry => ({
  url: `https://www.songsterr.com/a/wa/song?id=${songId}`,
  songId,
  title: `Song ${songId}`,
  artist: "Band",
  at,
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("library storage", () => {
  it("starts empty", () => {
    const db = openDb(":memory:");
    expect(loadLibraryList(db, "history")).toEqual([]);
    expect(loadLibraryList(db, "favorites")).toEqual([]);
  });

  it("stores entries and tombstones per list, replacing the previous records", () => {
    const db = openDb(":memory:");
    const records: Change[] = [entry(2, 200), entry(1, 100), { songId: 3, deletedAt: 150 }];
    saveLibraryList(db, "favorites", records);
    expect(loadLibraryList(db, "favorites")).toEqual(records);
    expect(loadLibraryList(db, "history")).toEqual([]);

    saveLibraryList(db, "favorites", [entry(5, 500)]);
    expect(loadLibraryList(db, "favorites")).toEqual([entry(5, 500)]);
  });

  it("syncs changes into both lists and returns the live entries", () => {
    const db = openDb(":memory:");
    syncLibrary(db, { history: [entry(1, 100), entry(2, 200)], favorites: [entry(1, 100)] });
    const r = syncLibrary(db, { favorites: [{ songId: 1, deletedAt: 300 }] });
    expect(r).toEqual({ history: [entry(2, 200), entry(1, 100)], favorites: [] });
    // The tombstone is kept, so the old add can't come back.
    expect(syncLibrary(db, { favorites: [entry(1, 100)] }).favorites).toEqual([]);
    expect(syncLibrary(db, {})).toEqual(r);
  });

  it("upgrades a database created before the library existed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guitarfish-db-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "old.db");
    const old = new Database(file);
    old.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
              INSERT INTO settings VALUES ('spotify.tokens', '{}');`);
    old.close();

    const db = openDb(file);
    syncLibrary(db, { history: [entry(1, 100)] });
    db.close();
    const again = openDb(file);
    expect(loadLibraryList(again, "history")).toEqual([entry(1, 100)]);
    expect(again.prepare(`SELECT value FROM settings WHERE key = 'spotify.tokens'`).get()).toEqual({ value: "{}" });
    again.close();
  });
});
