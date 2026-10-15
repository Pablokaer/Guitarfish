import { describe, expect, it } from "vitest";
import { barAt, barStarts, TICKS_PER_QUARTER } from "../src/timeline";

const bar44 = 4 * TICKS_PER_QUARTER; // one 4/4 bar

describe("barStarts", () => {
  it("is empty for a score without bars", () => {
    expect(barStarts(120, [])).toEqual([]);
  });

  it("spaces 4/4 bars by the score tempo", () => {
    // 120 bpm: a quarter is 500 ms, a 4/4 bar 2 s.
    expect(barStarts(120, [{ ticks: bar44 }, { ticks: bar44 }, { ticks: bar44 }])).toEqual([0, 2000, 4000]);
  });

  it("uses each bar's length in ticks (time signature changes)", () => {
    const bar34 = 3 * TICKS_PER_QUARTER;
    expect(barStarts(60, [{ ticks: bar34 }, { ticks: bar44 }, { ticks: bar34 }])).toEqual([0, 3000, 7000]);
  });

  it("defaults to 120 bpm when the score has no tempo", () => {
    expect(barStarts(0, [{ ticks: bar44 }, { ticks: bar44 }])).toEqual([0, 2000]);
  });

  it("applies a tempo automation from its bar onwards", () => {
    const starts = barStarts(120, [{ ticks: bar44 }, { ticks: bar44, tempo: 60 }, { ticks: bar44 }, { ticks: bar44 }]);
    // Bar 0 at 120 bpm (2 s), bars 1 and 2 at 60 bpm (4 s each).
    expect(starts).toEqual([0, 2000, 6000, 10000]);
  });

  it("ignores missing or non-positive automations", () => {
    expect(barStarts(120, [{ ticks: bar44, tempo: null }, { ticks: bar44, tempo: 0 }, { ticks: bar44, tempo: -5 }])).toEqual([0, 2000, 4000]);
  });
});

describe("barAt", () => {
  const starts = [0, 2000, 4000, 6000];

  it("returns -1 without bars", () => {
    expect(barAt([], 1234)).toBe(-1);
  });

  it("finds the bar playing at a position", () => {
    expect(barAt(starts, 0)).toBe(0);
    expect(barAt(starts, 1999)).toBe(0);
    expect(barAt(starts, 2000)).toBe(1);
    expect(barAt(starts, 5999.5)).toBe(2);
  });

  it("clamps before the start and after the end", () => {
    expect(barAt(starts, -500)).toBe(0);
    expect(barAt(starts, 60_000)).toBe(3);
  });

  it("works with a single bar", () => {
    expect(barAt([0], 10)).toBe(0);
  });
});
