import type { Cell } from "./fretfit";
import type { Pt } from "./neckmap";

/**
 * The fret detector's output, read into cells. The model (YOLO11n, oriented boxes,
 * trained on the numbered fret cells of the code-and-chords "guitar-frets-segmenter"
 * dataset, CC BY 4.0) sees a frame stretched to MODEL_SIZE × MODEL_SIZE, as in its
 * training data, and returns per anchor: centre, size, a score per class, and angle.
 */

export const MODEL_SIZE = 640;

/** Fret number of each class, in the model's order (0 = the hand, not a cell). */
export const CLASS_FRET = [1, 10, 11, 12, 2, 3, 4, 5, 6, 7, 8, 9, 0] as const;

/** Below this a cell isn't believed. */
export const MIN_SCORE = 0.3;

/**
 * The best box of each fret number in an output of shape [1, 4 + classes + 1, anchors],
 * as cells with their corners going round, in model pixels.
 */
export function decodeCells(out: ArrayLike<number>, channels: number, anchors: number, minScore = MIN_SCORE): Cell[] {
  const classes = channels - 5;
  const best = new Array<{ i: number; score: number } | null>(classes).fill(null);
  for (let c = 0; c < classes; c++) {
    if (!CLASS_FRET[c]) continue;
    const row = (4 + c) * anchors;
    for (let i = 0; i < anchors; i++) {
      const s = out[row + i];
      if (s >= minScore && (!best[c] || s > best[c]!.score)) best[c] = { i, score: s };
    }
  }
  const cells: Cell[] = [];
  best.forEach((b, c) => {
    if (!b) return;
    const at = (ch: number) => out[ch * anchors + b.i];
    cells.push({ fret: CLASS_FRET[c], corners: corners(at(0), at(1), at(2), at(3), at(channels - 1)), score: b.score });
  });
  return cells;
}

/** The fretting hand's box, if the model sees one (corners going round, model pixels). */
export function decodeHand(out: ArrayLike<number>, channels: number, anchors: number, minScore = 0.4): Pt[] | null {
  const c = CLASS_FRET.indexOf(0);
  const row = (4 + c) * anchors;
  let best = -1;
  for (let i = 0; i < anchors; i++) if (out[row + i] >= minScore && (best < 0 || out[row + i] > out[row + best])) best = i;
  if (best < 0) return null;
  const at = (ch: number) => out[ch * anchors + best];
  return corners(at(0), at(1), at(2), at(3), at(channels - 1));
}

/** The corners of a rotated box, going round (as Ultralytics' xywhr2xyxyxyxy). */
export function corners(cx: number, cy: number, w: number, h: number, angle: number): Pt[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const v1: Pt = [(w / 2) * cos, (w / 2) * sin];
  const v2: Pt = [(-h / 2) * sin, (h / 2) * cos];
  return [
    [cx + v1[0] + v2[0], cy + v1[1] + v2[1]],
    [cx + v1[0] - v2[0], cy + v1[1] - v2[1]],
    [cx - v1[0] - v2[0], cy - v1[1] - v2[1]],
    [cx - v1[0] + v2[0], cy - v1[1] + v2[1]],
  ];
}

/** RGBA pixels (MODEL_SIZE²) as the model's input: RGB planes, 0…1. */
export function toInput(rgba: ArrayLike<number>): Float32Array {
  const n = MODEL_SIZE * MODEL_SIZE;
  const out = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = rgba[j] / 255;
    out[n + i] = rgba[j + 1] / 255;
    out[2 * n + i] = rgba[j + 2] / 255;
  }
  return out;
}
