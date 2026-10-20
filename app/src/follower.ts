import { BoardColor } from "./boardcolor";
import { apply, fretDistance, grow, inside, NeckMap, type Calibration, type Homography, type Pt } from "./neckmap";
import type { NeckResult } from "./neckworker";
import { OneEuro, PointsFilter } from "./smooth";
import { compose, IDENTITY, rigidNeck, Tracker, type GrayFrame } from "./tracker";

/**
 * Where the neck is, frame after frame: the model's answers (a few a second, late)
 * find it and keep it honest; in between, points on the fretboard are tracked every
 * frame (tracker.ts). Once the neck is locked on — the model has agreed with the tracked
 * neck a few times, and many points have moved with it for a while — answers can only
 * fine-tune it: a hand over the frets can make the model miscount or misplace a few cells
 * (a fret off is a few percent of the neck), but it can't make the board itself jump, so
 * an answer off by more than a little is ignored. Only when tracking is lost (or the
 * model keeps saying otherwise for a good while) does the model's answer win outright.
 *
 * Anything in front of the board — the hand, the arm — is kept out: while locked on, the
 * board's own colours are learnt (boardcolor.ts), and no point is tracked or taken where
 * a pixel doesn't look like the board.
 *
 * Pure state, no DOM: trackworker.ts runs it off the main thread.
 */

/** Width frames are tracked at. */
export const TRACK_W = 640;
/** The notes disappear when the neck hasn't been seen for this long, in ms. */
const LOST_AFTER = 1200;
/** Tracking alone, without the model agreeing, is trusted this long, in ms. */
const UNCONFIRMED_MAX = 5000;
/** The fretboard up to this fret is searched for points to track. */
const TRACK_FRETS = 14;
/** The hand's box, grown by this, is kept clear of tracked points (fingers stick out). */
const HAND_MARGIN = 1.35;
/**
 * How far each model answer pulls the tracked neck once it's settled: tracking moves it,
 * the model only corrects drift. Right after the neck is found the pull is stronger (the
 * n-th answer weighs 1/n, an average), so a first rough look is soon put right.
 */
const CORRECT = 0.15;
/** The model's last answers, kept (moved along with the neck) to correct towards their median. */
const ANSWERS = 5;
/** Locked on: at least this many points have moved with the neck for a while… */
const LOCKED_POINTS = 15;
/** …and at least this many answers in a row have agreed with where it's tracked. */
const LOCKED_ANSWERS = 3;
/** Locked on, a far answer wins only after this many in a row agree with each other (~1.5 s). */
const OVERRULE = 6;
/** While locked on, the board's colours are learnt from every so many frames. */
const LEARN_EVERY = 4;
/**
 * An answer agrees with the tracked neck when, on the frets it saw, it's off by less than
 * this share of the local fret spacing: a model that miscounted by one fret is a whole
 * spacing off, wherever on the neck and however the perspective squeezes it.
 */
const NEAR_GAPS = 0.4;
/** Far answers back each other up when they're this close to one another. */
const AGREE_GAPS = 0.25;
/** An answer from fewer cells than this can't check its own count: it needs company to win. */
const FEW_CELLS = 3;
/** Tracking a stretch of the neck shorter than this (plane units, nut to 12th = 1), its motion is fitted affine: so short a stretch can't show perspective. */
const SHORT_STRETCH = 0.35;
/** If more than this share of the board looks "covered", the learnt colours are stale: they're forgotten. */
const MOSTLY_COVERED = 0.6;

export type Miss = Exclude<NeckResult, { ok: true }>["reason"] | "loading";

