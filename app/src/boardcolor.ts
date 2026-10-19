/**
 * What the fretboard looks like, so whatever else covers it — the fretting hand, the arm,
 * a pick, a sleeve — can be told apart and kept out of the tracking. While the neck is
 * locked on, pixels sampled over the board (wood, frets, strings, inlays) fill a colour
 * histogram, forgetting slowly so it follows the light; a pixel over the board whose
 * colour the board hardly ever has is something in front of it.
 *
 * A board coloured like skin (pale maple) can't be told from a hand this way: then the
 * model says so (`discriminates`) and covers nothing, leaving the hand to the model's
 * box and the tracker's vote, as without it.
 */

/** Bins for brightness (coarse: it changes with the light) and for each chroma channel (fine: skin and wood differ there). */
const BINS_Y = 8;
const BINS_C = 32;
/** Each update keeps this much of what came before: it follows the light over some seconds. */
const KEEP = 0.97;
/** A colour (with its near neighbours) the board shows less than this share of the time is something else. */
const RARE = 0.004;
/** Samples it needs before it judges anything. */
const MIN_SAMPLES = 300;

function bin(r: number, g: number, b: number): number {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cr = (r - y) * 0.713 + 128;
  const cb = (b - y) * 0.564 + 128;
  const q = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor((v * n) / 256)));
  return (q(y, BINS_Y) * BINS_C + q(cr, BINS_C)) * BINS_C + q(cb, BINS_C);
}

export class BoardColor {
  private hist = new Float32Array(BINS_Y * BINS_C * BINS_C);
  private total = 0;
  /** Whether a typical hand colour stands out from the board. */
  private distinct = false;

  get ready(): boolean {
    return this.total >= MIN_SAMPLES && this.distinct;
  }

  /** Whether the board can be told from skin at all (false for a pale, skin-coloured board). */
  get discriminates(): boolean {
    return this.distinct;
  }

  /** Adds board pixels (RGBA, row by row, `width` wide) at `points`. */
  learn(rgba: ArrayLike<number>, width: number, height: number, points: readonly (readonly [number, number])[]): void {
    for (let i = 0; i < this.hist.length; i++) this.hist[i] *= KEEP;
    this.total *= KEEP;
    for (const [x, y] of points) {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= width || yi >= height) continue;
      const j = (yi * width + xi) * 4;
      this.hist[bin(rgba[j], rgba[j + 1], rgba[j + 2])] += 1;
      this.total += 1;
    }
    // Typical skin tones, light to dark: the board must rarely look like most of them.
    const skin = [
      [224, 172, 140],
      [198, 140, 110],
      [160, 110, 80],
      [120, 80, 60],
    ];
    this.distinct = skin.filter(([r, g, b]) => this.share(bin(r, g, b)) < RARE).length >= 3;
  }

  /** Whether the pixel at (x, y) is something in front of the board. False until ready. */
  covered(rgba: ArrayLike<number>, width: number, height: number, x: number, y: number): boolean {
    if (!this.ready) return false;
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return false;
    const j = (yi * width + xi) * 4;
    return this.share(bin(rgba[j], rgba[j + 1], rgba[j + 2])) < RARE;
  }

  /** How often the board shows this colour or one next to it. */
  private share(b: number): number {
    if (!this.total) return 0;
    const cb = b % BINS_C;
    const cr = Math.floor(b / BINS_C) % BINS_C;
    const y = Math.floor(b / (BINS_C * BINS_C));
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const [yy, rr, cc] = [y + dy, cr + dr, cb + dc];
          if (yy < 0 || rr < 0 || cc < 0 || yy >= BINS_Y || rr >= BINS_C || cc >= BINS_C) continue;
          sum += this.hist[(yy * BINS_C + rr) * BINS_C + cc];
        }
      }
    }
    return sum / this.total;
  }

  reset(): void {
    this.hist.fill(0);
    this.total = 0;
    this.distinct = false;
  }
}
