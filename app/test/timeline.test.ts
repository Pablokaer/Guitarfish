import { describe, expect, it } from "vitest";
import { barAt, buildTimeline, tempoMap, tickToMs, TICKS_PER_QUARTER } from "../src/timeline";

const Q = TICKS_PER_QUARTER;
const bar44 = 4 * Q; // one 4/4 bar

describe("tempoMap", () => {
  it("falls back to 120 bpm without tempo changes", () => {
    expect(tempoMap([])).toEqual([{ tick: 0, ms: 0, bpm: 120 }]);
  });

  it("uses the given fallback tempo before the first change", () => {
    expect(tempoMap([], 90)).toEqual([{ tick: 0, ms: 0, bpm: 90 }]);
    expect(tempoMap([{ tick: Q, bpm: 60 }], 60)).toEqual([
      { tick: 0, ms: 0, bpm: 60 },
      { tick: Q, ms: 1000, bpm: 60 },
    ]);
  });

  it("accumulates the time of each change, at its exact tick", () => {
    // 120 bpm for one quarter (500 ms), then 60 bpm from mid-bar.
    expect(tempoMap([{ tick: 0, bpm: 120 }, { tick: Q, bpm: 60 }, { tick: 3 * Q, bpm: 240 }])).toEqual([
      { tick: 0, ms: 0, bpm: 120 },
      { tick: Q, ms: 500, bpm: 60 },
      { tick: 3 * Q, ms: 2500, bpm: 240 },
    ]);
  });

  it("sorts changes and lets the last change at the same tick win", () => {
    expect(tempoMap([{ tick: Q, bpm: 60 }, { tick: 0, bpm: 100 }, { tick: 0, bpm: 120 }])).toEqual([
      { tick: 0, ms: 0, bpm: 120 },
      { tick: Q, ms: 500, bpm: 60 },
    ]);
  });

  it("ignores non-positive or invalid tempos", () => {
    expect(tempoMap([{ tick: 0, bpm: 0 }, { tick: Q, bpm: -5 }, { tick: 2 * Q, bpm: Number.NaN }])).toEqual([{ tick: 0, ms: 0, bpm: 120 }]);
  });

  it("treats a non-positive fallback as 120 bpm", () => {
    expect(tempoMap([], 0)).toEqual([{ tick: 0, ms: 0, bpm: 120 }]);
  });
});

describe("tickToMs", () => {
  const map = tempoMap([{ tick: 0, bpm: 120 }, { tick: bar44, bpm: 60 }]);

  it("converts ticks inside each tempo segment", () => {
    expect(tickToMs(map, 0)).toBe(0);
    expect(tickToMs(map, Q)).toBe(500);
    expect(tickToMs(map, bar44)).toBe(2000);
    expect(tickToMs(map, bar44 + Q)).toBe(3000);
  });

  it("extrapolates before the first entry with its tempo", () => {
    expect(tickToMs(map, -Q)).toBe(-500);
  });
});

describe("buildTimeline", () => {
  it("is empty without played bars", () => {
    expect(buildTimeline([], [])).toEqual([]);
  });

  it("times bars in play order, so a repeated bar appears again", () => {
    const played = [
      { index: 0, startTick: 0, endTick: bar44 },
      { index: 1, startTick: bar44, endTick: 2 * bar44 },
      { index: 0, startTick: 2 * bar44, endTick: 3 * bar44 },
      { index: 1, startTick: 3 * bar44, endTick: 4 * bar44 },
      { index: 2, startTick: 4 * bar44, endTick: 5 * bar44 },
    ];
    expect(buildTimeline(played, [{ tick: 0, bpm: 120 }])).toEqual([
      { index: 0, startMs: 0, endMs: 2000 },
      { index: 1, startMs: 2000, endMs: 4000 },
      { index: 0, startMs: 4000, endMs: 6000 },
      { index: 1, startMs: 6000, endMs: 8000 },
      { index: 2, startMs: 8000, endMs: 10000 },
    ]);
  });

  it("applies a tempo change at its position inside the bar", () => {
    // Bar 0: one quarter at 120 (500 ms), three at 60 (3 s). Bar 1 stays at 60 (4 s).
    const played = [
      { index: 0, startTick: 0, endTick: bar44 },
      { index: 1, startTick: bar44, endTick: 2 * bar44 },
    ];
    expect(buildTimeline(played, [{ tick: 0, bpm: 120 }, { tick: Q, bpm: 60 }])).toEqual([
      { index: 0, startMs: 0, endMs: 3500 },
      { index: 1, startMs: 3500, endMs: 7500 },
    ]);
  });

  it("uses the fallback tempo when there are no changes", () => {
    expect(buildTimeline([{ index: 0, startTick: 0, endTick: bar44 }], [], 60)).toEqual([{ index: 0, startMs: 0, endMs: 4000 }]);
  });
});

describe("barAt", () => {
  const timeline = [
    { index: 0, startMs: 0, endMs: 2000 },
    { index: 1, startMs: 2000, endMs: 4000 },
    { index: 0, startMs: 4000, endMs: 6000 },
    { index: 3, startMs: 6000, endMs: 8000 },
  ];

  it("returns -1 without bars", () => {
    expect(barAt([], 1234)).toBe(-1);
  });

  it("returns the master bar index played at a position", () => {
    expect(barAt(timeline, 0)).toBe(0);
    expect(barAt(timeline, 1999)).toBe(0);
    expect(barAt(timeline, 2000)).toBe(1);
    expect(barAt(timeline, 4500)).toBe(0); // the repeat
    expect(barAt(timeline, 7999.5)).toBe(3);
  });

  it("clamps before the start and after the end", () => {
    expect(barAt(timeline, -500)).toBe(0);
    expect(barAt(timeline, 60_000)).toBe(3);
  });

  it("works with a single bar", () => {
    expect(barAt([{ index: 5, startMs: 0, endMs: 10 }], 10)).toBe(5);
  });
});
