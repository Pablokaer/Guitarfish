import { describe, expect, it } from "vitest";
import { current, jumpTo, move, newQueue, next, nextRepeat, parseQueue, previous, setRepeat, setShuffle, shuffled, withItems, type Queue } from "../src/queue";

/** A deterministic generator, so shuffles are repeatable. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const ids = [10, 20, 30, 40, 50];
/** The ids played by pressing next until the end (or `limit`). */
function playOut(q: Queue | null, limit = 20): number[] {
  const out: number[] = [];
  while (q && out.length < limit) {
    out.push(current(q)!);
    q = next(q, true);
  }
  return out;
}

describe("move", () => {
  it("moves an item forward and back", () => {
    expect(move(ids, 0, 2)).toEqual([20, 30, 10, 40, 50]);
    expect(move(ids, 4, 1)).toEqual([10, 50, 20, 30, 40]);
    expect(move(ids, 1, 1)).toEqual(ids);
  });

  it("clamps the target and ignores a bad source", () => {
    expect(move(ids, 1, 99)).toEqual([10, 30, 40, 50, 20]);
    expect(move(ids, 1, -3)).toEqual([20, 10, 30, 40, 50]);
    expect(move(ids, 7, 0)).toEqual(ids);
  });
});

describe("shuffled", () => {
  it("is a permutation and leaves the input alone", () => {
    const input = [...ids];
    const out = shuffled(input, seeded(3));
    expect([...out].sort()).toEqual([...ids].sort());
    expect(input).toEqual(ids);
  });
});

describe("sequential playback", () => {
  it("plays from the start track to the end", () => {
    expect(playOut(newQueue(ids, 2))).toEqual([30, 40, 50]);
  });

  it("wraps around with repeat all", () => {
    expect(playOut(newQueue(ids, 3, { repeat: "all" }), 7)).toEqual([40, 50, 10, 20, 30, 40, 50]);
  });

  it("repeats one track when it ends, but a manual next moves on", () => {
    const q = newQueue(ids, 1, { repeat: "one" });
    expect(current(next(q, true))).toBe(20);
    expect(current(next(q))).toBe(30);
    expect(current(next(newQueue(ids, 4, { repeat: "one" })))).toBe(10);
  });

  it("goes back, staying at the start or wrapping with repeat", () => {
    expect(current(previous(newQueue(ids, 2)))).toBe(20);
    expect(current(previous(newQueue(ids, 0)))).toBe(10);
    expect(current(previous(newQueue(ids, 0, { repeat: "all" })))).toBe(50);
  });

  it("drops duplicate ids and clamps the start", () => {
    const q = newQueue([1, 2, 2, 3], 9);
    expect(q.items).toEqual([1, 2, 3]);
    expect(current(q)).toBe(3);
  });

  it("handles an empty list", () => {
    const q = newQueue([], 0);
    expect(current(q)).toBeNull();
    expect(next(q)).toBeNull();
    expect(previous(q)).toBe(q);
  });

  it("jumps to a track in the queue", () => {
    const q = newQueue(ids, 0);
    expect(current(jumpTo(q, 40))).toBe(40);
    expect(jumpTo(q, 99)).toBe(q);
  });
});

describe("shuffle", () => {
  it("starts with the chosen track and plays every track once", () => {
    const q = newQueue(ids, 2, { shuffle: true }, seeded(7));
    const played = playOut(q);
    expect(played[0]).toBe(30);
    expect([...played].sort()).toEqual([...ids].sort());
  });

  it("turning it on keeps the current track; off returns to the list order", () => {
    const q = next(newQueue(ids, 0))!; // on 20
    const on = setShuffle(q, true, seeded(5));
    expect(current(on)).toBe(20);
    expect(on.order).toHaveLength(5);
    const off = setShuffle(next(on)!, false);
    expect(off.order).toEqual(ids);
    expect(current(off)).toBe(current(next(on)!));
    expect(setShuffle(off, false)).toBe(off);
  });

  it("works before any track has played", () => {
    const q: Queue = { ...newQueue(ids, 0), pos: -1 };
    expect(setShuffle(q, true, seeded(2)).pos).toBe(-1);
    expect(setShuffle(setShuffle(q, true, seeded(2)), false).pos).toBe(-1);
  });
});

describe("repeat button", () => {
  it("cycles off → all → one → off", () => {
    expect(nextRepeat("off")).toBe("all");
    expect(nextRepeat("all")).toBe("one");
    expect(nextRepeat("one")).toBe("off");
    expect(setRepeat(newQueue(ids, 0), "all").repeat).toBe("all");
  });
});

describe("withItems: the playing list changed", () => {
  it("follows a reorder and keeps the current track", () => {
    const q = withItems(newQueue(ids, 1), move(ids, 1, 4)); // 20 moved to the end
    expect(current(q)).toBe(20);
    expect(next(q)).toBeNull();
  });

  it("continues with the track that took the removed one's place", () => {
    const q = withItems(newQueue(ids, 2), [10, 20, 40, 50]); // 30 (playing) removed
    expect(current(next(q)!)).toBe(40);
    const first = withItems(newQueue(ids, 0), [20, 30, 40, 50]);
    expect(current(next(first)!)).toBe(20);
  });

  it("shuffled, an edit that keeps the same songs (a rename) keeps the order", () => {
    const q = next(newQueue(ids, 0, { shuffle: true }, seeded(9)))!;
    expect(withItems(q, [...ids].reverse(), seeded(3)).order).toEqual(q.order);
    const fewer = withItems(q, ids.filter((id) => id !== q.order[3]), seeded(3));
    expect(fewer.order).toEqual(q.order.filter((id) => id !== q.order[3]));
  });

  it("shuffled, keeps what was played and shuffles the rest with the new tracks", () => {
    let q = newQueue(ids, 0, { shuffle: true }, seeded(9));
    q = next(next(q)!)!; // three played
    const played = q.order.slice(0, 3);
    const after = withItems(q, [...ids, 60], seeded(4));
    expect(after.order.slice(0, 3)).toEqual(played);
    expect(current(after)).toBe(played[2]);
    expect([...after.order].sort()).toEqual([...ids, 60].sort());
  });
});

describe("parseQueue", () => {
  it("reads a stored queue back", () => {
    const q = setShuffle(newQueue(ids, 2, { repeat: "one" }), true, seeded(1));
    expect(parseQueue(JSON.parse(JSON.stringify(q)))).toEqual(q);
  });

  it("rejects or repairs bad data", () => {
    expect(parseQueue(null)).toBeNull();
    expect(parseQueue({ items: [1, "x"], order: [1], pos: 0 })).toBeNull();
    expect(parseQueue({ items: [1, 2], order: [1], pos: 0 })).toBeNull();
    expect(parseQueue({ items: [1, 2], order: [2, 1], pos: 7, repeat: "sometimes" })).toEqual({ items: [1, 2], order: [2, 1], pos: 1, shuffle: false, repeat: "off" });
  });
});
