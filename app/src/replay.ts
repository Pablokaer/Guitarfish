import { frameName, type Clip } from "./clip";
import { offGaps } from "./follower";
import { CropPlan, modelScale, shrunk } from "./neckcrop";
import { NeckMap, type Calibration, type Pt } from "./neckmap";
import type { NeckRequest, NeckResult } from "./neckworker";
import { summarize, type ReplayStats, type Sample } from "./replaymetrics";
import type { TrackReply, TrackRequest } from "./trackworker";

/**
 * Dev server only (replay.html): replays a clip recorded in the app (fretcam "Clip",
 * clip.ts) through the very same neck finding — the model's worker and the tracker's —
 * and measures how well the neck was followed (replaymetrics.ts). The frames go through
 * as they did live: the ones the tracker took, the model looking at the same ones and
 * answering when it did, so a change to the neck finding can be measured on the same
 * footage, again and again. One at a time, waiting for each, so a slow machine (or the
 * model on the CPU) gives the same answers, only later.
 *
 *   replay.html               the clips recorded
 *   replay.html?clip=<name>   replays one; `npm run replay` does it headless
 */

export interface ReplayResult {
  clip: string;
  /** Where the model ran: results on one aren't quite comparable with the other. */
  backend: "webgpu" | "wasm";
  /** Frames the tracker took live that the clip has no picture of (left out while recording). */
  missing: number;
  stats: ReplayStats;
  /** Each frame replayed (`i`: its number in the clip): where the neck and hand were, to label pictures from. */
  frames: { i: number; raw: [number, number][] | null; locked: boolean; hand: [number, number][] | null }[];
}

declare global {
  interface Window {
    replayResult?: ReplayResult;
    replayError?: string;
  }
}

const out = document.querySelector<HTMLPreElement>("#out")!;
const canvas = document.querySelector<HTMLCanvasElement>("#view")!;

/** Posts `msg` and waits for the worker's reply (one request at a time). */
function ask<T>(w: Worker, msg: unknown, transfer: Transferable[] = []): Promise<T> {
  return new Promise((done, fail) => {
    w.onmessage = (e: MessageEvent<T>) => done(e.data);
    w.onerror = (e) => fail(new Error(e.message));
    w.postMessage(msg, transfer);
  });
}

async function listClips(): Promise<void> {
  const names = (await (await fetch("/__clips")).json()) as string[];
  out.innerHTML = names.length
    ? names.map((n) => `<a href="?clip=${encodeURIComponent(n)}">${n}</a>`).join("\n")
    : "No clips yet: in a dev build, open the scale on camera and press Clip.";
}

async function replay(name: string): Promise<ReplayResult> {
  const clip = (await (await fetch(`/__clips/${encodeURIComponent(name)}/clip.json`)).json()) as Clip;
  const { width: vw, height: vh, strings } = clip;
  const track = new Worker(new URL("./trackworker.ts", import.meta.url), { type: "module" });
  const model = new Worker(new URL("./neckworker.ts", import.meta.url), { type: "module" });
  // The model's worker uses WebGPU when there's an adapter (neckworker.ts).
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const backend = (await gpu?.requestAdapter().catch(() => null)) ? "webgpu" : "wasm";
  const crops = new CropPlan();
  const samples: Sample[] = [];
  const found: ReplayResult["frames"] = [];
  const disagreements: number[] = [];
  const answers = { ok: 0, noNeck: 0, fewFrets: 0, failed: 0 };
  let raw: Pt[] | null = null;
  /** The model's answer about the frame last sent, until the clip says it came back. */
  let pending: NeckResult | null = null;
  let missing = 0;
  let id = 0;
  const frames = clip.events.filter((e) => e.t === "frame" && e.tracked).length;

  for (const ev of clip.events) {
    if (ev.t === "reset") {
      track.postMessage({ type: "reset" } satisfies TrackRequest);
      raw = null;
      pending = null;
    } else if (ev.t === "answer") {
      if (!pending) continue;
      const r = await ask<TrackReply>(track, { type: "answer", result: pending, at: ev.sentAt } satisfies TrackRequest);
      raw = r.raw;
      pending = null;
    } else if (ev.tracked) {
      const res = ev.saved ? await fetch(`/__clips/${encodeURIComponent(name)}/${frameName(ev.i)}`) : null;
      if (!res?.ok) {
        missing++;
        continue;
      }
      const picture = await createImageBitmap(await res.blob());
      let result: NeckResult | null = null;
      if (ev.sent) {
        const crop = crops.next(raw, strings, vw, vh);
        const scale = modelScale(crop);
        const bitmap = await createImageBitmap(picture, shrunk(vw, vh, scale));
        const req: NeckRequest = { id: ++id, bitmap, crop, scale, strings };
        result = (await ask<{ id: number; result: NeckResult }>(model, req, [bitmap])).result;
        if (result.ok) answers.ok++;
        else answers[result.reason === "no-neck" ? "noNeck" : result.reason === "few-frets" ? "fewFrets" : "failed"]++;
        pending = result;
      }
      const bitmap = await createImageBitmap(picture, shrunk(vw, vh, ev.shown / vw));
      picture.close();
      const msg: TrackRequest = { type: "frame", id: ++id, bitmap, width: vw, sent: ev.sent, strings, at: ev.at };
      const r = await ask<TrackReply>(track, msg, [bitmap]);
      raw = r.raw;
      samples.push({ at: ev.at, neck: r.neck, locked: r.locked });
      found.push({ i: ev.i, raw: r.raw, locked: r.locked, hand: r.hand });
      // The model's answer against where the neck was tracked in the frame it looked at.
      if (result?.ok && r.raw) {
        const c = result.calibration;
        const swapped = [c[1], c[0], c[3], c[2]];
        disagreements.push(Math.min(offGaps(c, r.raw, result.span, strings), offGaps(swapped, r.raw, result.span, strings)));
      }
      if (r.bitmap) {
        draw(r.bitmap, r.neck, r.locked, vw, strings);
        r.bitmap.close();
      }
      if (samples.length % 10 === 0) out.textContent = `${name}: frame ${samples.length} of ${frames} (model: ${backend})…`;
    }
  }
  track.terminate();
  model.terminate();
  return { clip: name, backend, missing, stats: summarize(samples, answers, disagreements), frames: found };
}

/** The frame, and the neck as drawn (green: locked on). */
function draw(frame: ImageBitmap, neck: [number, number][] | null, locked: boolean, vw: number, strings: number): void {
  const w = Math.min(960, frame.width);
  const h = Math.round((w * frame.height) / frame.width);
  if (canvas.width !== w) [canvas.width, canvas.height] = [w, h];
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(frame, 0, 0, w, h);
  const map = neck && NeckMap.from(neck as unknown as Calibration, strings);
  if (!map) return;
  const k = w / vw;
  ctx.strokeStyle = locked ? "#1ed760" : "#f5a623";
  ctx.lineWidth = 1.5;
  for (let f = 0; f <= 12; f++) {
    const [a, b] = [map.fret(f, -0.3), map.fret(f, strings - 0.7)];
    ctx.beginPath();
    ctx.moveTo(a[0] * k, a[1] * k);
    ctx.lineTo(b[0] * k, b[1] * k);
    ctx.stroke();
  }
}

const name = new URLSearchParams(location.search).get("clip");
if (!name) {
  void listClips();
} else {
  replay(name).then(
    (r) => {
      window.replayResult = r;
      out.textContent = JSON.stringify(r, null, 2);
    },
    (e) => {
      window.replayError = String(e);
      out.textContent = `Replay failed: ${String(e)}`;
    },
  );
}
