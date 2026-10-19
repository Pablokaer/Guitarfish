import { apply, fretDistance, inside, planePoint, type Calibration, type Homography, type Pt } from "./neckmap";

/**
 * Fits the neck to the fret cells the model found: each cell is the fretboard between
 * two fret wires, known by number (cell n lies behind fret n), with its four corners.
 * Every corner is a point whose place on the neck is known, so one homography through
 * all of them (least squares, dropping cells that disagree) maps the whole neck.
 */

export interface Cell {
  /** 1 = the cell between the nut and the 1st fret. */
  fret: number;
  corners: readonly Pt[];
  score: number;
}

export interface NeckFit {
  /** Nut-high, nut-low, 12th-high, 12th-low (neckmap.ts), in the cells' pixels. */
  calibration: Calibration;
  /** The fret wires the cells the fit kept lie between (lowest, highest): where it was seen. */
  span: [number, number];
  /** Cells the fit kept. */
  used: number;
  /** Mean distance from a corner to where the fit puts it, in pixels. */
  error: number;
}

// Fretboard width (the cells' long sides), in the units of neckmap.ts (half a scale
// length, ~324 mm): ~43 mm at the nut, ~52.5 mm at the 12th fret.
const BOARD_NUT = 43 / 324;
const BOARD_12 = 52.5 / 324;
const boardHalf = (x: number) => (BOARD_NUT + (BOARD_12 - BOARD_NUT) * x) / 2;

/**
 * Null with fewer than two usable cells, or when they don't line up as a neck. Two cells
 * (frets 7 and 8, say) are enough: the known fret spacing and fretboard width fix the
 * neck's angle, size and place from their corners; with so few the fit is affine (no
 * perspective, which so short a stretch can't show), with three or more a homography.
 * Cells under `hand` (the fretting hand's box) are left out while four others remain:
 * the model places a covered cell by guesswork.
 */
export function fitNeck(cells: readonly Cell[], strings: number, hand: readonly Pt[] | null = null): NeckFit | null {
  // One cell per number: the most confident.
  const byFret = new Map<number, Cell>();
  for (const c of cells) if (c.corners.length === 4 && (byFret.get(c.fret)?.score ?? -1) < c.score) byFret.set(c.fret, c);
  let use = [...byFret.values()].sort((a, b) => a.fret - b.fret);
  if (hand) {
    const centre = (c: Cell): Pt => [c.corners.reduce((s, p) => s + p[0], 0) / 4, c.corners.reduce((s, p) => s + p[1], 0) / 4];
    const clear = use.filter((c) => !inside(centre(c), hand));
    if (clear.length >= 4) use = clear;
  }
  let fit = solve(use, strings);
  // While some cell is out of line, leave out the one whose absence fits the rest best.
  while (fit && !fit.fine && use.length > 3) {
    let best: { use: Cell[]; fit: Solved } | null = null;
    for (let i = 0; i < use.length; i++) {
      const rest = use.filter((_, k) => k !== i);
      const f = solve(rest, strings);
      if (f && (!best || f.worst < best.fit.worst)) best = { use: rest, fit: f };
    }
    if (!best) return null;
    ({ use, fit } = best);
  }
  if (!fit?.fine) return null;
  return { calibration: fit.calibration, span: [use[0].fret - 1, use[use.length - 1].fret], used: use.length, error: fit.error };
}

interface Solved {
  calibration: Calibration;
  error: number;
  /** The worst cell's error, as a share of what's tolerated. */
  worst: number;
  fine: boolean;
}

function solve(use: Cell[], strings: number): Solved | null {
  if (use.length < 2) return null;
  const pairs = correspondences(use);
  if (!pairs) return null;
  const from = pairs.map((p) => p.plane);
  const to = pairs.map((p) => p.image);
  const h = use.length < 3 ? leastSquaresAffine(from, to) : leastSquaresHomography(from, to);
  if (!h) return null;
  const errs = use.map((_, i) => {
    const mine = pairs.filter((p) => p.cell === i);
    return mine.reduce((s, p) => s + dist(apply(h, p.plane), p.image), 0) / mine.length;
  });
  // A cell is out of line when it misses by half its own width: one numbered a fret off
  // misses by about a whole width.
  const worst = Math.max(...errs.map((e, i) => e / Math.max(5, cellWidth(use[i]) / 2)));
  const last = strings - 1;
  const p = (x: number, s: number) => apply(h, planePoint(x, s, strings));
  return {
    calibration: [p(0, 0), p(0, last), p(1, 0), p(1, last)],
    error: errs.reduce((s, e) => s + e, 0) / errs.length,
    worst,
    fine: worst <= 1,
  };
}

interface Pair {
  plane: Pt;
  image: Pt;
  cell: number;
}

/**
 * Which corner of each cell is which. The corners go round the cell, so its sides come
 * in two opposite pairs: the fret wires are the pair running most across the neck (in
 * perspective they can lean a lot), and the one nearer the low-numbered cells is on
 * the nut side. Along a wire, the end higher in the picture is on the low-string side,
 * as a guitar is held.
 */
