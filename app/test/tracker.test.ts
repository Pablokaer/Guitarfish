import { describe, expect, it } from "vitest";
import { apply, homography, type Homography, type Pt } from "../src/neckmap";
import { compose, cornerness, flow, IDENTITY, pyramid, rigidNeck, robustHomography, Tracker, type GrayFrame } from "../src/tracker";

/** A smooth random texture (sums of blurred blobs), seeded. */
function texture(w: number, h: number, seed = 3): (x: number, y: number) => number {
  const blobs: [number, number, number, number][] = [];
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 400; i++) blobs.push([r() * w * 1.4 - 0.2 * w, r() * h * 1.4 - 0.2 * h, 3 + r() * 6, (r() - 0.5) * 180]);
  return (x, y) => {
    let v = 128;
    for (const [bx, by, rad, a] of blobs) {
      const d2 = (x - bx) ** 2 + (y - by) ** 2;
      if (d2 < 9 * rad * rad) v += a * Math.exp(-d2 / (2 * rad * rad));
    }
    return v;
  };
}

/** The texture seen through `h` (frame pixel → texture point is h⁻¹, so warp by the inverse). */
function frame(tex: (x: number, y: number) => number, w: number, hgt: number, inv: Homography = IDENTITY): GrayFrame {
  const data = new Float32Array(w * hgt);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { const [u, v] = apply(inv, [x, y]); data[y * w + x] = tex(u, v); }
  return { width: w, height: hgt, data };
}

const W = 160, H = 120;
const tex = texture(W, H);
const grid: Pt[] = [];
for (let y = 20; y < H - 20; y += 10) for (let x = 20; x < W - 20; x += 10) grid.push([x, y]);

describe("flow", () => {
  it("follows a point that moved a few pixels", () => {
    const a = pyramid(frame(tex, W, H));
    const b = pyramid(frame(tex, W, H, [1, 0, -4.3, 0, 1, 2.6, 0, 0, 1])); // moved by (+4.3, −2.6)
    const tracked = grid.map((p) => [p, flow(a, b, p)] as const).filter(([, q]) => q);
    expect(tracked.length).toBeGreaterThan(grid.length / 2);
    for (const [p, q] of tracked.slice(0, 10)) {
      expect(q![0] - p[0]).toBeCloseTo(4.3, 0);
      expect(q![1] - p[1]).toBeCloseTo(-2.6, 0);
    }
  });

  it("gives up on a flat patch", () => {
    const flat: GrayFrame = { width: W, height: H, data: new Float32Array(W * H).fill(100) };
    const p = pyramid(flat);
    expect(flow(p, p, [80, 60])).toBeNull();
    expect(cornerness(flat, [80, 60])).toBe(0);
  });
});

describe("robustHomography", () => {
  it("finds the motion despite points that went elsewhere", () => {
    const h = homography([[0, 0], [100, 0], [0, 100], [100, 100]], [[3, 2], [104, -1], [1, 103], [99, 98]])!;
    const from = grid;
    const to = from.map((p, i) => (i % 5 === 0 ? ([p[0] + 20, p[1] - 15] as Pt) : apply(h, p)));
    const r = robustHomography(from, to)!;
    expect(r.inliers).toBe(from.length - Math.ceil(from.length / 5));
    const q = apply(r.h, [50, 50]);
    const t = apply(h, [50, 50]);
    expect(Math.hypot(q[0] - t[0], q[1] - t[1])).toBeLessThan(0.1);
  });
});

describe("Tracker", () => {
  it("follows the picture as it turns and slides, frame by frame", () => {
    const tr = new Tracker();
    tr.reset(frame(tex, W, H), grid);
    expect(tr.size).toBeGreaterThan(20);
    // Five frames, each turned 1° about the centre and slid 2 px right.
    let total = IDENTITY;
    let truth = IDENTITY;
    for (let i = 1; i <= 5; i++) {
      const a = (i * Math.PI) / 180;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      const m: Homography = [c, -s, 80 - 80 * c + 60 * s + 2 * i, s, c, 60 - 80 * s - 60 * c, 0, 0, 1];
      const inv = homography([[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => apply(m, p as Pt)), [[0, 0], [1, 0], [0, 1], [1, 1]])!;
      const step = tr.next(frame(tex, W, H, inv));
      expect(step).not.toBeNull();
      total = compose(step!, total);
      truth = m;
    }
    for (const p of [[40, 40], [120, 80]] as Pt[]) {
      const q = apply(total, p);
      const t = apply(truth, p);
      expect(Math.hypot(q[0] - t[0], q[1] - t[1])).toBeLessThan(1);
    }
  });

  it("loses the neck when the picture changes completely", () => {
    const tr = new Tracker();
    tr.reset(frame(tex, W, H), grid);
    expect(tr.next(frame(texture(W, H, 99), W, H))).toBeNull();
    expect(tr.size).toBe(0);
  });
});

describe("against a hand moving over a still neck", () => {
  it("prefers standing still when the old points stayed put, even if more new ones moved", () => {
    const from = grid;
    // A third of the points are old and stayed; the rest are new (on a hand) and all slid 6 px together.
    const old = (i: number) => i % 3 === 0;
    const to = from.map((p, i) => (old(i) ? p : ([p[0] + 6, p[1]] as Pt)));
    const weights = from.map((_, i) => (old(i) ? 16 : 1));
    const r = robustHomography(from, to, Math.random, weights)!;
    const q = apply(r.h, [80, 60]);
    expect(Math.hypot(q[0] - 80, q[1] - 60)).toBeLessThan(0.01);
  });

  it("refuses a motion that would shrink or stretch the neck", () => {
    const neck: Pt[] = [[100, 120], [100, 80], [500, 130], [500, 70]];
    const ok = rigidNeck(neck);
    expect(ok(IDENTITY)).toBe(true);
    expect(ok([1, 0, 5, 0, 1, -3, 0, 0, 1])).toBe(true); // slid a little
    expect(ok([0.9, 0, 30, 0, 0.9, 10, 0, 0, 1])).toBe(false); // 10% smaller
    expect(ok([1, 0, 300, 0, 1, 0, 0, 0, 1])).toBe(false); // jumped
  });

  it("spreads new points over the groups instead of piling them where the texture is strongest", () => {
    // Left half: strong texture; right half: weak. Two groups.
    const strong = texture(W, H, 7);
    const f = frame((x, y) => (x < W / 2 ? strong(x, y) : 128 + (strong(x, y) - 128) * 0.25), W, H);
    const left = grid.filter((p) => p[0] < W / 2);
    const right = grid.filter((p) => p[0] >= W / 2);
    const tr = new Tracker();
    tr.add(f, [left, right], null, 0.5);
    const onRight = tr.tracked.filter((p) => p[0] >= W / 2).length;
    expect(onRight).toBeGreaterThan(5);
    expect(tr.tracked.filter((p) => p[0] < W / 2).length).toBeLessThanOrEqual(80);
  });

  it("drops points where the hand now is", () => {
    const tr = new Tracker();
    tr.reset(frame(tex, W, H), grid);
    const before = tr.size;
    tr.drop([[0, 0], [80, 0], [80, H], [0, H]]);
    expect(tr.size).toBeLessThan(before);
    expect(tr.tracked.every((p) => p[0] >= 80)).toBe(true);
  });
});
