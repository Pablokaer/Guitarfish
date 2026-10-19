import { NeckMap, type Calibration, type Pt } from "./neckmap";

/**
 * Where to look for the neck next, and how. A laptop webcam sees the whole player, so the
 * neck is a small part of the frame, and squeezed into the model's square its cells are
 * a few pixels wide. Once the neck is known, the model looks at a box around it instead,
 * blown up so the cells come out several times bigger, and turned so the neck lies across
 * it as in the model's training pictures, whatever angle it is held at (the model was
 * mostly shown necks within some 15° of level). The box keeps the frame's 16:9 shape,
 * as those pictures had.
 */

/** A box in the frame: centre, size along its own axes, and turn (radians, clockwise on screen). */
export interface Crop {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

/** Frets the box must hold, from the nut: the scale is drawn up to about here. */
const LAST_FRET = 15;
/** Room around the neck, as a share of its size: it may have moved since. */
const MARGIN = 0.35;
/** No more than this much zoom: past it the picture is too blurred to help. */
const MAX_ZOOM = 4;
/** A level box about this big (within this share either way) is as good as the whole frame. */
const WHOLE = 0.15;
/**
 * The neck from the nut to the 12th fret may take at most this share of the box's length:
 * the model was trained on necks up to about that size (nut to 12th ~46% of the picture, at
 * most ~63%). With the camera close to the neck, the box is grown past the frame — the
 * picture shrinks, with black around — until the frets are a size the model knows.
 */
const MAX_NECK_SHARE = 0.6;
/**
 * Necks tilted less than this are looked at level: the model was trained on necks held
 * a little tilted, as people do, and turning them square only costs a resampling.
 */
const MIN_TURN = (20 * Math.PI) / 180;

export function fullFrame(width: number, height: number): Crop {
  return { cx: width / 2, cy: height / 2, w: width, h: height, angle: 0 };
}

/** The whole frame turned by `angle`, grown to cover it. */
export function turnedFrame(width: number, height: number, angle: number): Crop {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const aspect = width / height;
  // Smallest box of the frame's shape, turned by `angle`, that holds the whole frame.
  const w = Math.max(width * c + height * s, (width * s + height * c) * aspect);
  return { cx: width / 2, cy: height / 2, w, h: w / aspect, angle };
}

/** Frame point → the box's own axes, from its centre. */
function toBox(c: Crop, [x, y]: Pt): Pt {
  const dx = x - c.cx;
  const dy = y - c.cy;
  const cos = Math.cos(c.angle);
  const sin = Math.sin(c.angle);
  return [dx * cos + dy * sin, -dx * sin + dy * cos];
}

/** The box around a neck seen at `cal` (frame pixels), turned level with it; the whole frame when that's as good. */
export function cropAround(cal: Calibration, strings: number, width: number, height: number): Crop {
  const map = NeckMap.from(cal, strings);
  if (!map) return fullFrame(width, height);
  // The neck's direction, kept within a quarter turn of level so the picture is never upside down.
  const a = map.fret(0, (strings - 1) / 2);
  const b = map.fret(12, (strings - 1) / 2);
  let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle <= -Math.PI / 2) angle += Math.PI;
  if (Math.abs(angle) < MIN_TURN || !Number.isFinite(angle)) angle = 0;

  // The part of the neck that's in the picture (all of it, if too little is).
  const along: Pt[] = [];
  for (let f = 0; f <= LAST_FRET; f++) for (const s of [-1, strings]) along.push(map.fret(f, s));
  const shown = along.filter(([x, y]) => x >= 0 && y >= 0 && x <= width && y <= height);
  const pts = shown.length >= 4 ? shown : [map.fret(0, -1), map.fret(0, strings), map.fret(LAST_FRET, -1), map.fret(LAST_FRET, strings)];
  const centre: Pt = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const local = pts.map((p) => toBox({ cx: centre[0], cy: centre[1], w: 0, h: 0, angle }, p));
  const xs = local.map((p) => p[0]);
  const ys = local.map((p) => p[1]);
  let [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = MARGIN * Math.max(x1 - x0, y1 - y0);
  [x0, x1, y0, y1] = [x0 - pad, x1 + pad, y0 - pad, y1 + pad];
  const aspect = width / height;
  // Not so tight the frets come out bigger than the model was trained on (camera close up).
  const mid = (strings - 1) / 2;
  const neckLength = Math.hypot(map.fret(12, mid)[0] - map.fret(0, mid)[0], map.fret(12, mid)[1] - map.fret(0, mid)[1]);
  const w = Math.max(x1 - x0, (y1 - y0) * aspect, width / MAX_ZOOM, neckLength / MAX_NECK_SHARE);
  const h = w / aspect;
  if (!Number.isFinite(w)) return fullFrame(width, height);
  if (angle === 0 && Math.abs(w / width - 1) <= WHOLE && Math.abs(h / height - 1) <= WHOLE) return fullFrame(width, height);
  // The box's centre, back in the frame.
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let cx = centre[0] + mx * cos - my * sin;
  let cy = centre[1] + mx * sin + my * cos;
  if (angle === 0 && w <= width && h <= height) {
    // Level: kept inside the frame.
    cx = Math.min(Math.max(w / 2, cx), width - w / 2);
    cy = Math.min(Math.max(h / 2, cy), height - h / 2);
  }
  return { cx, cy, w, h, angle };
}

/** A point in the box's model square (size × size) back in frame pixels. */
export function fromCrop(c: Crop, size: number, [u, v]: Pt): Pt {
  const x = (u / size - 0.5) * c.w;
  const y = (v / size - 0.5) * c.h;
  const cos = Math.cos(c.angle);
  const sin = Math.sin(c.angle);
  return [c.cx + x * cos - y * sin, c.cy + x * sin + y * cos];
}

/**
 * Draws box `c` of `source` into `ctx` as a size × size square (stretched, as the
 * model's training pictures were); outside the frame stays black.
 */
export function drawCrop(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, source: CanvasImageSource, c: Crop, size: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);
  ctx.scale(size / c.w, size / c.h);
  ctx.rotate(-c.angle);
  ctx.translate(-c.cx, -c.cy);
  // Shrinking a big frame several times over: filtered properly, as the training
  // pictures were, or thin fret wires flicker in and out.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * Where to look while the neck isn't known, in turn: the whole frame level and turned
 * either way (a neck held at 2 or 4 o'clock), then its middle and its two sides, each
 * blown up, since a guitar far from the camera is too small to find in the whole frame,
 * the frame shrunk inside a bigger box, for a neck seen so close its frets are bigger than
 * the model knows, and last the frame turned steeply, for a neck held nearly upright.
 */
export function searchCrops(width: number, height: number): Crop[] {
  const turn = (35 * Math.PI) / 180;
  const steep = (70 * Math.PI) / 180;
  const part = (fx: number, f: number, angle = 0): Crop => ({ cx: (fx + f / 2) * width, cy: height / 2, w: f * width, h: f * height, angle });
  // The whole frame shrunk inside a bigger box (black around): a neck seen close up.
  const far = (k: number): Crop => ({ cx: width / 2, cy: height / 2, w: width * k, h: height * k, angle: 0 });
  return [
    fullFrame(width, height),
    turnedFrame(width, height, -turn),
    turnedFrame(width, height, turn),
    far(2),
    far(3),
    part(0.2, 0.6),
    part(0, 0.6),
    part(0.4, 0.6),
    part(0.2, 0.6, -turn),
    part(0.2, 0.6, turn),
    // A neck held nearly upright.
    turnedFrame(width, height, -steep),
    turnedFrame(width, height, steep),
  ];
}
