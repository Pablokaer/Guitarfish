import { describe, expect, it } from "vitest";
import { CLASS_FRET, corners, decodeCells, decodeHand, MODEL_SIZE, toInput } from "../src/fretmodel";

const CHANNELS = 4 + CLASS_FRET.length + 1;
const ANCHORS = 10;

/** An output tensor with the given boxes: [anchor, class index, score, cx, cy, w, h, angle]. */
function output(boxes: [number, number, number, number, number, number, number, number][]): Float32Array {
  const out = new Float32Array(CHANNELS * ANCHORS);
  for (const [i, c, score, cx, cy, w, h, angle] of boxes) {
    out[0 * ANCHORS + i] = cx;
    out[1 * ANCHORS + i] = cy;
    out[2 * ANCHORS + i] = w;
    out[3 * ANCHORS + i] = h;
    out[(4 + c) * ANCHORS + i] = score;
    out[(CHANNELS - 1) * ANCHORS + i] = angle;
  }
  return out;
}

describe("decodeCells", () => {
  it("keeps the best box of each fret number and drops the hand and weak boxes", () => {
    const fret5 = CLASS_FRET.indexOf(5);
    const fret12 = CLASS_FRET.indexOf(12);
    const hand = CLASS_FRET.indexOf(0);
    const cells = decodeCells(
      output([
        [1, fret5, 0.5, 10, 10, 4, 4, 0],
        [3, fret5, 0.8, 100, 50, 20, 10, 0],
        [4, fret12, 0.2, 300, 60, 8, 10, 0],
        [6, hand, 0.9, 200, 200, 50, 50, 0],
      ]),
      CHANNELS,
      ANCHORS,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0].fret).toBe(5);
    expect(cells[0].score).toBeCloseTo(0.8);
    expect(cells[0].corners).toEqual([
      [110, 55],
      [110, 45],
      [90, 45],
      [90, 55],
    ]);
  });
});

describe("corners", () => {
  it("turns with the angle and goes round the box", () => {
    const [a, b, c, d] = corners(0, 0, 20, 10, Math.PI / 2);
    expect(a[0]).toBeCloseTo(-5);
    expect(a[1]).toBeCloseTo(10);
    expect(b[0]).toBeCloseTo(5);
    expect(b[1]).toBeCloseTo(10);
    expect(c[0]).toBeCloseTo(5);
    expect(c[1]).toBeCloseTo(-10);
    expect(d[0]).toBeCloseTo(-5);
    expect(d[1]).toBeCloseTo(-10);
  });
});

describe("toInput", () => {
  it("splits RGBA into RGB planes from 0 to 1", () => {
    const rgba = new Uint8ClampedArray(MODEL_SIZE * MODEL_SIZE * 4);
    rgba.set([255, 0, 51, 255], 0);
    const t = toInput(rgba);
    const n = MODEL_SIZE * MODEL_SIZE;
    expect(t[0]).toBe(1);
    expect(t[n]).toBe(0);
    expect(t[2 * n]).toBeCloseTo(0.2);
  });
});

describe("decodeHand", () => {
  it("gives the hand's best box, or nothing below the threshold", () => {
    const hand = CLASS_FRET.indexOf(0);
    const out = output([
      [2, hand, 0.3, 50, 50, 10, 10, 0],
      [5, hand, 0.7, 200, 100, 40, 20, 0],
    ]);
    expect(decodeHand(out, CHANNELS, ANCHORS)).toEqual([
      [220, 110],
      [220, 90],
      [180, 90],
      [180, 110],
    ]);
    expect(decodeHand(output([[2, hand, 0.3, 50, 50, 10, 10, 0]]), CHANNELS, ANCHORS)).toBeNull();
  });
});