function correspondences(cells: Cell[]): Pair[] | null {
  const centre = (c: Cell): Pt => [c.corners.reduce((s, p) => s + p[0], 0) / 4, c.corners.reduce((s, p) => s + p[1], 0) / 4];
  // Direction of the neck: centres against fret numbers, by least squares.
  const ns = cells.map((c) => c.fret);
  const cs = cells.map(centre);
  const mn = ns.reduce((s, n) => s + n, 0) / ns.length;
  const mx = cs.reduce((s, c) => s + c[0], 0) / cs.length;
  const my = cs.reduce((s, c) => s + c[1], 0) / cs.length;
  let dx = 0;
  let dy = 0;
  let nn = 0;
  ns.forEach((n, i) => {
    dx += (n - mn) * (cs[i][0] - mx);
    dy += (n - mn) * (cs[i][1] - my);
    nn += (n - mn) ** 2;
  });
  const len = Math.hypot(dx, dy);
  if (!nn || len < 1e-9) return null;
  const a: Pt = [dx / len, dy / len];
  // Across the neck, pointing up the picture.
  let up: Pt = [a[1], -a[0]];
  if (up[1] > 0 || (up[1] === 0 && up[0] > 0)) up = [-up[0], -up[1]];

  const out: Pair[] = [];
  cells.forEach((c, i) => {
    const k = c.corners;
    const along = (p: Pt) => p[0] * a[0] + p[1] * a[1];
    const lean = (p: Pt, q: Pt) => Math.abs(along([q[0] - p[0], q[1] - p[1]])) / (dist(p, q) || 1);
    // Sides 0–1 and 2–3, or 1–2 and 3–0: the wires lean least along the neck.
    const [w1, w2] = lean(k[0], k[1]) + lean(k[2], k[3]) <= lean(k[1], k[2]) + lean(k[3], k[0]) ? [[k[0], k[1]], [k[2], k[3]]] : [[k[1], k[2]], [k[3], k[0]]];
    const mid = (w: Pt[]) => (along(w[0]) + along(w[1])) / 2;
    const [nutSide, bodySide] = mid(w1) <= mid(w2) ? [w1, w2] : [w2, w1];
    for (const [wire, two] of [
      [c.fret - 1, nutSide],
      [c.fret, bodySide],
    ] as const) {
      const [lowSide, highSide] = [...two].sort((p, q) => q[0] * up[0] + q[1] * up[1] - (p[0] * up[0] + p[1] * up[1]));
      const x = fretDistance(wire);
      out.push({ plane: [x, boardHalf(x)], image: lowSide, cell: i });
      out.push({ plane: [x, -boardHalf(x)], image: highSide, cell: i });
    }
  });
  return out;
}

/** The cell's width along the neck: between the middles of its two opposite sides, the closer pair. */
function cellWidth(c: Cell): number {
  const k = c.corners;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return Math.min(dist(mid(k[0], k[1]), mid(k[2], k[3])), dist(mid(k[1], k[2]), mid(k[3], k[0]))) || 1;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The affine map taking `from` to `to` that best fits all the pairs (three or more), as a homography. */
export function leastSquaresAffine(from: readonly Pt[], to: readonly Pt[]): Homography | null {
  if (from.length < 3 || from.length !== to.length) return null;
  // Normal equations of [x y 1]·[a b c] = u (and the same for v).
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const ru = [0, 0, 0];
  const rv = [0, 0, 0];
  from.forEach(([x, y], i) => {
    const row = [x, y, 1];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m[r * 3 + c] += row[r] * row[c];
      ru[r] += row[r] * to[i][0];
      rv[r] += row[r] * to[i][1];
    }
  });
  const solve3 = (rhs: number[]): number[] | null => {
    const a = [m.slice(0, 3).concat(rhs[0]), m.slice(3, 6).concat(rhs[1]), m.slice(6, 9).concat(rhs[2])];
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      if (Math.abs(a[p][c]) < 1e-12) return null;
      [a[c], a[p]] = [a[p], a[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const k = a[r][c] / a[c][c];
        for (let j = c; j < 4; j++) a[r][j] -= k * a[c][j];
      }
    }
    return a.map((row, i) => row[3] / row[i]);
  };
  const u = solve3(ru);
  const v = solve3(rv);
  return u && v ? [u[0], u[1], u[2], v[0], v[1], v[2], 0, 0, 1] : null;
}

/**
 * The homography taking `from` to `to` that best fits all the pairs (four or more),
 * by least squares on normalised coordinates; null when they're degenerate.
 */
export function leastSquaresHomography(from: readonly Pt[], to: readonly Pt[]): Homography | null {
  if (from.length < 4 || from.length !== to.length) return null;
  const norm = (pts: readonly Pt[]) => {
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const sc = Math.SQRT2 / (pts.reduce((s, p) => s + Math.hypot(p[0] - mx, p[1] - my), 0) / pts.length || 1);
    return { mx, my, sc, pts: pts.map(([x, y]) => [(x - mx) * sc, (y - my) * sc] as const) };
  };
  const f = norm(from);
  const t = norm(to);
  // Normal equations of the 2n × 8 system (h33 = 1).
  const ata = Array.from({ length: 8 }, () => new Array<number>(9).fill(0));
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) ata[i][j] += row[i] * row[j];
      ata[i][8] += row[i] * rhs;
    }
  };
  f.pts.forEach(([x, y], i) => {
    const [u, v] = t.pts[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  });
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(ata[r][c]) > Math.abs(ata[p][c])) p = r;
    if (Math.abs(ata[p][c]) < 1e-12) return null;
    [ata[c], ata[p]] = [ata[p], ata[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const k = ata[r][c] / ata[c][c];
      for (let j = c; j < 9; j++) ata[r][j] -= k * ata[c][j];
    }
  }
  const hn = [...ata.map((row, i) => row[8] / row[i]), 1];
  // Undo the normalisation: H = T_to⁻¹ · Hn · T_from.
  const Tf = [f.sc, 0, -f.sc * f.mx, 0, f.sc, -f.sc * f.my, 0, 0, 1];
  const Tti = [1 / t.sc, 0, t.mx, 0, 1 / t.sc, t.my, 0, 0, 1];
  const h = mul(Tti, mul(hn, Tf));
  return h.map((v) => v / h[8]);
}

function mul(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
}
