import { leastSquaresAffine, leastSquaresHomography } from "./fretfit";
import { apply, homography, inside, type Homography, type Pt } from "./neckmap";

/**
 * Follows the neck from one camera frame to the next, between the model's answers
 * (a few a second, and late): points on the fretboard are tracked by pyramidal
 * Lucas–Kanade optical flow, and the neck moves by the homography that best explains
 * where they went. The fretting hand moves on its own and must never drag the neck:
 * - points are spread along the whole board, a few per fret, so a hand covering two
 *   or three frets is always outnumbered (and none are taken where the model sees it);
 * - in the vote (RANSAC) a point counts more the longer it has moved with the neck,
 *   and "the neck didn't move" is always one of the candidates;
 * - motions a rigid neck can't make in one frame (shrinking, stretching) are refused.
 * Pure image maths on grey frames; fretcam.ts feeds it every video frame.
 */

export interface GrayFrame {
  width: number;
  height: number;
  /** Luminance 0…255, row by row. */
  data: Float32Array;
}

const LEVELS = 3;
/** Half the side of the window compared around each point, in pixels at each level. */
const HALF = 5;
const ITERATIONS = 10;
/** A point tracked forward then back must come home within this, in pixels. */
const FB_MAX = 1;
/** A point fits the neck's motion within this, in pixels. */
const INLIER = 1.5;
/** At most this many points are followed. */
const MAX_POINTS = 160;
/** New points keep this far from the ones already followed, in pixels. */
const SPACING = 4;
/** A point's vote grows with the frames it has moved with the neck, up to this. */
const MAX_AGE = 15;
/** A point is settled once it has moved with the neck this many frames. */
const SETTLED = 10;

/** A frame and its smaller copies, each half the size of the last. */
export function pyramid(f: GrayFrame, levels = LEVELS): GrayFrame[] {
  const out = [f];
  for (let l = 1; l < levels; l++) {
    const p = out[l - 1];
    const w = p.width >> 1;
    const h = p.height >> 1;
    if (w < 2 * HALF + 4 || h < 2 * HALF + 4) break;
    const d = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = 2 * y * p.width + 2 * x;
        d[y * w + x] = (p.data[i] + p.data[i + 1] + p.data[i + p.width] + p.data[i + p.width + 1]) / 4;
      }
    }
    out.push({ width: w, height: h, data: d });
  }
  return out;
}

function sample(f: GrayFrame, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= f.width - 1 || y0 >= f.height - 1) return NaN;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * f.width + x0;
  const d = f.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + f.width] * (1 - fx) + d[i + f.width + 1] * fx) * fy;
}

/**
 * Where point `p` of frame `a` went in frame `b` (both pyramids), or null when it
 * can't be followed (no texture, or out of the picture).
 */
export function flow(a: GrayFrame[], b: GrayFrame[], p: Pt): Pt | null {
  const levels = Math.min(a.length, b.length);
  let dx = 0;
  let dy = 0;
  for (let l = levels - 1; l >= 0; l--) {
    const A = a[l];
    const B = b[l];
    const s = 1 / (1 << l);
    const px = p[0] * s;
    const py = p[1] * s;
    if (l < levels - 1) {
      dx *= 2;
      dy *= 2;
    }
    // Gradients of the window in the first frame (fixed for this level).
    const n = (2 * HALF + 1) ** 2;
    const gx = new Float32Array(n);
    const gy = new Float32Array(n);
    const iv = new Float32Array(n);
    let gxx = 0;
    let gxy = 0;
    let gyy = 0;
    let k = 0;
    for (let wy = -HALF; wy <= HALF; wy++) {
      for (let wx = -HALF; wx <= HALF; wx++, k++) {
        const x = px + wx;
        const y = py + wy;
        const v = sample(A, x, y);
        const ddx = (sample(A, x + 1, y) - sample(A, x - 1, y)) / 2;
        const ddy = (sample(A, x, y + 1) - sample(A, x, y - 1)) / 2;
        if (!Number.isFinite(v) || !Number.isFinite(ddx) || !Number.isFinite(ddy)) return null;
        iv[k] = v;
        gx[k] = ddx;
        gy[k] = ddy;
        gxx += ddx * ddx;
        gxy += ddx * ddy;
        gyy += ddy * ddy;
      }
    }
    const det = gxx * gyy - gxy * gxy;
    // Too flat to tell where it went (smallest eigenvalue, per window pixel).
    const minEig = (gxx + gyy - Math.sqrt((gxx - gyy) ** 2 + 4 * gxy * gxy)) / 2 / n;
    if (det < 1e-6 || minEig < 1e-3) return null;
    for (let it = 0; it < ITERATIONS; it++) {
      let bx = 0;
      let by = 0;
      k = 0;
      for (let wy = -HALF; wy <= HALF; wy++) {
        for (let wx = -HALF; wx <= HALF; wx++, k++) {
          const v = sample(B, px + dx + wx, py + dy + wy);
          if (!Number.isFinite(v)) return null;
          const diff = iv[k] - v;
          bx += diff * gx[k];
          by += diff * gy[k];
        }
      }
      const ux = (gyy * bx - gxy * by) / det;
      const uy = (gxx * by - gxy * bx) / det;
      dx += ux;
      dy += uy;
      if (ux * ux + uy * uy < 0.01 * 0.01) break;
    }
  }
  return [p[0] + dx, p[1] + dy];
}

