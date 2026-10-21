/**
 * The local player's play queue, as plain data: the tracks of the list being played
 * (library or playlist, in its order) and the order they play in, which differs
 * when shuffled. Every function returns a new queue; nothing here touches audio.
 */

export type RepeatMode = "off" | "all" | "one";
export const REPEAT_MODES: readonly RepeatMode[] = ["off", "all", "one"];

export interface Queue {
  /** Track ids of the list being played, in the list's order. */
  items: number[];
  /** The same ids in play order (= items unless shuffled). */
  order: number[];
  /** Index in `order` of the current track; -1 before the first one. */
  pos: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

export type Rng = () => number;

/** Fisher–Yates shuffle of a copy. */
export function shuffled<T>(list: readonly T[], rng: Rng = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** `list` with the item at `from` moved to `to` (both clamped). */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const a = [...list];
  if (from < 0 || from >= a.length) return a;
  const [item] = a.splice(from, 1);
  a.splice(Math.max(0, Math.min(to, a.length)), 0, item);
  return a;
}

/** A queue over `items` starting at `start`; shuffled, the start track plays first and the rest in random order. */
export function newQueue(items: readonly number[], start: number, opts: { shuffle?: boolean; repeat?: RepeatMode } = {}, rng: Rng = Math.random): Queue {
  const list = [...new Set(items)];
  const shuffle = !!opts.shuffle;
  const repeat = opts.repeat ?? "off";
  if (!list.length) return { items: [], order: [], pos: -1, shuffle, repeat };
  const first = list[Math.max(0, Math.min(start, list.length - 1))];
  if (shuffle) return { items: list, order: [first, ...shuffled(list.filter((id) => id !== first), rng)], pos: 0, shuffle, repeat };
  return { items: list, order: list, pos: list.indexOf(first), shuffle, repeat };
}

export function current(q: Queue | null): number | null {
  return q && q.pos >= 0 && q.pos < q.order.length ? q.order[q.pos] : null;
}

/**
 * The queue moved to the next track, or null at the end. `auto` (the track ended)
 * repeats the track with repeat "one"; a manual skip always moves on, wrapping
 * around when repeat is on.
 */
export function next(q: Queue, auto = false): Queue | null {
  if (!q.order.length) return null;
  if (auto && q.repeat === "one" && q.pos >= 0) return q;
  if (q.pos + 1 < q.order.length) return { ...q, pos: q.pos + 1 };
  return q.repeat === "off" ? null : { ...q, pos: 0 };
}

/** The queue moved to the previous track; at the start it wraps with repeat on, else stays. */
export function previous(q: Queue): Queue {
  if (!q.order.length) return q;
  if (q.pos > 0) return { ...q, pos: q.pos - 1 };
  return q.repeat === "off" ? { ...q, pos: 0 } : { ...q, pos: q.order.length - 1 };
}

/** Jumps to `id` (a track of the queue); unknown ids leave it as it is. */
export function jumpTo(q: Queue, id: number): Queue {
  const pos = q.order.indexOf(id);
  return pos < 0 ? q : { ...q, pos };
}

/** Shuffle on: the current track stays, the rest follow in random order. Off: back to the list's order. */
export function setShuffle(q: Queue, on: boolean, rng: Rng = Math.random): Queue {
  if (on === q.shuffle) return q;
  const cur = current(q);
  if (on) {
    const rest = shuffled(q.items.filter((id) => id !== cur), rng);
    return { ...q, shuffle: true, order: cur == null ? rest : [cur, ...rest], pos: cur == null ? -1 : 0 };
  }
  return { ...q, shuffle: false, order: [...q.items], pos: cur == null ? -1 : q.items.indexOf(cur) };
}

export function setRepeat(q: Queue, repeat: RepeatMode): Queue {
  return { ...q, repeat };
}

/** The repeat mode after `r` when the button is pressed: off → all → one → off. */
export function nextRepeat(r: RepeatMode): RepeatMode {
  return REPEAT_MODES[(REPEAT_MODES.indexOf(r) + 1) % REPEAT_MODES.length];
}

/**
 * The list being played changed (reordered, songs added or removed): the queue
 * follows it and keeps its place. Unshuffled, play continues from the current
 * track's new position; if the current track was removed, from the track that took
 * its place. Shuffled, the order stays as it was: removed tracks leave it, and new
 * ones are slotted in at random among the tracks still to play.
 */
export function withItems(q: Queue, items: readonly number[], rng: Rng = Math.random): Queue {
  const list = [...new Set(items)];
  const keep = new Set(list);
  const cur = current(q);
  if (!q.shuffle) {
    let pos = cur == null ? -1 : list.indexOf(cur);
    if (pos < 0 && cur != null) {
      // Removed: the next track is the one that now sits where it was.
      const before = q.items.slice(0, q.items.indexOf(cur)).filter((id) => keep.has(id)).length;
      pos = before - 1;
    }
    return { ...q, items: list, order: list, pos: Math.min(pos, list.length - 1) };
  }
  const played = q.order.slice(0, q.pos + 1).filter((id) => keep.has(id));
  const rest = q.order.slice(q.pos + 1).filter((id) => keep.has(id));
  const known = new Set(q.order);
  for (const id of list) {
    if (!known.has(id)) rest.splice(Math.floor(rng() * (rest.length + 1)), 0, id);
  }
  return { ...q, items: list, order: [...played, ...rest], pos: played.length - 1 };
}

/** A queue read back from storage, or null when it doesn't make sense. */
export function parseQueue(raw: unknown): Queue | null {
  const q = raw as Partial<Queue> | null;
  const ids = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => Number.isInteger(x));
  if (!q || typeof q !== "object" || !ids(q.items) || !ids(q.order) || !Number.isInteger(q.pos)) return null;
  const items = [...new Set(q.items)];
  const set = new Set(items);
  const order = [...new Set(q.order)].filter((id) => set.has(id));
  if (order.length !== items.length) return null;
  return {
    items,
    order,
    pos: Math.max(-1, Math.min(q.pos!, order.length - 1)),
    shuffle: q.shuffle === true,
    repeat: REPEAT_MODES.includes(q.repeat as RepeatMode) ? (q.repeat as RepeatMode) : "off",
  };
}