export class NeckFollower {
  /** Where to draw the neck (frame pixels): tracked, or the model's answers smoothed. */
  neck: Pt[] | null = null;
  /** The same before smoothing: tracked every frame, corrected by the model. */
  raw: Pt[] | null = null;
  miss: Miss = "loading";
  private tracker = new Tracker();
  private tracking = false;
  private gray: GrayFrame | null = null;
  /** The same frame in colour (RGBA, tracked size), to tell the board from what covers it. */
  private rgba: ArrayLike<number> | null = null;
  private board = new BoardColor();
  private frames = 0;
  /** Frame pixels per tracked-frame pixel. */
  private scale = 1;
  // The model alone jitters: smoothed when nothing is tracked (cutoff in Hz, speed in px/s).
  private filter = new PointsFilter(() => new OneEuro(1.2, 0.03));
  /** The neck's motion (frame pixels) since the frame the model is looking at was sent. */
  private sinceSent: Homography = IDENTITY;
  /** The fretting hand's box from the model's last answer, in frame pixels. */
  hand: Pt[] | null = null;
  /** The model's recent answers, moved along with the neck to the current frame. */
  private answers: Pt[][] = [];
  /** Answers since the neck was found (or jumped): how settled it is. */
  private settled = 0;
  /** Far answers in a row, and the last of them (moved along with the neck). */
  private farRun: Pt[][] = [];
  /** After a reset, answers about frames sent before it are in another frame's pixels: ignored until a new one is sent. */
  private awaitingSent = false;
  private seenAt = 0;
  /** When the model last saw the neck (tracking alone may drift). */
  private confirmedAt = 0;

  constructor(public strings = 6) {}

  /** Locked on: the model has agreed with the tracked neck, and enough points have moved with it for a while. */
  get locked(): boolean {
    return this.tracking && this.settled > LOCKED_ANSWERS && this.tracker.settledPoints >= LOCKED_POINTS;
  }

  /**
   * A new frame (`videoWidth`: the frame's own width; `rgba`: the frame in colour at the
   * tracked size, if there is one). Returns whether the neck moved.
   */
  frame(gray: GrayFrame, videoWidth: number, now: number, rgba: ArrayLike<number> | null = null): boolean {
    this.gray = gray;
    this.rgba = rgba;
    this.scale = videoWidth / gray.width;
    this.frames++;
    let moved = false;
    if (this.tracking && this.raw) {
      // The rigid-neck check is made on the stretch being tracked: with only a few frets in
      // view, the nut or the 15th fret are guesses far off the picture that a tiny turn moves a lot.
      const map = NeckMap.from(this.raw as unknown as Calibration, this.strings);
      const last = this.strings - 1;
      const [lo, hi] = map ? this.trackedStretch(map) : [0, 0];
      const span = map ? [map.at(lo, 0), map.at(lo, last), map.at(hi, 0), map.at(hi, last)].map(([x, y]) => [x / this.scale, y / this.scale] as const) : null;
      const h = this.tracker.next(gray, span ? rigidNeck(span) : undefined, this.covered, hi - lo < SHORT_STRETCH);
      if (h) {
        // Tracked in the small frame: the same motion in frame pixels.
        const s = 1 / this.scale;
        const hf = compose([1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1], compose(h, [s, 0, 0, 0, s, 0, 0, 0, 1]));
        const move = (pts: Pt[]) => pts.map((p) => apply(hf, p));
        this.raw = move(this.raw);
        this.answers = this.answers.map(move);
        this.farRun = this.farRun.map(move);
        // The hand moves on its own, but this is the best guess until the next answer.
        if (this.hand) this.hand = move(this.hand);
        this.sinceSent = compose(hf, this.sinceSent);
        // Drawn exactly where it's tracked: smoothing would only make it trail the neck.
        this.neck = this.raw;
        this.seenAt = now;
        moved = true;
        if (this.locked && this.frames % LEARN_EVERY === 0) this.learnBoard();
      } else {
        // Lost to the tracker: the answers kept so far no longer move with the guitar.
        this.tracking = false;
        this.answers = [];
        this.farRun = [];
      }
    }
    this.checkLost(now);
    return moved;
  }

  /** The frame just passed to frame() is the one sent to the model. */
  sent(): void {
    this.sinceSent = IDENTITY;
    this.awaitingSent = false;
  }