/** How trackable point `p` is: the window's smallest gradient eigenvalue, per pixel. */
export function cornerness(f: GrayFrame, p: Pt): number {
  let gxx = 0;
  let gxy = 0;
  let gyy = 0;
  let n = 0;
  for (let wy = -HALF; wy <= HALF; wy++) {
    for (let wx = -HALF; wx <= HALF; wx++) {
      const x = p[0] + wx;
      const y = p[1] + wy;
      const ddx = (sample(f, x + 1, y) - sample(f, x - 1, y)) / 2;
      const ddy = (sample(f, x, y + 1) - sample(f, x, y - 1)) / 2;
      if (!Number.isFinite(ddx) || !Number.isFinite(ddy)) return 0;
      gxx += ddx * ddx;
      gxy += ddx * ddy;
      gyy += ddy * ddy;
      n++;
    }
  }
  return (gxx + gyy - Math.sqrt((gxx - gyy) ** 2 + 4 * gxy * gxy)) / 2 / n;
}

/**
 * The homography that moves most `from` points onto their `to` (RANSAC over four-point
 * samples, then least squares on the agreeing ones), and how many agreed.
 */
export function robustHomography(
  from: readonly Pt[],
  to: readonly Pt[],
  rand = Math.random,
  weights: readonly number[] = from.map(() => 1),
  plausible: (h: Homography) => boolean = () => true,
  affine = false,
): { h: Homography; inliers: number } | null {
  const n = from.length;
  const sample = affine ? 3 : 4;
  if (n < sample) return null;
  const total = weights.reduce((s, w) => s + w, 0);
  let best: number[] = [];
  let bestWeight = 0;
  let bestH: Homography | null = null;
  for (let it = 0; it < 150; it++) {
    let h: Homography | null;
    if (it === 0) {
      // Standing still is the likeliest motion: always weigh it.
      h = IDENTITY;
    } else {
      const pick = new Set<number>();
      while (pick.size < sample) pick.add(Math.floor(rand() * n));
      const idx = [...pick];
      h = affine ? leastSquaresAffine(idx.map((i) => from[i]), idx.map((i) => to[i])) : homography(idx.map((i) => from[i]), idx.map((i) => to[i]));
    }
    if (!h || !plausible(h)) continue;
    const ins: number[] = [];
    let w = 0;
    for (let i = 0; i < n; i++) {
      const q = apply(h, from[i]);
      if (Math.hypot(q[0] - to[i][0], q[1] - to[i][1]) < INLIER) {
        ins.push(i);
        w += weights[i];
      }
    }
    if (w > bestWeight) [best, bestWeight, bestH] = [ins, w, h];
    if (bestWeight > 0.9 * total) break;
  }
  if (best.length < 6) return null;
  const fit = affine ? leastSquaresAffine : leastSquaresHomography;
  const h = fit(best.map((i) => from[i]), best.map((i) => to[i]));
  // If refining over all the agreeing points goes out of bounds, the best sample still stands.
  if (h && plausible(h)) return { h, inliers: best.length };
  return bestH ? { h: bestH, inliers: best.length } : null;
}

/** Points followed from frame to frame. */
export class Tracker {
  private prev: GrayFrame[] | null = null;
  private prevFrame: GrayFrame | null = null;
  private points: Pt[] = [];
  /** Frames each point has moved with the neck. */
  private ages: number[] = [];
  private seed = 1;

  get size(): number {
    return this.points.length;
  }

  /** Points that have moved with the neck for at least SETTLED frames. */
  get settledPoints(): number {
    return this.ages.filter((a) => a >= SETTLED).length;
  }

  /** The points being followed (for tests and drawing). */
  get tracked(): readonly Pt[] {
    return this.points;
  }

  /** Starts over with the trackable ones among `candidates`, in `frame`. */
  reset(frame: GrayFrame, candidates: readonly Pt[], minCorner = 4): void {
    this.points = [];
    this.ages = [];
    this.add(frame, [candidates], null, minCorner);
  }

