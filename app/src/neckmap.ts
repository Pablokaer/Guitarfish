/**
 * Where a (string, fret) of a real guitar neck falls in a camera image. The neck is
 * flat, so one homography maps it: four points (where the two outer strings cross the
 * nut and the 12th fret, found by neckdetect.ts) fix it, and every other fret follows
 * from the equal-temperament spacing. Pure geometry; fretcam.ts draws with it.
 */

export type Pt = readonly [number, number];
/** Row-major 3×3, with the last entry 1. */
export type Homography = readonly number[];

/**
 * The four calibration points, in this order: nut on the highest string, nut on the
 * lowest string, 12th fret on the highest string, 12th fret on the lowest string.
 */
export type Calibration = readonly [Pt, Pt, Pt, Pt];

/** Distance from the nut to fret `n`, in units of the nut-to-12th-fret distance. */
export function fretDistance(n: number): number {
  return 2 * (1 - 2 ** (-n / 12));
}

// Spread of the outer strings on the neck plane, in the same units (half a scale
// length, ~324 mm on a guitar): ~35 mm at the nut, ~44 mm at the 12th fret.
const SPREAD_NUT = 35 / 324;
const SPREAD_12 = 44 / 324;
const spread = (x: number) => SPREAD_NUT + (SPREAD_12 - SPREAD_NUT) * x;

/** A point on the neck plane: `x` along the neck from the nut, `s` = string (0 = highest, fractional between). */
export function planePoint(x: number, s: number, strings: number): Pt {
  return [x, (s / Math.max(1, strings - 1) - 0.5) * spread(x)];
}

/** Solves for the homography taking each `from[i]` to `to[i]`; null when degenerate. */
export function homography(from: readonly Pt[], to: readonly Pt[]): Homography | null {
  // Two equations per point pair, eight unknowns (h33 = 1).
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 9; k++) a[r][k] -= f * a[c][k];
    }
  }
  return [...a.map((row, i) => row[8] / row[i]), 1];
}

export function apply(h: Homography, [x, y]: Pt): Pt {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** Maps the neck of a `strings`-string guitar into the image the calibration points are in. */
export class NeckMap {
  private inverse: Homography | null = null;

  private constructor(
    private h: Homography,
    readonly strings: number,
  ) {}

  /** Null when the four points don't make a usable quadrilateral. */
  static from(cal: Calibration, strings: number): NeckMap | null {
    const last = strings - 1;
    const plane = [planePoint(0, 0, strings), planePoint(0, last, strings), planePoint(1, 0, strings), planePoint(1, last, strings)];
    const h = homography(plane, cal);
    return h && convex(cal) ? new NeckMap(h, strings) : null;
  }

  /** Image point at `x` (nut = 0, 12th fret = 1) on string `s`. */
  at(x: number, s: number): Pt {
    return apply(this.h, planePoint(x, s, this.strings));
  }

  /** The neck-plane point (x along from the nut, y across) seen at image point `p`. */
  toPlane(p: Pt): Pt {
    if (!this.inverse) {
      const corners: Pt[] = [[0, -0.05], [0, 0.05], [1, -0.06], [1, 0.06]];
      this.inverse = homography(corners.map((c) => apply(this.h, c)), corners);
    }
    return this.inverse ? apply(this.inverse, p) : [NaN, NaN];
  }

  /** Image point of the wire of fret `n` (0 = nut) on string `s`. */
  fret(n: number, s: number): Pt {
    return this.at(fretDistance(n), s);
  }

  /**
   * Where a finger goes for fret `n` on string `s`: just behind the fret wire, or
   * just behind the nut for an open string. `r` is a dot radius that fits there.
   */
  note(s: number, n: number): { p: Pt; r: number } {
    const x = n === 0 ? -0.035 : fretDistance(n - 1) + 0.62 * (fretDistance(n) - fretDistance(n - 1));
    const p = this.at(x, s);
    const across = dist(p, this.at(x, s + (s < this.strings - 1 ? 1 : -1)));
    const along = n === 0 ? across : dist(this.fret(n - 1, s), this.fret(n, s));
    return { p, r: Math.max(5, Math.min(0.42 * across, 0.4 * along, 48)) };
  }
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The quadrilateral nut-high, nut-low, 12-low, 12-high has no crossing or folded sides. */
function convex(cal: Calibration): boolean {
  const quad = [cal[0], cal[1], cal[3], cal[2]];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/** Whether `p` lies inside the polygon (corners going round). */
export function inside(p: Pt, poly: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The polygon grown about its centre by `factor` (1.3 = 30% bigger). */
export function grow(poly: readonly Pt[], factor: number): Pt[] {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor] as const);
}

// ---- Persistence ----------------------------------------------------------------

export interface CamSettings {
  /** Show the picture as a mirror (natural with the front camera). */
  mirror: boolean;
  facing: "user" | "environment";
}

export const DEFAULT_CAM: CamSettings = { mirror: true, facing: "user" };

export function parseCamSettings(raw: unknown): CamSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_CAM };
  const r = raw as Record<string, unknown>;
  return {
    mirror: typeof r.mirror === "boolean" ? r.mirror : DEFAULT_CAM.mirror,
    facing: r.facing === "environment" ? "environment" : "user",
  };
}
