import { describe, expect, it } from "vitest";
import { fitNeck, leastSquaresAffine, leastSquaresHomography, type Cell } from "../src/fretfit";
import { apply, fretDistance, homography, NeckMap, planePoint, type Calibration, type Pt } from "../src/neckmap";

// A neck in the picture: the plane (x along from the nut, y across) mapped by a
// homography with some perspective, nut on the left, low strings up the picture.
const H = homography(
  [[0, -0.07], [0, 0.07], [1, -0.08], [1, 0.08]],
  [[60, 300], [64, 240], [520, 330], [530, 250]],
)!;
const half = (x: number) => (43 / 324 + ((52.5 - 43) / 324) * x) / 2;

/** The cell behind fret n, its corners going round it from an arbitrary one, optionally nudged. */
function cell(n: number, nudge = 0, h = H): Cell {
  const [x0, x1] = [fretDistance(n - 1), fretDistance(n)];
  const round: Pt[] = [apply(h, [x0, -half(x0)]), apply(h, [x1, -half(x1)]), apply(h, [x1, half(x1)]), apply(h, [x0, half(x0)])];
  const corners = [...round.slice(n % 4), ...round.slice(0, n % 4)];
  return { fret: n, corners: corners.map(([x, y]) => [x + nudge, y - nudge] as const), score: 0.9 };
}

function truth(h = H): Calibration {
  const p = (x: number, s: number) => apply(h, planePoint(x, s, 6));
  return [p(0, 0), p(0, 5), p(1, 0), p(1, 5)];
}

function expectNear(a: Calibration, b: Calibration, tol: number) {
  a.forEach((p, i) => expect(Math.hypot(p[0] - b[i][0], p[1] - b[i][1]), `point ${i}`).toBeLessThan(tol));
}

describe("fitNeck", () => {
  it("recovers the neck from a few cells, nut and 12th fret included even if not seen", () => {
    const r = fitNeck([cell(3), cell(4), cell(5), cell(7)], 6)!;
    expect(r.used).toBe(4);
    expect(r.error).toBeLessThan(0.01);
    expectNear(r.calibration, truth(), 0.05);
  });

  it("puts the thin string on the side lower in the picture", () => {
    const r = fitNeck([cell(1), cell(2), cell(3)], 6)!;
    // Highest string (nut-high) below the lowest (nut-low): larger y.
    expect(r.calibration[0][1]).toBeGreaterThan(r.calibration[1][1]);
  });

  it("drops a cell the model numbered wrong", () => {
    const wrong = { ...cell(6), fret: 9 };
    const r = fitNeck([cell(2), cell(3), cell(4), cell(5), wrong, cell(7)], 6)!;
    expect(r.used).toBe(5);
    expectNear(r.calibration, truth(), 0.5);
  });

  it("leaves out cells under the hand while enough others remain", () => {
    // Cell 5 misplaced (the model guessed under a finger), and the hand box over it.
    const guessed = { ...cell(5), corners: cell(5).corners.map(([x, y]) => [x + 4, y + 3] as const) };
    const hand = cell(5).corners;
    const r = fitNeck([cell(2), cell(3), cell(4), guessed, cell(7)], 6, hand)!;
    expect(r.used).toBe(4);
    expectNear(r.calibration, truth(), 0.05);
  });

  it("keeps the most confident of two cells with the same number", () => {
    const r = fitNeck([cell(2), cell(3), { ...cell(5), score: 0.2, fret: 4 }, cell(4), cell(5)], 6)!;
    expect(r.used).toBe(4);
    expectNear(r.calibration, truth(), 0.05);
  });

  it("works with the nut on the right (a mirror picture)", () => {
    const mirror = homography(
      [[0, -0.07], [0, 0.07], [1, -0.08], [1, 0.08]],
      [[580, 300], [576, 240], [120, 330], [110, 250]],
    )!;
    const r = fitNeck([cell(5, 0, mirror), cell(6, 0, mirror), cell(7, 0, mirror), cell(8, 0, mirror)], 6)!;
    expectNear(r.calibration, truth(mirror), 0.05);
  });

  it("places the neck from just two cells, right where they were seen", () => {
    // Only frets 7 and 8 in view (as with the camera close to the neck).
    const r = fitNeck([cell(7), cell(8)], 6)!;
    expect(r.used).toBe(2);
    expect(r.span).toEqual([6, 8]);
    const got = NeckMap.from(r.calibration, 6)!;
    const want = NeckMap.from(truth(), 6)!;
    for (const f of [6, 7, 8]) for (const s of [0, 5]) {
      const [p, q] = [got.fret(f, s), want.fret(f, s)];
      expect(Math.hypot(p[0] - q[0], p[1] - q[1]), `fret ${f}, string ${s}`).toBeLessThan(2.5);
    }
  });

  it("needs at least two cells, and cells that line up", () => {
    expect(fitNeck([cell(7)], 6)).toBeNull();
    // Three cells where one sits on top of another: nothing to trust.
    expect(fitNeck([cell(3), cell(4), { ...cell(3), fret: 8 }], 6)).toBeNull();
  });
});

describe("leastSquaresHomography", () => {
  it("averages out noise over many points", () => {
    const from: Pt[] = [];
    const to: Pt[] = [];
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let i = 0; i < 40; i++) {
      const p: Pt = [(i % 8) / 5, Math.floor(i / 8) / 30 - 0.07];
      from.push(p);
      const q = apply(H, p);
      to.push([q[0] + rand(), q[1] + rand()]);
    }
    const h = leastSquaresHomography(from, to)!;
    const p = apply(h, [0.5, 0]);
    const q = apply(H, [0.5, 0]);
    expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(1);
  });
});

describe("leastSquaresAffine", () => {
  it("recovers an affine map from three or more pairs", () => {
    const m = (p: Pt): Pt => [2 * p[0] - 0.5 * p[1] + 10, 0.3 * p[0] + 1.5 * p[1] - 4];
    const from: Pt[] = [[0, 0], [1, 0], [0, 1], [2, 3]];
    const h = leastSquaresAffine(from, from.map(m))!;
    const q = apply(h, [5, -2]);
    const t = m([5, -2]);
    expect(q[0]).toBeCloseTo(t[0]);
    expect(q[1]).toBeCloseTo(t[1]);
  });
});