  /** The model's answer about the frame last marked sent(). */
  answer(r: NeckResult, now: number): void {
    if (this.awaitingSent) return;
    if (!r.ok) {
      this.miss = r.reason;
      this.checkLost(now);
      return;
    }
    // The answer is about the frame sent a moment ago: moved on as the neck has moved since.
    let pts = r.calibration.map((p) => apply(this.sinceSent, p));
    const prev = this.raw;
    // Which outer string is which can come out swapped (a neck held upright, looked at
    // turned one way or the other): keep the tracked neck's.
    if (prev) {
      const swapped = [pts[1], pts[0], pts[3], pts[2]];
      const off = (q: Pt[]) => q.reduce((s, p, i) => s + Math.hypot(p[0] - prev[i][0], p[1] - prev[i][1]), 0);
      if (off(swapped) < off(pts)) pts = swapped;
    }
    this.hand = r.hand?.map((p) => apply(this.sinceSent, p)) ?? null;
    // A partial view (a few frets) is compared with the tracked neck where it was seen, not
    // at the nut and 12th fret it can only guess.
    const seen = r.span ?? [0, 12];
    const few = r.cells < FEW_CELLS;
    let next: Pt[];
    if ((!prev || now - this.seenAt > LOST_AFTER) && !few) {
      next = this.restart(pts);
    } else if (prev && now - this.seenAt <= LOST_AFTER && !far(pts, prev, NEAR_GAPS, seen, this.strings)) {
      this.farRun = [];
      if (!this.tracking) {
        // Nothing tracked to correct: take the answer (it's smoothed for drawing).
        this.answers = [pts];
        next = pts;
      } else {
        // Pull the tracked neck a little towards the most central of the model's recent
        // answers (a whole answer, so its shape is one the model actually proposed).
        this.answers = [...this.answers, pts].slice(-ANSWERS);
        const target = medoid(this.answers, seen, this.strings);
        const gain = Math.max(CORRECT, 1 / ++this.settled);
        next = prev.map((p, i) => [p[0] + gain * (target[i][0] - p[0]), p[1] + gain * (target[i][1] - p[1])] as const);
      }
    } else {
      // Far from where the neck is tracked (or a first look from very few frets). Unless
      // locked on, believe it once it's seen twice (three times from few frets); locked on,
      // only if it keeps saying so: a hand can fool the model for a moment, not for seconds.
      const agrees = this.farRun.length > 0 && !far(pts, this.farRun[this.farRun.length - 1], AGREE_GAPS, seen, this.strings);
      this.farRun = agrees ? [...this.farRun, pts] : [pts];
      const needed = this.locked ? OVERRULE : few ? 3 : 2;
      if (this.farRun.length < needed) return;
      next = this.restart(pts);
    }
    this.raw = next;
    this.neck = this.tracking ? next : this.filter.next(next, now);
    this.seenAt = this.confirmedAt = now;
    this.seed();
  }

  /** The stretch of the neck (plane x, nut = 0) the tracked points lie on, a little widened. */
  private trackedStretch(map: NeckMap): [number, number] {
    const xs = this.tracker.tracked.map(([x, y]) => map.toPlane([x * this.scale, y * this.scale])[0]).filter(Number.isFinite);
    if (xs.length < 4) return [0, fretDistance(15)];
    let lo = Math.min(...xs);
    let hi = Math.max(...xs);
    const pad = Math.max(0.05, 0.1 * (hi - lo));
    [lo, hi] = [Math.max(-0.05, lo - pad), Math.min(fretDistance(22), hi + pad)];
    return hi - lo > 0.05 ? [lo, hi] : [0, fretDistance(15)];
  }

  /** Whether the tracked-frame point is something in front of the board (the hand, the arm). */
  private covered = (p: Pt): boolean => !!this.rgba && !!this.gray && this.board.covered(this.rgba, this.gray.width, this.gray.height, p[0], p[1]);

  /** Learns the board's colours from where it is now, away from the hand. */
  private learnBoard(): void {
    const map = this.raw && NeckMap.from(this.raw as unknown as Calibration, this.strings);
    if (!map || !this.rgba || !this.gray) return;
    const hand = this.hand ? grow(this.hand, HAND_MARGIN) : null;
    const pts: Pt[] = [];
    for (let f = 0.25; f < TRACK_FRETS; f += 0.5) {
      for (let s = -0.3; s <= this.strings - 0.7; s += 0.35) {
        const p = map.at(fretDistance(f), s);
        if (hand && inside(p, hand)) continue;
        pts.push([p[0] / this.scale, p[1] / this.scale]);
      }
    }
    this.board.learn(this.rgba, this.gray.width, this.gray.height, pts);
  }

