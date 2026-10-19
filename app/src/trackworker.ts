import { NeckFollower, TRACK_W } from "./follower";
import type { NeckResult } from "./neckworker";
import type { GrayFrame } from "./tracker";

/**
 * Follows the neck off the main thread (follower.ts), so tracking never holds up the
 * picture. Each camera frame comes in as an ImageBitmap, is shrunk and turned grey here,
 * and goes back with the reply, so the main thread draws exactly the frame the neck was
 * tracked in. The model's answers are passed on by the main thread.
 */

export type TrackRequest =
  /** `sent`: this frame also went to the model. `at`: when it was taken, in the main thread's ms. */
  | { type: "frame"; id: number; bitmap: ImageBitmap; sent: boolean; strings: number; at: number }
  /** `at`: when the answer came, in the main thread's ms (the frames' clock). */
  | { type: "answer"; result: NeckResult; at: number }
  | { type: "reset" };

export interface TrackReply {
  id: number;
  /** The frame itself, handed back to be drawn (frame replies only). */
  bitmap: ImageBitmap | null;
  /** Where to draw the neck, in frame pixels; null when it isn't known. */
  neck: [number, number][] | null;
  /** Where the neck is before smoothing: where the model should look next. */
  raw: [number, number][] | null;
  miss: NeckFollower["miss"];
  locked: boolean;
  /** The fretting hand's box, frame pixels, as the model last saw it. */
  hand: [number, number][] | null;
}

const follower = new NeckFollower();
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let lastId = 0;

/** The frame shrunk to TRACK_W wide, in grey, and in colour. */
function gray(bitmap: ImageBitmap): { g: GrayFrame; rgba: Uint8ClampedArray } | null {
  const w = Math.min(TRACK_W, bitmap.width);
  const h = Math.round((w * bitmap.height) / bitmap.width);
  if (!ctx || ctx.canvas.width !== w || ctx.canvas.height !== h) ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // Shrunk with proper filtering: a one-step low-quality shrink aliases the thin strings
  // and fret wires into a shimmer the tracked points would cling to.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
  return { g: { width: w, height: h, data }, rgba: px };
}

function reply(id: number, bitmap: ImageBitmap | null = null): void {
  const msg: TrackReply = { id, bitmap, neck: follower.neck as TrackReply["neck"], raw: follower.raw as TrackReply["raw"], miss: follower.miss, locked: follower.locked, hand: follower.hand as TrackReply["hand"] };
  self.postMessage(msg, { transfer: bitmap ? [bitmap] : [] });
}

self.onmessage = (e: MessageEvent<TrackRequest>) => {
  const m = e.data;
  if (m.type === "frame") {
    follower.strings = m.strings;
    const f = gray(m.bitmap);
    if (f) follower.frame(f.g, m.bitmap.width, m.at, f.rgba);
    if (m.sent) follower.sent();
    lastId = m.id;
    reply(m.id, m.bitmap);
  } else if (m.type === "answer") {
    follower.answer(m.result, m.at);
    reply(lastId);
  } else {
    follower.reset();
  }
};
