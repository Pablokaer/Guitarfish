/**
 * Song position → bar index, from plain data (no alphaTab needed).
 *
 * The input is the score in *play order*: each bar as often as it is played
 * (repeats, alternate endings, D.C./D.S. jumps already expanded; see score.ts),
 * with absolute tick positions, plus every tempo change at its exact tick.
 */

/** alphaTab's resolution: ticks per quarter note. */
export const TICKS_PER_QUARTER = 960;
const DEFAULT_TEMPO = 120;

/** One bar as played: master bar `index` sounds from `startTick` to `endTick`. */
export interface PlayedBar {
  index: number;
  startTick: number;
  endTick: number;
}

/** A tempo change at an absolute (play-order) tick. */
export interface TempoChange {
  tick: number;
  bpm: number;
}

/** A tempo segment: from `tick` (reached at `ms`) the tempo is `bpm`. */
export interface TempoPoint {
  tick: number;
  ms: number;
  bpm: number;
}

/** A played bar with its start and end time in ms. */
export interface TimedBar {
  index: number;
  startMs: number;
  endMs: number;
}

/** Duration in ms of `ticks` at `bpm`. */
const ticksToMs = (ticks: number, bpm: number) => (ticks / TICKS_PER_QUARTER) * (60_000 / bpm);
const validBpm = (bpm: number) => Number.isFinite(bpm) && bpm > 0;

/**
 * Tempo map sorted by tick, starting at tick 0. Before the first change the
 * fallback tempo applies; at equal ticks the last change wins.
 */
export function tempoMap(changes: readonly TempoChange[], fallbackBpm = DEFAULT_TEMPO): TempoPoint[] {
  const sorted = changes.filter((c) => validBpm(c.bpm)).sort((a, b) => a.tick - b.tick);
  const map: TempoPoint[] = [{ tick: 0, ms: 0, bpm: validBpm(fallbackBpm) ? fallbackBpm : DEFAULT_TEMPO }];
  for (const c of sorted) {
    const last = map[map.length - 1];
    if (c.tick <= last.tick) {
      last.bpm = c.bpm;
      continue;
    }
    map.push({ tick: c.tick, ms: last.ms + ticksToMs(c.tick - last.tick, last.bpm), bpm: c.bpm });
  }
  return map;
}

/** Time in ms at `tick`, using a map from {@link tempoMap}. */
export function tickToMs(map: readonly TempoPoint[], tick: number): number {
  let lo = 0;
  let hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  const p = map[lo];
  return p.ms + ticksToMs(tick - p.tick, p.bpm);
}

/** Start and end time of every played bar. */
export function buildTimeline(bars: readonly PlayedBar[], changes: readonly TempoChange[], fallbackBpm = DEFAULT_TEMPO): TimedBar[] {
  const map = tempoMap(changes, fallbackBpm);
  return bars.map((b) => ({ index: b.index, startMs: tickToMs(map, b.startTick), endMs: tickToMs(map, b.endTick) }));
}

/** Master bar index playing at `positionMs` (clamped to the first/last bar); -1 without bars. */
export function barAt(timeline: readonly TimedBar[], positionMs: number): number {
  if (timeline.length === 0) return -1;
  let lo = 0;
  let hi = timeline.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timeline[mid].startMs <= positionMs) lo = mid;
    else hi = mid - 1;
  }
  return timeline[lo].index;
}
