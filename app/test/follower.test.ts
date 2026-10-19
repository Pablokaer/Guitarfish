import { describe, expect, it } from "vitest";
import { NeckFollower } from "../src/follower";
import type { Calibration, Pt } from "../src/neckmap";
import type { GrayFrame } from "../src/tracker";

/** A smooth random texture, made once a little wider than the frame, so frames can slide over it. */
const TEX_W = 360;
const TEX = (() => {
  const w = TEX_W, h = 180;
  const blobs: [number, number, number, number][] = [];
  let s = 5;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 800; i++) blobs.push([r() * w, r() * h, 2 + r() * 4, (r() - 0.5) * 200]);
  const data = new Float32Array(w * h).fill(128);
  for (const [bx, by, rad, a] of blobs) {
    for (let y = Math.max(0, Math.floor(by - 3 * rad)); y < Math.min(h, by + 3 * rad); y++) {
      for (let x = Math.max(0, Math.floor(bx - 3 * rad)); x < Math.min(w, bx + 3 * rad); x++) {
        data[y * w + x] += a * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * rad * rad));
      }
    }
  }
  return data;
})();

/** The frame (320×180) with everything slid `dx` px right. */
function frame(dx = 0): GrayFrame {
  const w = 320, h = 180;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = TEX[y * TEX_W + (x - dx + 20)];
  return { width: w, height: h, data };
}

// A neck across the frame: nut at x 40, 12th fret at x 250 (nut-high, nut-low, 12-high, 12-low).
const NECK: Calibration = [[40, 100], [40, 80], [250, 104], [250, 76]];
const shifted = (dx: number) => NECK.map(([x, y]) => [x + dx, y] as const) as unknown as Calibration;
const answer = (cal: Calibration) => ({ ok: true as const, calibration: cal, cells: 8, hand: null, span: [0, 12] as [number, number] });
const close = (a: readonly Pt[] | null, b: readonly Pt[], tol: number) => a !== null && a.every((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) < tol);

