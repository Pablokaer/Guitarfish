/**
 * Dev builds: encodes a clip's frames (clip.ts) as JPEG and sends them to the dev server
 * (vite.config.ts /__clip), one after the other, so the clip's description comes last.
 */

export type ClipMessage =
  | { type: "frame"; session: string; name: string; bitmap: ImageBitmap }
  /** The clip is over: `json` is its description (clip.json); the worker closes after it. */
  | { type: "end"; session: string; json: string };

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let queue = Promise.resolve();

/** Body: 4-byte length of the JSON, the JSON, then the file. */
async function save(session: string, name: string, file: Blob): Promise<void> {
  const head = new Uint8Array(4);
  const json = new TextEncoder().encode(JSON.stringify({ session, name }));
  new DataView(head.buffer).setUint32(0, json.length);
  const res = await fetch("/__clip", { method: "POST", body: new Blob([head, json, file]) });
  if (!res.ok) throw new Error(`saving ${name}: ${res.status}`);
}

async function handle(m: ClipMessage): Promise<void> {
  if (m.type === "end") {
    await save(m.session, "clip.json", new Blob([m.json], { type: "application/json" }));
    self.close();
    return;
  }
  const { bitmap } = m;
  try {
    if (!ctx || ctx.canvas.width !== bitmap.width || ctx.canvas.height !== bitmap.height) ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    if (!ctx) throw new Error("no 2D canvas in the worker");
    ctx.drawImage(bitmap, 0, 0);
    const jpeg = await (ctx.canvas as OffscreenCanvas).convertToBlob({ type: "image/jpeg", quality: 0.92 });
    await save(m.session, m.name, jpeg);
  } finally {
    bitmap.close();
    self.postMessage("done");
  }
}

self.onmessage = (e: MessageEvent<ClipMessage>) => {
  queue = queue.then(() => handle(e.data)).catch((err) => console.warn("clip", err));
};
