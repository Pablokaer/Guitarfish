import type { LocalTrack } from "./music";

/** What the Music pages need beyond the DOM: search, sort, times, drag targets and keys. */

export type SortKey = "added" | "title" | "artist" | "album" | "duration";
export const SORT_LABELS: Record<SortKey, string> = {
  added: "Recently added",
  title: "Title",
  artist: "Artist",
  album: "Album",
  duration: "Duration",
};

export function parseSortKey(v: unknown): SortKey {
  return typeof v === "string" && v in SORT_LABELS ? (v as SortKey) : "added";
}

/** Lower case without accents, so "beyonce" finds "Beyoncé". */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Tracks whose title, artist, album or file name contain every word of `query`. */
export function filterTracks<T extends Pick<LocalTrack, "title" | "artist" | "album" | "fileName">>(tracks: readonly T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...tracks];
  return tracks.filter((t) => {
    const hay = fold(`${t.title} ${t.artist} ${t.album} ${t.fileName}`);
    return words.every((w) => hay.includes(w));
  });
}

const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/**
 * Tracks in `key` order: newest first for "added", shortest first for durations
 * (unknown last), alphabetical otherwise, with empty values last. Ties by title.
 */
export function sortTracks<T extends Pick<LocalTrack, "title" | "artist" | "album" | "durationMs" | "addedAt" | "id">>(tracks: readonly T[], key: SortKey): T[] {
  const byTitle = (a: T, b: T) => text(a.title, b.title) || a.id - b.id;
  const emptyLast = (a: string, b: string) => (!a !== !b ? (a ? -1 : 1) : text(a, b));
  const cmp: Record<SortKey, (a: T, b: T) => number> = {
    added: (a, b) => b.addedAt - a.addedAt || b.id - a.id,
    title: byTitle,
    artist: (a, b) => emptyLast(a.artist, b.artist) || text(a.album, b.album) || byTitle(a, b),
    album: (a, b) => emptyLast(a.album, b.album) || byTitle(a, b),
    duration: (a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity) || byTitle(a, b),
  };
  return [...tracks].sort(cmp[key]);
}

/** "3:05", or "1:02:03" past an hour; "–:––" when unknown. */
export function formatTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "–:––";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "1.00×" */
export function formatSpeed(v: number): string {
  return `${v.toFixed(2)}×`;
}

/** Total length of a list of tracks, e.g. "12 songs · 48 min". */
export function listSummary(tracks: readonly Pick<LocalTrack, "durationMs">[]): string {
  const n = tracks.length;
  const ms = tracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  const min = Math.round(ms / 60000);
  const length = ms < 60000 ? `${Math.floor(ms / 1000)} s` : min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
  return `${n} ${n === 1 ? "song" : "songs"}${ms ? ` · ${length}` : ""}`;
}

/**
 * Where a row dragged from `from` lands when the pointer is at `y`: the number of
 * other rows whose middle is above the pointer. `mids` are the rows' vertical
 * middles in their current order. The result is the target for queue.move().
 */
export function dropIndex(mids: readonly number[], from: number, y: number): number {
  return mids.filter((m, i) => i !== from && m < y).length;
}

export type PlayerKey = "toggle" | "back" | "forward" | "previous" | "next" | "slower" | "faster" | "normal-speed" | "loop" | "mute";

/** Seconds ← and → seek. */
export const SEEK_STEP_MS = 5000;

/**
 * The player command for a key press, or null. Typing in a field never triggers
 * one, and Space on a button presses the button instead.
 */
export function playerKey(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">,
  target: { tagName?: string; isContentEditable?: boolean } | null,
): PlayerKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const tag = target?.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return null;
  switch (e.key) {
    case " ":
      return tag === "BUTTON" ? null : "toggle";
    case "ArrowLeft":
      return e.shiftKey ? "previous" : "back";
    case "ArrowRight":
      return e.shiftKey ? "next" : "forward";
    case "[":
    case "-":
      return "slower";
    case "]":
    case "+":
    case "=":
      return "faster";
    case "0":
      return "normal-speed";
    case "l":
    case "L":
      return "loop";
    case "m":
    case "M":
      return "mute";
    default:
      return null;
  }
}