  /** Lost (or the picture changed): start afresh. */
  reset(): void {
    this.forget();
    this.sinceSent = IDENTITY;
    this.awaitingSent = true;
  }

  private forget(): void {
    this.board.reset();
    this.neck = this.raw = this.hand = null;
    this.answers = [];
    this.farRun = [];
    this.tracking = false;
    this.settled = 0;
  }

  private restart(pts: Pt[]): Pt[] {
    this.filter.reset();
    this.board.reset();
    this.answers = [pts];
    this.farRun = [];
    this.settled = 1;
    this.tracking = false; // the points followed so far belong to the old neck
    return pts;
  }

  private checkLost(now: number): void {
    if (this.neck && (now - this.seenAt > LOST_AFTER || now - this.confirmedAt > UNCONFIRMED_MAX)) this.forget();
  }

  /**
   * Tops up the tracked points from the neck as it is now: the most trackable spots all
   * over the fretboard (fret ends, string crossings, inlays), a few per fret, none under
   * the hand. Points already followed stay, with their votes; those the hand has moved
   * over are dropped.
   */
  private seed(): void {
    const map = this.raw && NeckMap.from(this.raw as unknown as Calibration, this.strings);
    if (!map || !this.gray) return;
    const toTrack = ([x, y]: Pt): Pt => [x / this.scale, y / this.scale];
    const hand = this.hand ? grow(this.hand, HAND_MARGIN).map(toTrack) : null;
    if (!this.tracking) this.tracker.reset(this.gray, []);
    if (hand) this.tracker.drop(hand);
    const groups: Pt[][] = [];
    for (let f = 0; f < TRACK_FRETS; f++) {
      const g: Pt[] = [];
      for (let df = 0; df < 1; df += 0.2) for (let i = -0.4; i <= this.strings - 0.6; i += 0.5) g.push(toTrack(map.at(fretDistance(f + df), i)));
      groups.push(g);
    }
    // Learnt colours that call most of the board "covered" are stale (the light changed): forget them.
    const all = groups.flat().filter(([x, y]) => x >= 0 && y >= 0 && x < this.gray!.width && y < this.gray!.height);
    if (all.length && all.filter(this.covered).length > MOSTLY_COVERED * all.length) this.board.reset();
    this.tracker.add(this.gray, groups, hand, undefined, this.covered);
    this.tracking = this.tracker.size >= 8;
  }
}

/**
 * How far neck `a` is from neck `b`, in b's local fret spacings, at its worst on the outer
 * strings at the fret wires from `span[0]` to `span[1]` (where `a` was seen).
 */
export function offGaps(a: readonly Pt[], b: readonly Pt[], span: readonly [number, number], strings: number): number {
  const ma = NeckMap.from(a as unknown as Calibration, strings);
  const mb = NeckMap.from(b as unknown as Calibration, strings);
  if (!ma || !mb) return Infinity;
  let worst = 0;
  for (let f = Math.max(0, span[0]); f <= Math.min(24, span[1]); f++) {
    for (const s of [0, strings - 1]) {
      const p = ma.fret(f, s);
      const q = mb.fret(f, s);
      const r = mb.fret(f + 1, s);
      const gap = Math.hypot(r[0] - q[0], r[1] - q[1]) || 1;
      worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1]) / gap);
    }
  }
  return worst;
}

function far(a: readonly Pt[], b: readonly Pt[], gaps: number, span: readonly [number, number], strings: number): boolean {
  return offGaps(a, b, span, strings) > gaps;
}

/** The answer closest to all the others (on the frets in `span`): the most central whole answer. */
function medoid(sets: readonly Pt[][], span: readonly [number, number], strings: number): Pt[] {
  let best = sets[sets.length - 1];
  let bestSum = Infinity;
  for (const a of sets) {
    const sum = sets.reduce((s, b) => s + (a === b ? 0 : offGaps(a, b, span, strings)), 0);
    if (sum < bestSum) [best, bestSum] = [a, sum];
  }
  return best;
}
