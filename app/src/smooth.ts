/**
 * The One Euro filter (Casiez, Roussel & Vogel, CHI 2012): a low-pass filter whose
 * cutoff rises with speed. Still, it smooths hard and the jitter goes; moving, it
 * barely smooths, so it doesn't lag behind.
 */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  /**
   * @param minCutoff Hz at rest: lower is steadier.
   * @param beta How fast the cutoff rises with speed: higher follows quicker.
   * @param dCutoff Hz for the speed estimate itself.
   */
  constructor(
    private minCutoff = 1,
    private beta = 0.02,
    private dCutoff = 1,
  ) {}

  /** The filtered value of `x` sampled at `t` (ms). */
  next(x: number, t: number): number {
    if (this.x === null || t <= this.t) {
      this.x = x;
      this.dx = 0;
      this.t = t;
      return x;
    }
    const dt = (t - this.t) / 1000;
    this.t = t;
    const a = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const dx = (x - this.x) / dt;
    this.dx += a(this.dCutoff) * (dx - this.dx);
    this.x += a(this.minCutoff + this.beta * Math.abs(this.dx)) * (x - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
  }
}

/** One filter per coordinate of a list of points. */
export class PointsFilter {
  private filters: OneEuro[] = [];

  constructor(private make: () => OneEuro) {}

  next(points: readonly (readonly [number, number])[], t: number): [number, number][] {
    while (this.filters.length < points.length * 2) this.filters.push(this.make());
    return points.map(([x, y], i) => [this.filters[2 * i].next(x, t), this.filters[2 * i + 1].next(y, t)]);
  }

  reset(): void {
    this.filters.forEach((f) => f.reset());
  }
}
