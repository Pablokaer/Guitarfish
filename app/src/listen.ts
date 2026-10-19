import { accumulate, detectKey, spectrumChroma, type Chroma, type KeyResult } from "./key";

/** How long one listen lasts, and how often the spectrum is read. */
export const LISTEN_MS = 15_000;
const FRAME_MS = 100;
/** Frames quieter than this (dBFS at the loudest bin) are silence and skipped. */
const SILENCE_DB = -70;

export interface ListenProgress {
  /** 0…1 of LISTEN_MS. */
  progress: number;
  /** Best guess so far; null until something was heard. */
  result: KeyResult | null;
}

/**
 * Listens to the room through the microphone (Spotify through the speakers) and
 * guesses the key from the accumulated chroma. Nothing is recorded or kept: each
 * frame's spectrum is folded into 12 numbers and dropped.
 */
export class KeyListener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private done: ((r: KeyResult | null) => void) | null = null;
  private chroma: Chroma = new Array(12).fill(0);

  static supported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined";
  }

  get listening(): boolean {
    return this.timer !== null;
  }

  /**
   * Listens for LISTEN_MS (or until stop()) and resolves with the key heard, or
   * null if it was silent. Rejects when the microphone can't be opened.
   */
  async listen(onProgress: (p: ListenProgress) => void): Promise<KeyResult | null> {
    this.stop();
    // Raw signal: the browser's voice processing would filter out the music.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 16384; // ~2.7 Hz bins at 44.1 kHz: low strings a semitone apart stay apart
    analyser.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(analyser);
    this.stream = stream;
    this.ctx = ctx;
    this.chroma = new Array(12).fill(0);

    const frame = new Float32Array(analyser.frequencyBinCount);
    const started = performance.now();
    let heard = false;
    return new Promise((resolve) => {
      this.done = resolve;
      this.timer = setInterval(() => {
        analyser.getFloatFrequencyData(frame);
        let peak = -Infinity;
        for (const v of frame) if (v > peak) peak = v;
        if (peak > SILENCE_DB && accumulate(this.chroma, spectrumChroma(frame, ctx.sampleRate))) heard = true;
        const progress = Math.min(1, (performance.now() - started) / LISTEN_MS);
        onProgress({ progress, result: heard ? detectKey(this.chroma) : null });
        if (progress >= 1) this.stop();
      }, FRAME_MS);
    });
  }

  /** Ends listening early; the pending listen() resolves with what was heard. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
    const done = this.done;
    this.done = null;
    done?.(detectKey(this.chroma));
  }
}
