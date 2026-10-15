/**
 * History and favorites synced across devices.
 *
 * Each list holds at most one record per Songsterr song: either a live entry (the
 * time it was opened or saved is `at`) or a tombstone (the time it was removed is
 * `deletedAt`). Devices push their changes and the newest timestamp wins per song,
 * so every device that applies the same changes ends up with the same lists,
 * whatever order they arrive in.
 */

export type ListName = "history" | "favorites";
export const LISTS: readonly ListName[] = ["history", "favorites"];

/** A Songsterr tab the user opened or saved (same shape as the app's `TabEntry`). */
export interface TabEntry {
  url: string;
  songId: number;
  title: string;
  artist: string;
  /** Epoch ms of the last time it was opened (history) or saved (favorites). */
  at: number;
}

/** The song was removed from the list at `deletedAt` (epoch ms). */
export interface Tombstone {
  songId: number;
  deletedAt: number;
}

/** What a device pushes, and what the server stores: one per (list, songId). */
export type Change = TabEntry | Tombstone;

export const HISTORY_LIMIT = 50;
/** Older tombstones are forgotten; past this, removals can no longer be undone by stale devices anyway. */
export const TOMBSTONE_LIMIT = 500;

export function isTombstone(c: Change): c is Tombstone {
  return "deletedAt" in c;
}

const stamp = (c: Change) => (isTombstone(c) ? c.deletedAt : c.at);

/** Last writer wins; a tombstone beats an add with the same timestamp. */
function wins(next: Change, current: Change): boolean {
  const a = stamp(next);
  const b = stamp(current);
  return a > b || (a === b && isTombstone(next) && !isTombstone(current));
}

/** Newest first, then by songId so ties are stable. */
const newestFirst = (a: Change, b: Change) => stamp(b) - stamp(a) || a.songId - b.songId;

/**
 * Applies `changes` to the stored records of one list and returns the new records:
 * live entries newest first (history capped to {@link HISTORY_LIMIT}), then the most
 * recent tombstones. Inputs are not modified.
 */
export function mergeList(list: ListName, current: readonly Change[], changes: readonly Change[]): Change[] {
  const bySong = new Map<number, Change>();
  for (const c of [...current, ...changes]) {
    const prev = bySong.get(c.songId);
    if (!prev || wins(c, prev)) bySong.set(c.songId, c);
  }
  const all = [...bySong.values()].sort(newestFirst);
  let live = all.filter((c) => !isTombstone(c));
  // History entries pushed past the limit are simply forgotten, as on the device.
  if (list === "history") live = live.slice(0, HISTORY_LIMIT);
  const tombstones = all.filter(isTombstone).slice(0, TOMBSTONE_LIMIT);
  return [...live, ...tombstones].map((c) => ({ ...c }));
}

/** The entries a device shows: tombstones dropped, newest first. */
export function liveEntries(records: readonly Change[]): TabEntry[] {
  return records.filter((c): c is TabEntry => !isTombstone(c)).sort(newestFirst);
}
