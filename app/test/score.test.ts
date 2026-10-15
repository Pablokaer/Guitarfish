import * as alphaTab from "@coderline/alphatab";
import { describe, expect, it } from "vitest";
import { playOrder, scoreTimeline, staffTuning } from "../src/score";
import { barAt } from "../src/timeline";

const load = (tex: string) => alphaTab.importer.ScoreLoader.loadAlphaTex(tex, new alphaTab.Settings());
/** Master bar indexes in play order. */
const order = (tex: string) => playOrder(load(tex)).bars.map((b) => b.index);

describe("playOrder", () => {
  it("plays bars in score order without repeats", () => {
    expect(order(`. 1.1.1 | 2.1.1 | 3.1.1`)).toEqual([0, 1, 2]);
  });

  it("expands a repeated section", () => {
    expect(order(`. \\ro 1.1.1 | 2.1.1 | \\rc 2 3.1.1 | 4.1.1`)).toEqual([0, 1, 2, 0, 1, 2, 3]);
  });

  it("plays each alternate ending on its pass", () => {
    expect(order(`. \\ro 1.1.1 | \\ae 1 \\rc 2 2.1.1 | \\ae 2 3.1.1 | 4.1.1`)).toEqual([0, 1, 0, 2, 3]);
  });

  it("follows Dal Segno al Fine", () => {
    expect(order(`. 1.1.1 | \\jump Segno 2.1.1 | \\jump Fine 3.1.1 | \\jump DalSegnoAlFine 4.1.1 | 5.1.1`)).toEqual([0, 1, 2, 3, 1, 2]);
  });

  it("follows Da Capo al Coda", () => {
    expect(order(`. 1.1.1 | \\jump DaCoda 2.1.1 | \\jump DaCapoAlCoda 3.1.1 | \\jump Coda 4.1.1`)).toEqual([0, 1, 2, 0, 1, 3]);
  });

  it("gives ticks in play order and every tempo change at its tick", () => {
    const { bars, tempos } = playOrder(load(`\\tempo 120 . 1.1.4 1.1.4 {tempo 60} 1.1.4 1.1.4 | 2.1.1`));
    expect(bars).toEqual([
      { index: 0, startTick: 0, endTick: 3840 },
      { index: 1, startTick: 3840, endTick: 7680 },
    ]);
    expect(tempos).toContainEqual({ tick: 960, bpm: 60 });
    expect(tempos[0]).toEqual({ tick: 0, bpm: 120 });
  });
});

describe("scoreTimeline", () => {
  it("times a repeated chorus so the second pass maps back to its bars", () => {
    // 4/4 at 120 bpm: 2 s per bar. Play order 0 1 2 0 1 2 3.
    const timeline = scoreTimeline(load(`\\tempo 120 . \\ro 1.1.1 | 2.1.1 | \\rc 2 3.1.1 | 4.1.1`));
    expect(timeline.map((t) => t.startMs)).toEqual([0, 2000, 4000, 6000, 8000, 10000, 12000]);
    expect(barAt(timeline, 6500)).toBe(0);
    expect(barAt(timeline, 11_999)).toBe(2);
    expect(barAt(timeline, 12_000)).toBe(3);
  });

  it("switches tempo inside the bar", () => {
    // One quarter at 120 (500 ms) + three at 60 (3 s): bar 1 starts at 3.5 s.
    const timeline = scoreTimeline(load(`\\tempo 120 . 1.1.4 1.1.4 {tempo 60} 1.1.4 1.1.4 | 2.1.1`));
    expect(timeline[1].startMs).toBe(3500);
    expect(barAt(timeline, 3499)).toBe(0);
    expect(barAt(timeline, 3500)).toBe(1);
  });
});

describe("staffTuning", () => {
  it("reads the first staff's tuning (string 1 first) and capo", () => {
    expect(staffTuning(load(`\\tuning e4 b3 g3 d3 a2 d2 \\capo 3 . 1.1.1`), 0)).toEqual({ pitches: [64, 59, 55, 50, 45, 38], capo: 3 });
  });

  it("defaults to standard tuning without capo", () => {
    expect(staffTuning(load(`. 1.1.1`), 0)).toEqual({ pitches: [64, 59, 55, 50, 45, 40], capo: 0 });
  });

  it("is null for a missing track", () => {
    expect(staffTuning(load(`. 1.1.1`), 3)).toBeNull();
  });
});
