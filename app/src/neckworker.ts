import * as ort from "onnxruntime-web/webgpu";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { fitNeck } from "./fretfit";
import { decodeCells, decodeHand, MODEL_SIZE, toInput } from "./fretmodel";
import { drawCrop, fromCrop, type Crop } from "./neckcrop";
import type { Calibration, Pt } from "./neckmap";
import modelUrl from "./models/frets.onnx?url";

/**
 * Finds the neck off the main thread: a camera frame comes in, part of it (all of it,
 * or the box around where the neck was: neckcrop.ts) is turned and stretched to the
 * model's square here, the fret cells come out of the model, and fretfit.ts turns them
 * into the neck. Everything runs on the device; the model loads with the first frame.
 */

export interface NeckRequest {
  id: number;
  /** The camera frame, shrunk by `scale` (≤ 1). */
  bitmap: ImageBitmap;
  /** The part of the frame to look at, in frame pixels. */
  crop: Crop;
  /** Bitmap pixels per frame pixel. */
  scale: number;
  strings: number;
}

export type NeckResult =
  /**
   * `hand`: the fretting hand's box, in frame pixels, when the model sees it; `span`: the
   * fret wires the cells lay between, so a partial view is judged where it was seen.
   */
  | { ok: true; calibration: Calibration; cells: number; hand: Pt[] | null; span: [number, number] }
  /** No fret cells; cells, but too few that agree; the model couldn't run. */
  | { ok: false; reason: "no-neck" | "few-frets" | "failed"; message?: string };

// The "asyncify" build carries both backends, WebGPU and plain WebAssembly.
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
// Threads need a cross-origin isolated page, which the app's webview isn't.
ort.env.wasm.numThreads = 1;

let session: Promise<ort.InferenceSession> | null = null;
let square: OffscreenCanvasRenderingContext2D | null = null;

async function find(req: NeckRequest): Promise<NeckResult> {
  // On the GPU where the webview offers WebGPU (some ten times quicker), else on the CPU.
  session ??= ort.InferenceSession.create(modelUrl, { executionProviders: ["webgpu", "wasm"], graphOptimizationLevel: "all" });
  const s = await session;
  square ??= new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE).getContext("2d", { willReadFrequently: true });
  if (!square) throw new Error("no 2D canvas in the worker");
  const k = req.scale;
  const crop: Crop = { cx: req.crop.cx * k, cy: req.crop.cy * k, w: req.crop.w * k, h: req.crop.h * k, angle: req.crop.angle };
  drawCrop(square, req.bitmap, crop, MODEL_SIZE);
  req.bitmap.close();
  const input = new ort.Tensor("float32", toInput(square.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data), [1, 3, MODEL_SIZE, MODEL_SIZE]);
  const out = (await s.run({ [s.inputNames[0]]: input }))[s.outputNames[0]];
  const [, channels, anchors] = out.dims;
  const data = out.data as Float32Array;
  const cells = decodeCells(data, channels, anchors);
  if (!cells.length) return { ok: false, reason: "no-neck" };
  const hand = decodeHand(data, channels, anchors);
  const fit = fitNeck(cells, req.strings, hand);
  if (!fit) return { ok: false, reason: "few-frets" };
  const back = (p: Pt) => fromCrop(req.crop, MODEL_SIZE, p);
  return { ok: true, calibration: lowStringsUp(fit.calibration.map(back)) as unknown as Calibration, cells: fit.used, hand: hand?.map(back) ?? null, span: fit.span };
}

/**
 * The fit puts the low strings on the side higher in the model's square, which is turned
 * with the neck; in the frame, a guitar is held with them up. Unless the neck is nearly
 * upright (then "up" says nothing, and the tracker keeps the side it had).
 */
function lowStringsUp(c: Pt[]): Pt[] {
  const [nh, nl, th, tl] = c;
  const along = Math.atan2((th[1] + tl[1]) / 2 - (nh[1] + nl[1]) / 2, (th[0] + tl[0]) / 2 - (nh[0] + nl[0]) / 2);
  if (Math.abs(Math.cos(along)) < Math.cos((70 * Math.PI) / 180)) return c;
  const lowY = (nl[1] + tl[1]) / 2;
  const highY = (nh[1] + th[1]) / 2;
  return lowY <= highY ? c : [nl, nh, tl, th];
}

self.onmessage = async (e: MessageEvent<NeckRequest>) => {
  let result: NeckResult;
  try {
    result = await find(e.data);
  } catch (err) {
    session = null; // try loading again with the next frame
    result = { ok: false, reason: "failed", message: String(err) };
  } finally {
    e.data.bitmap.close();
  }
  self.postMessage({ id: e.data.id, result });
};