describe("NeckFollower", () => {
  const still = frame();

  /** Found, then confirmed by a few answers while the points settle. */
  function lockedOn(): NeckFollower {
    const f = new NeckFollower(6);
    let t = 0;
    f.frame(still, 320, t);
    for (let i = 0; i < 14; i++) {
      if (i % 3 === 0) {
        f.sent();
        f.answer(answer(NECK), (t += 10));
      }
      f.frame(still, 320, (t += 33));
    }
    return f;
  }

  it("takes the first answer, and locks on only once the model has agreed a few times", () => {
    const f = new NeckFollower(6);
    let t = 0;
    f.frame(still, 320, t);
    f.sent();
    f.answer(answer(NECK), (t += 10));
    for (let i = 0; i < 14; i++) f.frame(still, 320, (t += 33));
    expect(close(f.neck, NECK, 0.5)).toBe(true);
    expect(f.locked).toBe(false); // points settled, but the model said so only once
    expect(lockedOn().locked).toBe(true);
  });

  it("not locked on yet, lets a better answer put a rough first look right", () => {
    const f = new NeckFollower(6);
    f.frame(still, 320, 0);
    f.sent();
    f.answer(answer(shifted(30)), 10); // rough first look, from the whole frame
    for (let i = 0; i < 12; i++) f.frame(still, 320, 20 + 33 * i);
    f.sent();
    f.answer(answer(NECK), 450);
    f.answer(answer(NECK), 500);
    expect(close(f.neck, NECK, 1)).toBe(true);
  });

  it("locked on, isn't moved by answers a hand has thrown off by a fret", () => {
    const f = lockedOn();
    let t = 1000;
    // Five answers in a row, all a fret off (as a hand over the frets can make the model say).
    for (let i = 0; i < 5; i++) {
      f.sent();
      f.answer(answer(shifted(30)), (t += 200));
      f.frame(still, 320, (t += 33));
    }
    expect(close(f.neck, NECK, 1)).toBe(true);
  });

  it("locked on, gives in when the model keeps saying so for long enough", () => {
    const f = lockedOn();
    let t = 1000;
    for (let i = 0; i < 6; i++) {
      f.sent();
      f.answer(answer(shifted(30)), (t += 200));
    }
    expect(close(f.neck, shifted(30), 1)).toBe(true);
  });

  it("not locked on yet, believes a far answer seen twice", () => {
    const f = new NeckFollower(6);
    f.frame(still, 320, 0);
    f.sent();
    f.answer(answer(NECK), 33);
    f.sent();
    f.answer(answer(shifted(40)), 66);
    expect(close(f.neck, NECK, 1)).toBe(true);
    f.answer(answer(shifted(40)), 99);
    expect(close(f.neck, shifted(40), 1)).toBe(true);
  });

  it("ignores one stray close answer, but drifts towards close answers that keep coming", () => {
    const f = lockedOn();
    // 3 px: a small drift (well under the fret spacing even at the 12th fret).
    f.sent();
    f.answer(answer(shifted(3)), 600);
    expect(f.neck![0][0]).toBeCloseTo(40, 1); // the most central recent answer is still an old one
    f.answer(answer(shifted(3)), 650);
    f.answer(answer(shifted(3)), 700);
    const x = f.neck![0][0];
    expect(x).toBeGreaterThan(40.2);
    expect(x).toBeLessThan(43);
  });

  it("follows the neck as it slides between the model's answers", () => {
    const f = lockedOn();
    let t = 1000;
    for (let i = 1; i <= 4; i++) f.frame(frame(2 * i), 320, (t += 33));
    expect(close(f.neck, shifted(8), 1)).toBe(true);
  });

  it("moves a late answer on by how far the neck has moved since its frame", () => {
    const f = lockedOn();
    let t = 1000;
    f.sent(); // the model looks at this frame…
    for (let i = 1; i <= 3; i++) f.frame(frame(2 * i), 320, (t += 33)); // …the neck slides 6 px…
    f.answer(answer(NECK), (t += 10)); // …and the answer, about the old frame, agrees with the tracking.
    expect(close(f.neck, shifted(6), 1)).toBe(true);
  });

  it("forgets the neck after a while without seeing it", () => {
    const f = new NeckFollower(6);
    f.frame(still, 320, 0);
    f.answer(answer(NECK), 10);
    f.reset();
    expect(f.neck).toBeNull();
  });
});

describe("NeckFollower with the review fixes", () => {
  const still = frame();
  it("ignores an answer about a frame sent before a reset", () => {
    const f = new NeckFollower(6);
    f.frame(still, 320, 0);
    f.reset();
    f.answer(answer(NECK), 10); // in flight when the camera changed
    expect(f.neck).toBeNull();
    f.frame(still, 320, 20);
    f.sent();
    f.answer(answer(NECK), 30);
    expect(f.neck).not.toBeNull();
  });

  it("needs a first look from only two cells to be confirmed", () => {
    const f = new NeckFollower(6);
    f.frame(still, 320, 0);
    f.sent();
    const few = { ...answer(NECK), cells: 2, span: [6, 8] as [number, number] };
    f.answer(few, 10);
    f.answer(few, 20);
    expect(f.neck).toBeNull();
    f.answer(few, 30);
    expect(close(f.neck, NECK, 0.5)).toBe(true);
  });

  it("keeps the tracked neck's string order when an answer comes back swapped", () => {
    const f = new NeckFollower(6);
    f.frame(still, 320, 0);
    f.sent();
    f.answer(answer(NECK), 10);
    const swapped = [NECK[1], NECK[0], NECK[3], NECK[2]] as unknown as Calibration;
    f.answer(answer(swapped), 20);
    expect(close(f.neck, NECK, 0.5)).toBe(true);
  });
});
