import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  TOMBSTONE_LIMIT,
  liveEntries,
  mergeList,
  type Change,
  type TabEntry,
} from "../src/library.js";

const entry = (songId: number, at: number, title = `Song ${songId}`): TabEntry => ({
  url: `https://www.songsterr.com/a/wa/song?id=${songId}`,
  songId,
  title,
  artist: "Band",
  at,
});
const gone = (songId: number, deletedAt: number): Change => ({ songId, deletedAt });

const ids = (records: Change[]) => liveEntries(records).map((e) => e.songId);

describe("mergeList", () => {
  it("adds new entries, most recent first", () => {
    const merged = mergeList("favorites", [entry(1, 100)], [entry(2, 300), entry(3, 200)]);
    expect(ids(merged)).toEqual([2, 3, 1]);
  });

  it("keeps one entry per song: the newer add wins, with its metadata", () => {
    const merged = mergeList("history", [entry(1, 100, "Old"), entry(2, 200)], [entry(1, 300, "New")]);
    expect(liveEntries(merged)).toEqual([entry(1, 300, "New"), entry(2, 200)]);
  });

  it("ignores an add older than the stored one", () => {
    const merged = mergeList("history", [entry(1, 300, "Current")], [entry(1, 100, "Stale")]);
    expect(liveEntries(merged)).toEqual([entry(1, 300, "Current")]);
  });

  it("removes an entry when a newer tombstone arrives", () => {
    const merged = mergeList("favorites", [entry(1, 100), entry(2, 200)], [gone(1, 150)]);
    expect(ids(merged)).toEqual([2]);
  });

  it("ignores a tombstone older than the entry (re-added later)", () => {
    const merged = mergeList("favorites", [entry(1, 300)], [gone(1, 200)]);
    expect(ids(merged)).toEqual([1]);
  });

  it("lets the tombstone win a tie", () => {
    expect(ids(mergeList("favorites", [entry(1, 100)], [gone(1, 100)]))).toEqual([]);
    expect(ids(mergeList("favorites", [gone(1, 100)], [entry(1, 100)]))).toEqual([]);
  });

  it("keeps tombstones so a stale device can't bring an entry back", () => {
    const afterRemove = mergeList("favorites", [entry(1, 100)], [gone(1, 200)]);
    expect(mergeList("favorites", afterRemove, [entry(1, 100)])).toEqual(afterRemove);
    expect(ids(mergeList("favorites", afterRemove, [entry(1, 250)]))).toEqual([1]);
  });

  it("stores a tombstone for a song it has never seen", () => {
    const merged = mergeList("favorites", [], [gone(7, 500)]);
    expect(ids(mergeList("favorites", merged, [entry(7, 400)]))).toEqual([]);
  });

  it("gives the same result whatever the order of the changes", () => {
    const changes = [entry(1, 100), gone(1, 200), entry(1, 300, "Back"), entry(2, 50), gone(2, 60)];
    const forward = liveEntries(mergeList("favorites", [], changes));
    const backward = liveEntries(mergeList("favorites", [], [...changes].reverse()));
    expect(forward).toEqual([entry(1, 300, "Back")]);
    expect(backward).toEqual(forward);
  });

  it("caps history to the most recent live entries", () => {
    const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => entry(i + 1, 1000 + i));
    const merged = mergeList("history", [], many);
    const live = liveEntries(merged);
    expect(live).toHaveLength(HISTORY_LIMIT);
    expect(live[0].songId).toBe(HISTORY_LIMIT + 5);
    expect(live.at(-1)!.songId).toBe(6);
    // Dropped entries are forgotten, not tombstoned.
    expect(merged).toHaveLength(HISTORY_LIMIT);
  });

  it("does not cap favorites", () => {
    const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => entry(i + 1, 1000 + i));
    expect(liveEntries(mergeList("favorites", [], many))).toHaveLength(HISTORY_LIMIT + 5);
  });

  it("keeps only the most recent tombstones", () => {
    const tombs = Array.from({ length: TOMBSTONE_LIMIT + 3 }, (_, i) => gone(i + 1, 1000 + i));
    const merged = mergeList("favorites", [], tombs);
    expect(merged).toHaveLength(TOMBSTONE_LIMIT);
    expect(merged.map((c) => c.songId)).not.toContain(1);
    expect(merged.map((c) => c.songId)).toContain(TOMBSTONE_LIMIT + 3);
  });

  it("does not modify its inputs", () => {
    const current = [entry(1, 100)];
    const changes = [gone(1, 200), entry(2, 300)];
    const snapshot = JSON.stringify([current, changes]);
    mergeList("history", current, changes);
    expect(JSON.stringify([current, changes])).toBe(snapshot);
  });
});

describe("liveEntries", () => {
  it("drops tombstones and sorts by time, newest first, then by songId", () => {
    expect(ids([entry(3, 100), gone(4, 900), entry(1, 200), entry(2, 100)])).toEqual([1, 2, 3]);
  });
});