  /**
   * Adds the most trackable of `candidates` (not under `avoid`, not crowding the points
   * already followed). Candidates come in groups (one per fret): each group gets at most
   * its share of MAX_POINTS, so the points spread along the neck and no single strongly
   * textured spot (a hand) holds most of them. The points already followed keep their votes.
   */
  add(frame: GrayFrame, groups: readonly (readonly Pt[])[], avoid: readonly Pt[] | null, minCorner = 4, covered: (p: Pt) => boolean = () => false): void {
    if (this.prevFrame !== frame) {
      this.prev = pyramid(frame);
      this.prevFrame = frame;
    }
    // Shared among the groups that are in the picture at all: with a few frets in view, they get it all.
    const inPicture = (p: Pt) => p[0] >= 0 && p[1] >= 0 && p[0] < frame.width && p[1] < frame.height;
    const live = groups.filter((g) => g.some(inPicture)).length;
    const share = Math.max(2, Math.floor(MAX_POINTS / Math.max(1, live)));
    for (const group of groups) {
      // Points already followed in this group's area count towards its share.
      let have = this.points.filter((q) => group.some((p) => Math.abs(q[0] - p[0]) < 2 * SPACING && Math.abs(q[1] - p[1]) < 2 * SPACING)).length;
      const fresh = group
        .filter((p) => (!avoid || !inside(p, avoid)) && !covered(p))
        .map((p) => ({ p, c: cornerness(frame, p) }))
        .filter((x) => x.c >= minCorner)
        .sort((a, b) => b.c - a.c);
      for (const { p } of fresh) {
        if (have >= share || this.points.length >= MAX_POINTS) break;
        if (this.points.some((q) => Math.abs(q[0] - p[0]) < SPACING && Math.abs(q[1] - p[1]) < SPACING)) continue;
        this.points.push(p);
        this.ages.push(0);
        have++;
      }
    }
  }

  /** Stops following the points under `area` (where the hand is now). */
  drop(area: readonly Pt[]): void {
    const keep = this.points.map((p) => !inside(p, area));
    this.points = this.points.filter((_, i) => keep[i]);
    this.ages = this.ages.filter((_, i) => keep[i]);
  }

  /**
   * Follows the points into `frame`: the motion since the last frame as a homography,
   * or null when too few points could be followed (the neck is lost to the tracker).
   * `plausible` refuses motions the neck can't make; points that land on something
   * `covered` (a hand in front of the board) are dropped before they can vote.
   */
  next(frame: GrayFrame, plausible?: (h: Homography) => boolean, covered: (p: Pt) => boolean = () => false, affine = false): Homography | null {
    const cur = pyramid(frame);
    const prev = this.prev;
    this.prev = cur;
    this.prevFrame = frame;
    if (!prev || this.points.length < 6) {
      this.points = [];
      this.ages = [];
      return null;
    }
    const from: Pt[] = [];
    const to: Pt[] = [];
    const ages: number[] = [];
    this.points.forEach((p, i) => {
      const q = flow(prev, cur, p);
      if (!q || covered(q)) return;
      // Followed back, it must land where it started.
      const back = flow(cur, prev, q);
      if (!back || Math.hypot(back[0] - p[0], back[1] - p[1]) > FB_MAX) return;
      from.push(p);
      to.push(q);
      ages.push(this.ages[i]);
    });
    const r = robustHomography(
      from,
      to,
      () => ((this.seed = (this.seed * 16807) % 2147483647) / 2147483647),
      ages.map((a) => 1 + Math.min(a, MAX_AGE)),
      plausible,
      affine,
    );
    if (!r) {
      this.points = [];
      this.ages = [];
      return null;
    }
    // Keep the points that moved with the neck, where they are now, a frame older.
    const keep = to.map((q, i) => {
      const m = apply(r.h, from[i]);
      return Math.hypot(m[0] - q[0], m[1] - q[1]) < INLIER;
    });
    this.points = to.filter((_, i) => keep[i]);
    this.ages = ages.filter((_, i) => keep[i]).map((a) => a + 1);
    return r.h;
  }
}

/**
 * Whether `h` is a motion a rigid neck (outer strings at `nutHigh`, `nutLow`, `farHigh`,
 * `farLow`) can make between two frames: it may slide and turn, but its length and
 * width hardly change, and it can't jump far.
 */
export function rigidNeck(corners: readonly Pt[], maxScale = 0.03, maxShift = 0.25): (h: Homography) => boolean {
  const len = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const [nh, nl, fh, fl] = corners;
  const length = (len(nh, fh) + len(nl, fl)) / 2;
  const nutW = len(nh, nl);
  const farW = len(fh, fl);
  return (h) => {
    const [a, b, c, d] = corners.map((p) => apply(h, p));
    const ok = (now: number, was: number, tol: number) => was > 0 && Math.abs(now / was - 1) <= tol;
    return (
      ok((len(a, c) + len(b, d)) / 2, length, maxScale) &&
      ok(len(a, b), nutW, 2 * maxScale) &&
      ok(len(c, d), farW, 2 * maxScale) &&
      corners.every((p, i) => len(p, [a, b, c, d][i]) <= maxShift * length)
    );
  };
}

/** a·b: first b, then a. */
export function compose(a: Homography, b: Homography): Homography {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out.map((v) => v / out[8]);
}

export const IDENTITY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];
