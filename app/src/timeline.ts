/**
 * Song position → bar index, from plain score data (no alphaTab DOM needed).
 * Repeats and gradual tempo changes are not modelled yet (MVP).
 */

/** alphaTab's resolution: ticks per quarter note. */
export const TICKS_PER_QUARTER = 960;
const DEFAULT_TEMPO = 120;

export interface BarTiming {
  /** Bar length in ticks (from the time signature). */
  ticks: number;
  /** Tempo set at the start of this bar (its first tempo automation), if any. */
  tempo?: number | null;
}

/** Bar start times in ms. A tempo change applies from its bar onwards. */
export function barStarts(scoreTempo: number, bars: readonly BarTiming[]): number[] {
  const starts: number[] = [];
  let tempo = scoreTempo || DEFAULT_TEMPO;
  let t = 0;
  for (const bar of bars) {
    if (bar.tempo != null && bar.tempo > 0) tempo = bar.tempo;
    starts.push(t);
    t += (bar.ticks / TICKS_PER_QUARTER) * (60_000 / tempo);
  }
  return starts;
}

/** Index of the bar playing at `positionMs` (clamped to the first/last bar); -1 without bars. */
export function barAt(starts: readonly number[], positionMs: number): number {
  if (starts.length === 0) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= positionMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
