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

// ---- Request validation ---------------------------------------------------

/** Per list, per request. A device's whole history fits easily. */
export const MAX_CHANGES = 500;
const MAX_URL = 2048;
const MAX_TEXT = 512;

export type SyncRequest = Partial<Record<ListName, Change[]>>;

const isStamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

function parseChange(v: unknown, now: number): Change | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "each change must be an object";
  const c = v as Record<string, unknown>;
  if (!Number.isSafeInteger(c.songId) || (c.songId as number) <= 0) return "songId must be a positive integer";
  const songId = c.songId as number;
  if ("deletedAt" in c) {
    if ("at" in c) return "a change has either at (an entry) or deletedAt (a removal), not both";
    if (!isStamp(c.deletedAt)) return "deletedAt must be epoch milliseconds";
    return { songId, deletedAt: Math.min(c.deletedAt, now) };
  }
  if (!isText(c.url, MAX_URL) || !c.url) return `url must be a non-empty string of at most ${MAX_URL} characters`;
  if (!isText(c.title, MAX_TEXT) || !isText(c.artist, MAX_TEXT)) {
    return `title and artist must be strings of at most ${MAX_TEXT} characters`;
  }
  if (!isStamp(c.at)) return "at must be epoch milliseconds";
  // A device clock running ahead must not pin its entries above everyone else's for good.
  return { url: c.url, songId, title: c.title, artist: c.artist, at: Math.min(c.at, now) };
}

/**
 * Validates a sync request body `{ history?: Change[], favorites?: Change[] }`.
 * Unknown fields inside a change are dropped; timestamps later than `now` are
 * clamped to `now`. Returns an error message for anything malformed.
 */
export function parseSyncRequest(
  body: unknown,
  now: number,
): { ok: true; value: SyncRequest } | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const value: SyncRequest = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!LISTS.includes(key as ListName)) return { ok: false, error: `unknown list "${key}"; use ${LISTS.join(" or ")}` };
    if (!Array.isArray(raw)) return { ok: false, error: `${key} must be an array` };
    if (raw.length > MAX_CHANGES) return { ok: false, error: `${key}: at most ${MAX_CHANGES} changes per request` };
    const changes: Change[] = [];
    for (const item of raw) {
      const c = parseChange(item, now);
      if (typeof c === "string") return { ok: false, error: `${key}: ${c}` };
      changes.push(c);
    }
    value[key as ListName] = changes;
  }
  return { ok: true, value };
}
