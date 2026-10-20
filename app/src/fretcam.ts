import type { ClipRecorder } from "./clip";
import { TRACK_W, type Miss } from "./follower";
import { CropPlan, modelScale, shrunk, type Crop } from "./neckcrop";
import { DEFAULT_CAM, fretDistance, NeckMap, parseCamSettings, type Calibration, type CamSettings, type Pt } from "./neckmap";
import type { NeckRequest, NeckResult } from "./neckworker";
import type { TrackReply, TrackRequest } from "./trackworker";

/**
 * The Solos scale drawn over the camera picture of the user's own guitar. A model finds
 * the frets (neckworker.ts) a few times a second; every frame in between, the neck is
 * tracked (trackworker.ts, follower.ts). Both run off the main thread, which only takes
 * each frame (as ImageBitmaps, on the GPU) and draws it with the notes on one canvas:
 * the notes are drawn on the very frame they were tracked in, so they can't trail the
 * picture. Nothing is recorded or sent anywhere (but in dev builds, on request: "Record",
 * "Clip").
 */

export interface CamDot {
  string: number;
  fret: number;
  label: string;
  root: boolean;
  /** Outside the chosen position: drawn faint. */
  dim: boolean;
}

export interface CamScene {
  /** e.g. "E Minor pentatonic". */
  title: string;
  strings: number;
  /** Frets to draw guides for, from the nut. */
  frets: number;
  dots: CamDot[];
  positions: { number: number; minFret: number; maxFret: number }[];
  /** 0 = whole neck. */
  position: number;
}

export interface CamActions {
  setPosition(n: number): void;
}

const STORE_KEY = "tabsync.fretcam";
/** At most this often, in ms (slower devices go as fast as the model does). */
const DETECT_EVERY = 90;
/** Frames with the tracker at once: one being tracked, the next already taken. */
const IN_FLIGHT = 2;
/** Dev builds: while recording, a frame and its neck are saved this often, in ms (vite.config.ts /__capture). */
const RECORD_EVERY = 500;
/** Below this many frames a second the neck blurs and the tracker falls behind; a smaller picture is better. */
const MIN_FPS = 24;
/** A frame's capture time further than this from now (ms) is on some other clock: not used. */
const CLOCK_SLACK = 1000;

const MISS_HINT: Record<Miss, string> = {
  loading: "Getting the fret finder ready…",
  "no-neck": "Looking for the neck… Hold the guitar with the neck across the picture, in good light.",
  "few-frets": "Neck found. Show more of it: at least three frets, not all under your hand.",
  failed: "The fret finder couldn't start on this device.",
};

