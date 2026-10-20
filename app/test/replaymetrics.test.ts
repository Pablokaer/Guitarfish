import { describe, expect, it } from "vitest";
import type { Pt } from "../src/neckmap";
import { percentile, summarize, type Sample } from "../src/replaymetrics";

// A neck 200 px long (nut at x 0, 12th fret at x 200), slid `dx` px.
const neck = (dx = 0, dy = 0): Pt[] => [[dx, 10 + dy], [dx, -10 + dy], [200 + dx, 12 + dy], [200 + dx, -12 + dy]];
const NO = { ok: 0, noNeck: 0, fewFrets: 0, failed: 0 };
const at = (i: number) => i * 33;

describe("summarize", () => {
  it("a neck held still all along: shown, no shake, no jumps", () => {
    const samples: Sample[] = Array.from({ length: 30 }, (_, i) => ({ at: at(i), neck: neck(), locked: i >= 10 }));
    const s = summarize(samples, NO, []);
    expect(s.shown).toBe(1);
    expect(s.locked).toBeCloseTo(20 / 30);
    expect(s.firstLock).toBeCloseTo(0.33);
    expect(s.losses).toBe(0);
    expect(s.jitter.median).toBe(0);
    expect(s.jumps).toBe(0);
  });

  it("a neck sliding steadily doesn't count as shake", () => {
    const samples: Sample[] = Array.from({ length: 30 }, (_, i) => ({ at: at(i), neck: neck(i * 3), locked: true }));
    expect(summarize(samples, NO, []).jitter.p95).toBeCloseTo(0, 6);
  });

  it("shaking back and forth does", () => {
    const samples: Sample[] = Array.from({ length: 30 }, (_, i) => ({ at: at(i), neck: neck(0, i % 2 ? 2 : -2), locked: true }));
    // 2 px either way of a 200 px neck: about 1% off the average of its neighbours.
    expect(summarize(samples, NO, []).jitter.median).toBeGreaterThan(0.8);
  });

  it("counts losses, the longest gap and jumps", () => {
    const samples: Sample[] = [];
    for (let i = 0; i < 40; i++) {
      const gone = (i >= 10 && i < 20) || (i >= 25 && i < 28);
      samples.push({ at: at(i), neck: gone ? null : neck(i >= 20 ? 50 : 0), locked: false });
    }
    const s = summarize(samples, NO, []);
    expect(s.losses).toBe(2);
    expect(s.longestGap).toBeCloseTo((10 * 33) / 1000);
    // Back at frame 20 somewhere else is no jump (nothing the frame before); only moving while shown is.
    expect(s.jumps).toBe(0);
    samples[30] = { ...samples[30], neck: neck(100) };
    expect(summarize(samples, NO, []).jumps).toBe(2);
  });

  it("the model's disagreement: median, p95 and the share past a near answer", () => {
    const s = summarize([], NO, [0.1, 0.1, 0.2, 0.5, 1.2]);
    expect(s.disagree.median).toBe(0.2);
    expect(s.disagree.p95).toBe(1.2);
    expect(s.disagree.over).toBeCloseTo(0.4);
  });
});

describe("percentile", () => {
  it("is NaN for nothing", () => expect(percentile([], 0.5)).toBeNaN());
});
