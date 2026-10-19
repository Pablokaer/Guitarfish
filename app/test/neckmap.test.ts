import { describe, expect, it } from "vitest";
import { apply, fretDistance, homography, NeckMap, parseCamSettings, type Calibration } from "../src/neckmap";

describe("fretDistance", () => {
  it("puts the 12th fret halfway along the string and the 24th at three quarters", () => {
    expect(fretDistance(0)).toBe(0);
    expect(fretDistance(12)).toBeCloseTo(1);
    expect(fretDistance(24)).toBeCloseTo(1.5);
    // Each fret is a semitone: the gaps shrink by 2^(1/12).
    const g1 = fretDistance(1) - fretDistance(0);
    const g2 = fretDistance(2) - fretDistance(1);
    expect(g1 / g2).toBeCloseTo(2 ** (1 / 12));
  });
});

describe("homography", () => {
  it("maps the four points exactly and keeps straight lines straight", () => {
    const from = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
    const to = [[10, 20], [200, 40], [30, 180], [220, 260]] as const;
    const h = homography(from, to)!;
    from.forEach((p, i) => {
      const [x, y] = apply(h, p);
      expect(x).toBeCloseTo(to[i][0]);
      expect(y).toBeCloseTo(to[i][1]);
    });
    // The midpoint of a side lands on the image of that side.
    const [a, b, m] = [apply(h, [0, 0]), apply(h, [1, 0]), apply(h, [0.5, 0])];
    const cross = (b[0] - a[0]) * (m[1] - a[1]) - (b[1] - a[1]) * (m[0] - a[0]);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
  });

  it("refuses points that don't span a plane", () => {
    expect(homography([[0, 0], [1, 1], [2, 2], [3, 3]], [[0, 0], [1, 0], [0, 1], [1, 1]])).toBeNull();
  });
});

describe("NeckMap", () => {
  // A neck seen straight on, nut on the left, highest string on top: tapped where the
  // outer strings cross the nut (x 100) and the 12th fret (x 700). The strings spread
  // from 35 mm at the nut to 44 mm at the 12th fret.
  const half12 = (50 * 44) / 35;
  const cal: Calibration = [
    [100, 200],
    [100, 300],
    [700, 250 - half12],
    [700, 250 + half12],
  ];
  const map = NeckMap.from(cal, 6)!;

  it("reproduces the calibration points", () => {
    expect(map.fret(0, 0)[0]).toBeCloseTo(100);
    expect(map.fret(0, 0)[1]).toBeCloseTo(200);
    expect(map.fret(12, 5)[0]).toBeCloseTo(700);
    expect(map.fret(12, 5)[1]).toBeCloseTo(250 + half12);
  });

  it("spaces the frets like a real neck and the strings evenly", () => {
    expect(map.fret(5, 0)[0]).toBeCloseTo(100 + 600 * fretDistance(5));
    expect(map.fret(7, 0)[0]).toBeCloseTo(100 + 600 * fretDistance(7));
    const [, y0] = map.fret(0, 0);
    const [, y1] = map.fret(0, 1);
    const [, y5] = map.fret(0, 5);
    expect(y1 - y0).toBeCloseTo((y5 - y0) / 5);
  });

  it("puts a note just behind its fret, and an open string behind the nut", () => {
    const [x5] = map.note(0, 5).p;
    expect(x5).toBeGreaterThan(map.fret(4, 0)[0]);
    expect(x5).toBeLessThan(map.fret(5, 0)[0]);
    expect(map.note(0, 0).p[0]).toBeLessThan(100);
    // A dot fits between strings 20 px apart.
    expect(map.note(2, 3).r).toBeLessThan(10);
  });

  it("works for any orientation, e.g. a mirrored left-handed neck", () => {
    const flipped = NeckMap.from(cal.map(([x, y]) => [800 - x, y] as const) as unknown as Calibration, 6)!;
    expect(flipped.fret(5, 0)[0]).toBeCloseTo(800 - map.fret(5, 0)[0]);
  });

  it("maps picture points back onto the neck plane", () => {
    const p = map.at(0.4, 2);
    const [x] = map.toPlane(p);
    expect(x).toBeCloseTo(0.4, 6);
  });

  it("rejects marks tapped in the wrong order", () => {
    expect(NeckMap.from([cal[0], cal[3], cal[2], cal[1]], 6)).toBeNull();
  });
});

describe("parseCamSettings", () => {
  it("keeps valid settings and drops the rest", () => {
    expect(parseCamSettings({ mirror: false, facing: "environment" })).toEqual({ mirror: false, facing: "environment" });
    expect(parseCamSettings({ mirror: "yes", facing: "side", calibration: [[0, 0]] })).toEqual({ mirror: true, facing: "user" });
    expect(parseCamSettings(null)).toEqual({ mirror: true, facing: "user" });
  });
});