function loadSettings(): CamSettings {
  try {
    return parseCamSettings(JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_CAM };
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export class FretCam {
  private root: HTMLDivElement | null = null;
  private bar!: HTMLDivElement;
  private box!: HTMLDivElement;
  private stage!: HTMLDivElement;
  private video!: HTMLVideoElement;
  private canvas!: HTMLCanvasElement;
  private msg!: HTMLParagraphElement;
  private stream: MediaStream | null = null;
  private resize: ResizeObserver | null = null;
  private settings = loadSettings();
  private error: string | null = null;
  private scene: CamScene | null = null;
  /** Where to draw the neck, and where the model should look next (frame pixels). */
  private neck: Pt[] | null = null;
  private raw: Pt[] | null = null;
  private miss: Miss = "loading";
  private trackWorker: Worker | null = null;
  private modelWorker: Worker | null = null;
  /** Frames with the tracker; more are skipped while it's full. */
  private inFlight = 0;
  private modelBusy = false;
  private sentAt = 0;
  private frameId = 0;
  /** The frame on screen, kept to redraw the notes over it. */
  private shown: ImageBitmap | null = null;
  private crops = new CropPlan();
  /** Each camera request and frame loop gets a number; only the newest one may act. */
  private startGen = 0;
  private loopGen = 0;
  /** Bumped on every close: work started before it belongs to the old session. */
  private session = 0;
  /** The theme's colours, read once per open (not on every frame). */
  private accent = "#1ed760";
  private accentInk = "#04140a";
  /** Dev builds: saving frames to train the model on this guitar. */
  private recording: { session: string; count: number; lastAt: number } | null = null;
  /** Dev builds: recording a clip, to replay the neck finding offline (clip.ts, replay.ts). */
  private clip: ClipRecorder | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.close();
  };
  /** Hidden: the camera goes off (light, battery); shown again: back on. */
  private onVisible = () => {
    if (!this.root) return;
    if (document.hidden) {
      if (this.stream) {
        this.stop();
        this.paused = true;
      }
    } else if (this.paused) {
      this.paused = false;
      void this.start();
    }
  };
  private paused = false;

  constructor(private act: CamActions) {}

  static supported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof Worker !== "undefined" &&
      typeof OffscreenCanvas !== "undefined" &&
      typeof createImageBitmap === "function"
    );
  }

  get isOpen(): boolean {
    return this.root !== null;
  }

  async open(scene: CamScene): Promise<void> {
    this.scene = scene;
    if (this.root) return this.update(scene);
    const root = document.createElement("div");
    root.className = "fretcam";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Scale on camera");
    root.innerHTML = `
      <div class="fretcam-bar"></div>
      <div class="fretcam-box"><div class="fretcam-stage"><video playsinline muted autoplay></video><canvas></canvas></div></div>
      <p class="fretcam-msg hint" aria-live="polite"></p>`;
    this.root = root;
    this.bar = root.querySelector(".fretcam-bar")!;
    this.box = root.querySelector(".fretcam-box")!;
    this.stage = root.querySelector(".fretcam-stage")!;
    this.video = root.querySelector("video")!;
    this.canvas = root.querySelector("canvas")!;
    this.msg = root.querySelector(".fretcam-msg")!;
    this.video.addEventListener("loadedmetadata", () => this.frameReady());
    this.video.addEventListener("resize", () => this.frameReady());
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(this.box);
    document.addEventListener("keydown", this.onKey);
    document.addEventListener("visibilitychange", this.onVisible);
    document.body.append(root);
    const css = getComputedStyle(document.documentElement);
    this.accent = css.getPropertyValue("--accent").trim() || "#1ed760";
    this.accentInk = css.getPropertyValue("--accent-ink").trim() || "#04140a";
    this.renderBar();
    this.startWorkers();
    this.loop();
    await this.start();
  }

  /** New key, scale or position while open. */
  update(scene: CamScene): void {
    this.scene = scene;
    if (!this.root) return;
    this.renderBar();
    this.draw();
  }

  close(): void {
    this.stopClip();
    this.stop();
    this.loopGen++;
    this.session++;
    this.paused = false;
    this.trackWorker?.terminate();
    this.modelWorker?.terminate();
    this.trackWorker = this.modelWorker = null;
    this.inFlight = 0;
    this.modelBusy = false;
    this.shown?.close();
    this.shown = null;
    this.neck = this.raw = null;
    this.resize?.disconnect();
    this.resize = null;
    document.removeEventListener("keydown", this.onKey);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.root?.remove();
    this.root = null;
  }

  // ---- Camera ---------------------------------------------------------------------

  private async start(): Promise<void> {
    const gen = ++this.startGen;
    this.error = null;
    this.renderMsg();
    try {
      const stream = await this.openCamera();
      if (!this.root || gen !== this.startGen) {
        stream.getTracks().forEach((t) => t.stop()); // closed, or asked again, while asking
        return;
      }
      // Unplugged, taken by another app, or stopped by the system: say so, don't freeze.
      for (const t of stream.getVideoTracks()) {
        t.addEventListener("ended", () => {
          if (this.stream !== stream) return;
          this.stop();
          this.error = "The camera stopped (unplugged, or taken by another app). Press Switch camera, or close and open again.";
          this.renderMsg();
        });
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play().catch(() => undefined);
    } catch (e) {
      if (gen !== this.startGen) return;
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      const missing = e instanceof DOMException && (e.name === "NotFoundError" || e.name === "OverconstrainedError");
      this.error = denied
        ? "Camera access was denied. Allow it for Guitarfish in the system settings."
        : missing
          ? "No camera was found."
          : `Could not open the camera: ${String(e)}`;
      this.renderMsg();
    }
  }

  /**
   * Native frames, not rescaled ones, at a usable frame rate, kept in focus and exposed as
   * the light changes: the frets are thin, and a soft or rescaled picture loses them. A
   * camera that can't do that in full HD gets a smaller native size (720p at 30 rather
   * than 1080p at 15); one that can't at all, whatever it offers.
   */
  private async openCamera(): Promise<MediaStream> {
    const base = { facingMode: { ideal: this.settings.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    const best = {
      ...base,
      frameRate: { min: MIN_FPS, ideal: 30 },
      resizeMode: { ideal: "none" },
      advanced: [{ focusMode: "continuous" }, { exposureMode: "continuous" }],
    } as unknown as MediaTrackConstraints;
    try {
      return await navigator.mediaDevices.getUserMedia({ video: best, audio: false });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "OverconstrainedError")) throw e;
      return navigator.mediaDevices.getUserMedia({ video: { ...base, frameRate: { ideal: 30 } }, audio: false });
    }
  }

  private stop(): void {
    this.startGen++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.root) this.video.srcObject = null;
  }

  private frameReady(): void {
    if (!this.video.videoWidth || !this.video.videoHeight) return;
    this.post({ type: "reset" });
    this.clip?.reset();
    this.neck = this.raw = null;
    this.fit();
    this.renderMsg();
  }

  /** Sizes the stage to the video's aspect ratio inside the free space, and the canvas to its pixels. */
  private fit(): void {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;
    const bw = this.box.clientWidth;
    const bh = this.box.clientHeight;
    const w = Math.floor(Math.min(bw, (bh * vw) / vh));
    const h = Math.floor((w * vh) / vw);
    this.stage.style.width = `${w}px`;
    this.stage.style.height = `${h}px`;
    const dpr = window.devicePixelRatio || 1;
    // No more pixels than the camera has.
    const cw = Math.max(1, Math.round(Math.min(w * dpr, vw)));
    this.canvas.width = cw;
    this.canvas.height = Math.max(1, Math.round((cw * vh) / vw));
    this.draw();
  }

  // ---- Workers ----------------------------------------------------------------------

  private startWorkers(): void {
    try {
      this.trackWorker = new Worker(new URL("./trackworker.ts", import.meta.url), { type: "module" });
      this.modelWorker = new Worker(new URL("./neckworker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      console.warn("fret finder workers", e);
      this.miss = "failed";
      this.renderMsg();
      return;
    }
    this.trackWorker.onmessage = (e: MessageEvent<TrackReply>) => this.tracked(e.data);
    this.modelWorker.onmessage = (e: MessageEvent<{ id: number; result: NeckResult }>) => {
      this.modelBusy = false;
      const r = e.data.result;
      if (!r.ok && r.message) console.warn("fret finder", r.message);
      this.clip?.answer(this.sentAt);
      // Timed by the frame it describes, not by when it came: a slow answer is an old one.
      this.post({ type: "answer", result: r, at: this.sentAt });
    };
    const failed = (e: ErrorEvent) => {
      console.warn("fret finder worker", e.message);
      this.inFlight = 0;
      this.modelBusy = false;
      this.miss = "failed";
      this.renderMsg();
    };
    this.trackWorker.onerror = failed;
    this.modelWorker.onerror = failed;
  }

  private post(m: TrackRequest, transfer: Transferable[] = []): void {
    this.trackWorker?.postMessage(m, transfer);
  }

  // ---- Frames -----------------------------------------------------------------------

  /**
   * Every video frame: take it (unless the tracker is full) and hand it on. Without
   * requestVideoFrameCallback, on each screen refresh that shows a new frame.
   */
  private loop(): void {
    const v = this.video;
    const gen = ++this.loopGen;
    const byFrame = "requestVideoFrameCallback" in v;
    let lastFrames = -1;
    let lastTime = -1;
    const next = () => (byFrame ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step));
    const step = (_now?: number, meta?: VideoFrameCallbackMetadata) => {
      if (gen !== this.loopGen || !this.root) return;
      if (byFrame) {
        // When the camera took the frame, if the browser says (same clock as performance.now()).
        const now = performance.now();
        const at = meta?.captureTime ?? meta?.expectedDisplayTime ?? now;
        void this.onFrame(Math.abs(at - now) <= CLOCK_SLACK ? at : now);
      } else {
        // A new frame shows as a new count, or (where the count stays 0 for cameras) a new time.
        const frames = this.video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
        const time = this.video.currentTime;
        if (frames > 0 ? frames !== lastFrames : time !== lastTime) void this.onFrame(performance.now());
        lastFrames = frames;
        lastTime = time;
      }
      next();
    };
    next();
  }

  /** `at`: when the frame was taken, on this thread's clock: the tracker times the neck by it. */
  private async onFrame(at: number): Promise<void> {
    const v = this.video;
    if (!this.trackWorker || !this.stream || !v.videoWidth || v.readyState < 2) return;
    const [vw, vh] = [v.videoWidth, v.videoHeight];
    const busy = this.inFlight >= IN_FLIGHT;
    const toModel = !busy && !this.modelBusy && !!this.modelWorker && at - this.sentAt >= DETECT_EVERY;
    // Shrunk on the GPU while they're taken, to no more than they're used at: the frame
    // on screen to the canvas (and enough for the tracker); the model's copy so its crop
    // still has every pixel the model's square can show. Recording keeps full frames.
    const shown = this.recording ? vw : Math.min(vw, Math.max(TRACK_W, this.canvas.width));
    if (this.clip) {
      this.clip.frame(v, at, { tracked: !busy, sent: toModel, shown });
      if (this.clip.over) this.stopClip();
    }
    if (busy) return;
    const [stream, session] = [this.stream, this.session];
    const strings = this.scene?.strings ?? 6;
    let crop: Crop | null = null;
    if (toModel) {
      crop = this.crops.next(this.raw, strings, vw, vh);
      this.modelBusy = true;
      this.sentAt = at;
    }
    this.inFlight++;
    const scale = crop ? modelScale(crop) : 1;
    let bitmaps: (ImageBitmap | null)[];
    try {
      bitmaps = await Promise.all([
        createImageBitmap(v, shrunk(vw, vh, shown / vw)),
        crop ? createImageBitmap(v, shrunk(vw, vh, scale)) : Promise.resolve(null),
      ]);
    } catch (e) {
      console.warn("taking a camera frame failed", e);
      if (session === this.session) {
        this.inFlight--;
        if (toModel) this.modelBusy = false;
      }
      return;
    }
    const [frame, full] = bitmaps;
    if (session !== this.session || stream !== this.stream || !this.trackWorker) {
      // Closed, or the camera changed, while the frame was taken: it's of the old one.
      bitmaps.forEach((b) => b?.close());
      if (session === this.session) {
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (toModel) this.modelBusy = false;
      }
      return;
    }
    const id = ++this.frameId;
    if (full && crop) {
      const req: NeckRequest = { id, bitmap: full, crop, scale, strings };
      this.modelWorker!.postMessage(req, [full]);
    }
    this.post({ type: "frame", id, bitmap: frame!, width: vw, sent: !!full, strings, at }, [frame!]);
  }

  /** The tracker's word on a frame (or on the model's latest answer): draw. */
  private tracked(r: TrackReply): void {
    this.neck = r.neck;
    this.raw = r.raw;
    this.miss = r.miss;
    if (r.bitmap) {
      // A frame's reply: that very frame goes on screen with the neck found in it.
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.shown?.close();
      this.shown = r.bitmap;
      // Only frames the neck is locked onto: the rest would be labelled with a guess.
      if (this.recording && r.locked && r.raw && performance.now() - this.recording.lastAt >= RECORD_EVERY) void this.capture(r);
    }
    this.draw();
    this.renderMsg();
  }

  /** Dev builds: saves the frame on screen and the neck found in it, for training. */
  private async capture(r: TrackReply): Promise<void> {
    const rec = this.recording;
    if (!rec || !this.shown) return;
    rec.lastAt = performance.now();
    const frame = await createImageBitmap(this.shown);
    const canvas = new OffscreenCanvas(frame.width, frame.height);
    canvas.getContext("2d")!.drawImage(frame, 0, 0);
    frame.close();
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    const meta = JSON.stringify({
      session: rec.session,
      name: `f${String(++rec.count).padStart(5, "0")}`,
      width: canvas.width,
      height: canvas.height,
      strings: this.scene?.strings ?? 6,
      neck: r.raw,
      locked: r.locked,
      hand: r.hand,
      at: new Date().toISOString(),
    });
    const head = new Uint8Array(4);
    const json = new TextEncoder().encode(meta);
    new DataView(head.buffer).setUint32(0, json.length);
    await fetch("/__capture", { method: "POST", body: new Blob([head, json, jpeg]) }).catch((e) => console.warn("capture failed", e));
    this.renderBar();
  }

  private map(): NeckMap | null {
    return this.neck && this.scene ? NeckMap.from(this.neck as unknown as Calibration, this.scene.strings) : null;
  }

  private stopClip(): void {
    if (!this.clip) return;
    const clip = this.clip;
    this.clip = null;
    clip.stop();
    console.info(`clip ${clip.session}: ${clip.seconds.toFixed(1)} s (npm run replay -- ${clip.session})`);
    if (this.root) this.renderBar();
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable: kept for this session only */
    }
  }

  // ---- Rendering ------------------------------------------------------------------

  private renderBar(): void {
    const s = this.scene;
    if (!s) return;
    this.bar.innerHTML = `
      <div class="fretcam-title"><b>${esc(s.title)}</b></div>
      <div class="segmented" role="group" aria-label="Position">
        <button type="button" data-pos="0" aria-pressed="${s.position === 0}">All</button>
        ${s.positions.map((p) => `<button type="button" data-pos="${p.number}" aria-pressed="${s.position === p.number}" title="Frets ${p.minFret}–${p.maxFret}">${p.number}</button>`).join("")}
      </div>
      <div class="fretcam-actions">
        <button class="btn small" type="button" data-act="mirror" aria-pressed="${this.settings.mirror}">Mirror</button>
        <button class="btn small" type="button" data-act="flip">Switch camera</button>
        ${import.meta.env.DEV ? `<button class="btn small" type="button" data-act="record" aria-pressed="${!!this.recording}" title="Save frames to train the fret model on this guitar">${this.recording ? `Recording · ${this.recording.count}` : "Record"}</button>` : ""}
        ${import.meta.env.DEV ? `<button class="btn small" type="button" data-act="clip" aria-pressed="${!!this.clip}" title="Record a clip to replay the neck finding offline (npm run replay)">${this.clip ? "Stop clip" : "Clip"}</button>` : ""}
        <button class="btn small primary" type="button" data-act="close">Done</button>
      </div>`;
    this.bar.querySelectorAll<HTMLButtonElement>("[data-pos]").forEach((b) => (b.onclick = () => this.act.setPosition(Number(b.dataset.pos))));
    this.bar.querySelector<HTMLButtonElement>("[data-act=close]")!.onclick = () => this.close();
    this.bar.querySelector<HTMLButtonElement>("[data-act=mirror]")!.onclick = () => {
      this.settings.mirror = !this.settings.mirror;
      this.save();
      this.renderBar();
      this.draw();
    };
    this.bar.querySelector<HTMLButtonElement>("[data-act=record]")?.addEventListener("click", () => {
      this.recording = this.recording ? null : { session: new Date().toISOString().replace(/[:.]/g, "-"), count: 0, lastAt: 0 };
      this.renderBar();
    });
    // Loaded only in dev builds: production has no clip code at all.
    if (import.meta.env.DEV) {
      this.bar.querySelector<HTMLButtonElement>("[data-act=clip]")?.addEventListener("click", async () => {
        if (this.clip) return this.stopClip();
        const { ClipRecorder } = await import("./clip");
        // The tracker starts afresh with the clip, as it will when the clip is replayed.
        this.clip = new ClipRecorder(this.scene?.strings ?? 6);
        this.post({ type: "reset" });
        this.neck = this.raw = null;
        this.renderBar();
      });
    }
    this.bar.querySelector<HTMLButtonElement>("[data-act=flip]")!.onclick = () => {
      this.stopClip();
      this.settings.facing = this.settings.facing === "user" ? "environment" : "user";
      this.settings.mirror = this.settings.facing === "user";
      this.save();
      this.stop();
      this.post({ type: "reset" });
      this.neck = this.raw = null;
      this.renderBar();
      this.draw();
      void this.start();
    };
  }

  private renderMsg(): void {
    if (!this.root) return;
    this.msg.classList.toggle("solos-error", !!this.error);
    const text = this.error ?? (!this.video.videoWidth ? "Opening the camera…" : this.map() ? "Root notes are green." : MISS_HINT[this.miss]);
    if (this.msg.textContent !== text) this.msg.textContent = text;
  }

  /** The frame on screen, and the neck's notes over it. */
  private draw(): void {
    const ctx = this.canvas.getContext("2d");
    const vw = this.video.videoWidth;
    if (!ctx || !vw) return;
    const { width: cw, height: ch } = this.canvas;
    const mirror = this.settings.mirror;
    if (this.shown) {
      ctx.save();
      if (mirror) {
        ctx.translate(cw, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(this.shown, 0, 0, cw, ch);
      ctx.restore();
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cw, ch);
    }
    const map = this.map();
    const s = this.scene;
    if (!map || !s) return;
    // Frame pixels → canvas pixels; mirroring flips the picture, not the text.
    const k = cw / vw;
    const X = ([x, y]: Pt): Pt => (mirror ? [cw - x * k, y * k] : [x * k, y * k]);
    const dpr = window.devicePixelRatio || 1;
    const { accent, accentInk } = this;

    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = "rgb(255 255 255 / 0.35)";
    for (let f = 0; f <= s.frets; f++) line(ctx, X(map.fret(f, -0.3)), X(map.fret(f, s.strings - 0.7)));
    ctx.strokeStyle = "rgb(255 255 255 / 0.18)";
    for (let i = 0; i < s.strings; i++) line(ctx, X(map.at(-0.05, i)), X(map.at(fretDistance(s.frets), i)));

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Faint dots first, so the chosen position stays on top.
    const dots = [...s.dots].sort((a, b) => Number(b.dim) - Number(a.dim));
    for (const d of dots) {
      const note = map.note(d.string, d.fret);
      const [x, y] = X(note.p);
      const r = note.r * k;
      ctx.globalAlpha = d.dim ? 0.3 : 0.92;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = d.root ? accent : "#1d2530";
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.fillStyle = d.root ? accentInk : "#ffffff";
      ctx.font = `600 ${Math.round(r * (d.label.length > 2 ? 0.8 : 1))}px system-ui, sans-serif`;
      ctx.fillText(d.label, x, y + r * 0.05);
    }
    ctx.globalAlpha = 1;
  }
}

function line(ctx: CanvasRenderingContext2D, a: Pt, b: Pt): void {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}
