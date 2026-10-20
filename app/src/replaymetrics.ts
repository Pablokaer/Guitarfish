import type { Pt } from "./neckmap";

/**
 * How well the neck was followed through a replayed clip (replay.ts), without knowing
 * where it really was: how much of the time it was shown and locked on, how often it
 * was lost and for how long, how much it shook, how often it jumped, and how far the
 * model's answers were from where it was tracked (drift, or the model being wrong).
 */

/** What the app had on one frame. */
export interface Sample {
  /** When the frame was taken, ms. */
  at: number;
  /** Where the neck was drawn (nut-high, nut-low, 12th-high, 12th-low), or null. */
  neck: readonly Pt[] | null;
  locked: boolean;
}

export interface ReplayStats {
  frames: number;
  seconds: number;
  /** Share of frames with the neck drawn. */
  shown: number;
  /** Share of frames locked on. */
  locked: number;
  /** Seconds from the start to the first frame locked on; null if never. */
  firstLock: number | null;
  /** Times the neck went away after having been found. */
  losses: number;
  /** Longest stretch without the neck after it was first found, seconds. */
  longestGap: number;
  /** Shake: each frame's distance from the average of its neighbours, % of the neck's length (nut to 12th). */
  jitter: { median: number; p95: number };
  /** Frames where the neck moved more than JUMP of its length since the frame before. */
  jumps: number;
  answers: { ok: number; noNeck: number; fewFrets: number; failed: number };
  /** The model's answers against the tracked neck, in fret spacings (follower.ts offGaps); `over`: share past NEAR. */
  disagree: { median: number; p95: number; over: number };
}

/** Frames either side averaged to measure shake. */
const WINDOW = 3;
/** A move by more than this share of the neck's length in one frame is a jump. */
export const JUMP = 0.05;
/** An answer this many fret spacings off is one the follower calls far (follower.ts NEAR_GAPS). */
const NEAR = 0.4;

/** Nut to 12th fret, along the middle of the board. */
function length(n: readonly Pt[]): number {
  const [a, b, c, d] = n;
  return Math.hypot((c[0] + d[0]) / 2 - (a[0] + b[0]) / 2, (c[1] + d[1]) / 2 - (a[1] + b[1]) / 2);
}

/** The mean distance between matching corners of two necks, as a share of `a`'s length. */
function moved(a: readonly Pt[], b: readonly Pt[]): number {
  const len = length(a) || 1;
  return a.reduce((s, p, i) => s + Math.hypot(p[0] - b[i][0], p[1] - b[i][1]), 0) / a.length / len;
}

export function percentile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

export function summarize(
  samples: readonly Sample[],
  answers: ReplayStats["answers"],
  disagreements: readonly number[],
): ReplayStats {
  const n = samples.length;
  const start = n ? samples[0].at : 0;
  const seconds = n ? (samples[n - 1].at - start) / 1000 : 0;
  const firstLockAt = samples.find((s) => s.locked)?.at;
  let losses = 0;
  let longestGap = 0;
  let gapFrom: number | null = null;
  let found = false;
  let jumps = 0;
  samples.forEach((s, i) => {
    if (s.neck) {
      if (gapFrom !== null) longestGap = Math.max(longestGap, s.at - gapFrom);
      gapFrom = null;
      found = true;
      const prev = samples[i - 1]?.neck;
      if (prev && moved(prev, s.neck) > JUMP) jumps++;
    } else if (found && gapFrom === null) {
      losses++;
      gapFrom = s.at;
    }
  });
  if (gapFrom !== null && n) longestGap = Math.max(longestGap, samples[n - 1].at - gapFrom);

  const shake: number[] = [];
  for (let i = WINDOW; i < n - WINDOW; i++) {
    const around = samples.slice(i - WINDOW, i + WINDOW + 1).map((s) => s.neck);
    if (around.some((a) => !a)) continue;
    const neck = samples[i].neck!;
    const mean = neck.map((_, k) => {
      const ps = around.map((a) => a![k]);
      return [ps.reduce((t, p) => t + p[0], 0) / ps.length, ps.reduce((t, p) => t + p[1], 0) / ps.length] as const;
    });
    shake.push(100 * moved(neck, mean));
  }

  return {
    frames: n,
    seconds,
    shown: n ? samples.filter((s) => s.neck).length / n : 0,
    locked: n ? samples.filter((s) => s.locked).length / n : 0,
    firstLock: firstLockAt === undefined ? null : (firstLockAt - start) / 1000,
    losses,
    longestGap: longestGap / 1000,
    jitter: { median: percentile(shake, 0.5), p95: percentile(shake, 0.95) },
    jumps,
    answers,
    disagree: {
      median: percentile(disagreements, 0.5),
      p95: percentile(disagreements, 0.95),
      over: disagreements.length ? disagreements.filter((d) => d > NEAR).length / disagreements.length : NaN,
    },
  };
}
