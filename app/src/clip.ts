import type { ClipMessage } from "./clipworker";

/**
 * Dev builds: records the camera as a clip, to replay the neck finding offline
 * (replay.ts) and measure changes to it. Unlike the training frames ("Record"), every
 * camera frame is kept, found or not, at full size, with when it was taken and what the
 * app did with it: whether the tracker took it, whether the model looked at it, and when
 * the model's answers came back. Frames are encoded and sent to the dev server
 * (vite.config.ts /__clip) by clipworker.ts, so the camera isn't held up.
 */

/** Frames being encoded at once; past this, frames the model didn't look at are left out. */
const MAX_PENDING = 8;
/** A clip stops by itself after this long, in ms (a 1080p clip is some 10 MB a second). */
export const CLIP_MAX = 60_000;

export type ClipEvent =
  /**
   * A camera frame: `at` when it was taken (ms), `tracked` passed to the tracker, `sent`
   * also to the model, `shown` the width it was passed to the tracker at, `saved` whether
   * its picture is in the clip (as `f<i>.jpg`).
   */
  | { t: "frame"; i: number; at: number; tracked: boolean; sent: boolean; shown: number; saved: boolean }
  /** The model's answer about the frame sent at `sentAt` came back. */
  | { t: "answer"; sentAt: number }
  /** The camera's picture changed size: the neck is forgotten. */
  | { t: "reset" };

export interface Clip {
  version: 1;
  session: string;
  width: number;
  height: number;
  strings: number;
  events: ClipEvent[];
}

export function frameName(i: number): string {
  return `f${String(i).padStart(5, "0")}.jpg`;
}

export class ClipRecorder {
  readonly session = new Date().toISOString().replace(/[:.]/g, "-");
  private events: ClipEvent[] = [];
  private frames = 0;
  private pending = 0;
  private startedAt = performance.now();
  private size: [number, number] | null = null;
  private worker = new Worker(new URL("./clipworker.ts", import.meta.url), { type: "module" });

  constructor(private strings: number) {
    this.worker.onmessage = () => this.pending--;
  }

  get seconds(): number {
    return (performance.now() - this.startedAt) / 1000;
  }

  get over(): boolean {
    return performance.now() - this.startedAt > CLIP_MAX;
  }

  /** The frame the video shows now; the rest is what the app is doing with it. */
  frame(video: HTMLVideoElement, at: number, info: { tracked: boolean; sent: boolean; shown: number }): void {
    const i = this.frames++;
    this.size ??= [video.videoWidth, video.videoHeight];
    const ev: ClipEvent = { t: "frame", i, at, ...info, saved: false };
    this.events.push(ev);
    if (this.pending >= MAX_PENDING && !info.sent) return;
    this.pending++;
    ev.saved = true;
    createImageBitmap(video).then(
      (bitmap) => this.post({ type: "frame", session: this.session, name: frameName(i), bitmap }, [bitmap]),
      (e) => {
        console.warn("clip frame", e);
        ev.saved = false;
        this.pending--;
      },
    );
  }

  answer(sentAt: number): void {
    this.events.push({ t: "answer", sentAt });
  }

  reset(): void {
    this.events.push({ t: "reset" });
  }

  /** Saves the clip's description once its frames are written, then lets the worker go. */
  stop(): void {
    const [width, height] = this.size ?? [0, 0];
    const clip: Clip = { version: 1, session: this.session, width, height, strings: this.strings, events: this.events };
    this.post({ type: "end", session: this.session, json: JSON.stringify(clip) });
  }

  private post(m: ClipMessage, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }
}
