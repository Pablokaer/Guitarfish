import type { LocalTrack } from "./music";
import { current, jumpTo, newQueue, next, parseQueue, previous, setRepeat, setShuffle, withItems, type Queue, type RepeatMode, type Rng } from "./queue";
import type { Track } from "./types";

/**
 * The local MP3 player: one media element that streams the current file (from disk
 * through the asset protocol, or from the library's copy), with the play queue,
 * speed, A/B loop and volume around it.
 *
 * Speed changes use the element's own time stretching with `preservesPitch`, which
 * every webview Guitarfish runs in implements (Chromium/WebView2, WebKit, WebKitGTK
 * through GStreamer): no audio is decoded into memory, and the pitch stays the same.
 */

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 1.5;
export const SPEED_STEP = 0.05;
export const LOCAL_SPEED_PRESETS = [0.5, 0.75, 1, 1.25] as const;
/** Speed changes glide over this long instead of jumping. */
export const SPEED_RAMP_MS = 300;
const RAMP_STEP_MS = 30;
/** "Previous" restarts the track when it has played longer than this. */
export const RESTART_MS = 3000;
/** The shortest A/B loop. */
export const MIN_LOOP_MS = 250;
/** How often the A/B loop end is checked while playing (timeupdate alone is ~4 Hz). */
const LOOP_CHECK_MS = 25;
const SAVE_POSITION_MS = 5000;
export const PLAYER_KEY = "tabsync.player";
export const LOCAL_PLAYER_NAME = "Local files";

export function clampSpeed(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, n)) * 100) / 100;
}

/** What the player needs of an HTMLAudioElement (a fake one in the tests). */
export interface MediaLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly error: { code: number } | null;
  volume: number;
  muted: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  preservesPitch: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: () => void): void;
}

/** The playable URL of a track, and how to let go of it when another track loads. */
export interface Resolved {
  url: string;
  release(): void;
}

/** Where the queue came from: the whole library or one playlist. */
export type QueueContext = { kind: "library" } | { kind: "playlist"; id: number };

export interface PlayerDeps {
  media: MediaLike;
  /** A track of the library (null if it was removed). */
  getTrack(id: number): LocalTrack | null;
  resolve(track: LocalTrack): Promise<Resolved>;
  /** The track's cover as a URL, if loaded. */
  artUrl?(track: LocalTrack): string | null;
  storage?: Pick<Storage, "getItem" | "setItem">;
  rng?: Rng;
  /** Anything shown changed: track, play state, position jump, speed, loop… */
  onChange?(): void;
  onError?(track: LocalTrack | null, message: string): void;
  /** The real duration, once the file is open (tags can be missing or wrong). */
  onDuration?(track: LocalTrack, ms: number): void;
}

export interface Loop {
  a: number | null;
  b: number | null;
}

interface Saved {
  queue: Queue | null;
  context: QueueContext | null;
  trackId: number | null;
  positionMs: number;
  volume: number;
  muted: boolean;
  speed: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

const MEDIA_ERRORS: Record<number, string> = {
  1: "Playback was interrupted",
  2: "The file couldn't be read. Was it moved, deleted, or is its drive disconnected?",
  3: "The file is damaged and couldn't be decoded",
  4: "The file is missing or isn't playable MP3 audio",
};

export function mediaErrorMessage(code: number | undefined): string {
  return MEDIA_ERRORS[code ?? 0] ?? "The file couldn't be played";
}

function parseContext(v: unknown): QueueContext | null {
  const c = v as QueueContext | null;
  if (c?.kind === "library") return { kind: "library" };
  if (c?.kind === "playlist" && Number.isInteger(c.id)) return { kind: "playlist", id: c.id };
  return null;
}

export class LocalPlayer {
  private queue: Queue | null = null;
  private _context: QueueContext | null = null;
  private trackId: number | null = null;
  /** The track whose file is in the media element. */
  private loadedId: number | null = null;
  private resolved: Resolved | null = null;
  private loadSeq = 0;
  /** Where to start once the file is open (a restored position, or a seek before loading). */
  private pendingSeekMs: number | null = null;
  private _loading = false;
  private _error: string | null = null;
  private wantPlay = false;
  private errorsInARow = 0;
  private _speed = 1;
  private _volume = 80;
  private _muted = false;
  private _shuffle = false;
  private _repeat: RepeatMode = "off";
  private _loop: Loop = { a: null, b: null };
  private rampTimer: ReturnType<typeof setTimeout> | null = null;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private lastSave = 0;
  private storage: Pick<Storage, "getItem" | "setItem"> | null;

  constructor(private deps: PlayerDeps) {
    this.storage = deps.storage ?? null;
    const m = deps.media;
    m.preservesPitch = true;
    m.addEventListener("loadedmetadata", () => this.onMetadata());
    m.addEventListener("playing", () => {
      this.errorsInARow = 0;
      this._loading = false;
      this.syncLoopTimer();
      this.changed();
    });
    m.addEventListener("play", () => this.changed());
    m.addEventListener("pause", () => {
      this.syncLoopTimer();
      this.save();
      this.changed();
    });
    m.addEventListener("waiting", () => {
      this._loading = true;
      this.changed();
    });
    m.addEventListener("seeked", () => this.changed());
    m.addEventListener("timeupdate", () => this.onTimeUpdate());
    m.addEventListener("ended", () => void this.onEnded());
    m.addEventListener("error", () => this.onMediaError());
    this.applyVolume();
  }

  // ---- State ----------------------------------------------------------------------
  get track(): LocalTrack | null {
    return this.trackId == null ? null : this.deps.getTrack(this.trackId);
  }

  get context(): QueueContext | null {
    return this._context;
  }

  get playing(): boolean {
    return this.loadedId !== null && this.loadedId === this.trackId && !this.deps.media.paused;
  }

  get loading(): boolean {
    return this._loading;
  }

  get error(): string | null {
    return this._error;
  }

  get speed(): number {
    return this._speed;
  }

  get volume(): number {
    return this._volume;
  }

  get muted(): boolean {
    return this._muted;
  }

  get shuffle(): boolean {
    return this._shuffle;
  }

  get repeat(): RepeatMode {
    return this._repeat;
  }

  get loop(): Readonly<Loop> {
    return this._loop;
  }

  /** The ids of the queue in play order, and the current position in it. */
  get upNext(): { order: readonly number[]; pos: number } {
    return { order: this.queue?.order ?? [], pos: this.queue?.pos ?? -1 };
  }

  get positionMs(): number {
    if (this.loadedId === null || this.loadedId !== this.trackId || this.pendingSeekMs !== null) return this.pendingSeekMs ?? 0;
    return this.deps.media.currentTime * 1000;
  }

  get durationMs(): number | null {
    const d = this.deps.media.duration;
    if (this.loadedId !== null && this.loadedId === this.trackId && Number.isFinite(d) && d > 0) return d * 1000;
    return this.track?.durationMs ?? null;
  }

  /** The current track as the sync loop sees a player (see Detector). */
  nowPlaying(): Track | null {
    const t = this.track;
    if (!t) return null;
    return {
      title: t.title,
      artist: t.artist,
      album: t.album || null,
      durationMs: this.durationMs,
      positionMs: this.positionMs,
      isPlaying: this.playing,
      spotifyId: null,
      volume: this._muted ? 0 : this._volume,
      artworkUrl: this.deps.artUrl?.(t) ?? null,
      source: "local",
      player: LOCAL_PLAYER_NAME,
    };
  }

  private changed(): void {
    this.deps.onChange?.();
  }

  // ---- Queue ----------------------------------------------------------------------
  /** Plays `items` (a list's track ids, in order) from `start`. */
  async playList(items: number[], start: number, context: QueueContext): Promise<void> {
    this.queue = newQueue(items, start, { shuffle: this._shuffle, repeat: this._repeat }, this.deps.rng);
    this._context = context;
    const id = current(this.queue);
    if (id == null) return;
    await this.load(id, { autoplay: true });
  }

  /** Plays `id`, which is in the queue already (e.g. clicked in the queue's own list). */
  async playInQueue(id: number): Promise<void> {
    if (!this.queue) return;
    this.queue = jumpTo(this.queue, id);
    await this.load(id, { autoplay: true });
  }

  async next(): Promise<void> {
    if (!this.queue) return;
    const q = next(this.queue);
    if (!q) return this.stopAtEnd();
    this.queue = q;
    await this.load(current(q)!, { autoplay: true });
  }

  /** Back to the start of the track, or (near its start) to the previous track. */
  async previous(): Promise<void> {
    if (!this.queue || (this.trackId !== null && this.positionMs > RESTART_MS)) {
      this.seek(0);
      return;
    }
    // The playing track left the list: the queue already points at the one before it.
    const before = current(this.queue);
    if (before === null || before === this.trackId) this.queue = previous(this.queue);
    const id = current(this.queue);
    if (id !== null) await this.load(id, { autoplay: true });
  }

  setShuffle(on: boolean): void {
    this._shuffle = on;
    if (this.queue) this.queue = setShuffle(this.queue, on, this.deps.rng);
    this.save();
    this.changed();
  }

  setRepeat(r: RepeatMode): void {
    this._repeat = r;
    if (this.queue) this.queue = setRepeat(this.queue, r);
    this.save();
    this.changed();
  }

  /** The list behind the queue changed (playlist edited, songs added or removed). */
  listChanged(context: QueueContext, items: number[]): void {
    if (!this.queue || !sameContext(context, this._context)) return;
    this.queue = withItems(this.queue, items, this.deps.rng);
    this.save();
    this.changed();
  }

  /**
   * A track left the library: it leaves the queue. If it was the current track, the
   * one that took its place becomes current (and plays on if the removed one was
   * playing); a load of the removed track still under way is dropped.
   */
  trackRemoved(id: number): void {
    if (this.queue) this.queue = withItems(this.queue, this.queue.items.filter((x) => x !== id), this.deps.rng);
    if (this.trackId === id) {
      const wasPlaying = this.playing || this.wantPlay;
      this.loadSeq++;
      this.unload();
      this.trackId = null;
      this.pendingSeekMs = null;
      this._error = null;
      this._loading = false;
      this.wantPlay = false;
      this._loop = { a: null, b: null };
      this.syncLoopTimer();
      const q = this.queue ? next(this.queue) : null;
      const replacement = q ? current(q) : null;
      if (q && replacement !== null && replacement !== id) {
        this.queue = q;
        if (wasPlaying) {
          void this.load(replacement, { autoplay: true });
          return;
        }
        this.trackId = replacement;
      } else if (this.queue) {
        // It was the last track: nothing is current, and Play starts the queue over.
        this.queue = { ...this.queue, pos: -1 };
      }
    }
    this.save();
    this.changed();
  }

  /** Forget the queue's playlist (deleted): the queue plays on as it is. */
  contextDeleted(context: QueueContext): void {
    if (sameContext(context, this._context)) {
      this._context = null;
      this.save();
    }
  }

  private async stopAtEnd(): Promise<void> {
    this.wantPlay = false;
    this.deps.media.pause();
    this.seek(0);
    this.changed();
  }

  // ---- Transport --------------------------------------------------------------------
  async play(): Promise<void> {
    // Nothing current but a queue (its last song was removed): start it over.
    if (this.trackId === null && current(this.queue) === null && this.queue?.order.length) this.queue = { ...this.queue, pos: 0 };
    const id = this.trackId ?? current(this.queue);
    if (id == null) return;
    if (this.loadedId !== id) {
      await this.load(id, { autoplay: true, positionMs: this.pendingSeekMs ?? 0 });
      return;
    }
    this.wantPlay = true;
    this._error = null;
    try {
      await this.deps.media.play();
    } catch (e) {
      // AbortError: a newer load or pause interrupted this play(); nothing to report.
      if ((e as DOMException)?.name !== "AbortError") this.fail(this.track, `Couldn't start playback: ${String(e)}`);
    }
    this.changed();
  }

  pause(): void {
    this.wantPlay = false;
    this.deps.media.pause();
    this.save();
    this.changed();
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  /** Jumps to `ms`. `persist: false` skips saving the session (scrubbing: saved once at the end). */
  seek(ms: number, persist = true): void {
    const dur = this.durationMs;
    const target = Math.max(0, dur ? Math.min(ms, dur) : ms);
    if (this.loadedId !== null && this.loadedId === this.trackId && this.pendingSeekMs === null) this.deps.media.currentTime = target / 1000;
    else this.pendingSeekMs = target;
    if (persist) this.save();
    this.changed();
  }

  /** Volume 0–100; raising it unmutes. */
  setVolume(v: number): void {
    this._volume = Math.round(Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0)));
    if (this._volume > 0) this._muted = false;
    this.applyVolume();
    this.save();
    this.changed();
  }

  toggleMute(): void {
    this._muted = !this._muted;
    if (!this._muted && this._volume === 0) this._volume = 50;
    this.applyVolume();
    this.save();
    this.changed();
  }

  private applyVolume(): void {
    this.deps.media.volume = this._volume / 100;
    this.deps.media.muted = this._muted;
  }

  /**
   * Playback speed, 0.25–1.5, pitch kept. While playing it glides to the new speed
   * over SPEED_RAMP_MS so the change doesn't jolt; `smooth: false` jumps.
   */
  setSpeed(v: number, smooth = true): void {
    const to = clampSpeed(v);
    this._speed = to;
    const m = this.deps.media;
    m.defaultPlaybackRate = to;
    m.preservesPitch = true;
    if (this.rampTimer !== null) clearTimeout(this.rampTimer);
    this.rampTimer = null;
    const from = m.playbackRate;
    if (!smooth || m.paused || Math.abs(to - from) < 0.001) m.playbackRate = to;
    else {
      const steps = Math.max(1, Math.round(SPEED_RAMP_MS / RAMP_STEP_MS));
      let i = 0;
      const step = () => {
        i++;
        const k = i / steps;
        const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        m.playbackRate = i >= steps ? to : Math.round((from + (to - from) * eased) * 1000) / 1000;
        this.rampTimer = i >= steps ? null : setTimeout(step, RAMP_STEP_MS);
      };
      this.rampTimer = setTimeout(step, RAMP_STEP_MS);
    }
    this.save();
    this.changed();
  }

  // ---- A/B loop -----------------------------------------------------------------------
  /** Sets the loop to [a, b] ms (either end null: not set). An end before the start is ignored. */
  setLoop(a: number | null, b: number | null): void {
    const dur = this.durationMs ?? Infinity;
    const A = a == null ? null : Math.max(0, Math.min(a, dur));
    let B = b == null ? null : Math.max(0, Math.min(b, dur));
    if (A != null && B != null && B - A < MIN_LOOP_MS) B = null;
    this._loop = { a: A, b: B };
    this.syncLoopTimer();
    this.changed();
  }

  clearLoop(): void {
    this.setLoop(null, null);
  }

  /** One button for the loop: set A here, then B here, then clear. Jumps to A when the loop closes. */
  cycleLoop(): void {
    const pos = this.positionMs;
    const { a, b } = this._loop;
    if (a == null) this.setLoop(pos, null);
    else if (b == null) {
      if (pos - a < MIN_LOOP_MS) return; // too short: keep waiting for B
      this.setLoop(a, pos);
      this.seek(a);
    } else this.clearLoop();
  }

  get loopActive(): boolean {
    return this._loop.a != null && this._loop.b != null;
  }

  /** Back to A once B is reached. */
  private checkLoop(): void {
    const { a, b } = this._loop;
    if (a == null || b == null || this.loadedId !== this.trackId) return;
    if (this.deps.media.currentTime * 1000 >= b) this.deps.media.currentTime = a / 1000;
  }

  private syncLoopTimer(): void {
    const run = this.loopActive && !this.deps.media.paused;
    if (run && this.loopTimer === null) this.loopTimer = setInterval(() => this.checkLoop(), LOOP_CHECK_MS);
    else if (!run && this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
  }

  // ---- Loading ------------------------------------------------------------------------
  /** Lets go of the current file: stops the element and releases its URL. */
  private unload(): void {
    const m = this.deps.media;
    m.pause();
    m.removeAttribute("src");
    m.load();
    this.resolved?.release();
    this.resolved = null;
    this.loadedId = null;
  }

  private async load(id: number, opts: { autoplay: boolean; positionMs?: number }): Promise<void> {
    const seq = ++this.loadSeq;
    if (this.loadedId !== null) this.unload();
    // A loop belongs to its track: it survives opening the same track (a restored one), not another.
    if (id !== this.trackId) {
      this._loop = { a: null, b: null };
      this.syncLoopTimer();
    }
    this.trackId = id;
    this._error = null;
    this._loading = true;
    this.wantPlay = opts.autoplay;
    this.pendingSeekMs = opts.positionMs ? opts.positionMs : null;
    this.save();
    this.changed();
    const track = this.deps.getTrack(id);
    if (!track) return this.fail(null, "This song is no longer in the library");
    let r: Resolved;
    try {
      r = await this.deps.resolve(track);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      return this.fail(track, e instanceof Error ? e.message : String(e));
    }
    if (seq !== this.loadSeq) {
      r.release();
      return;
    }
    const m = this.deps.media;
    this.resolved = r;
    this.loadedId = id;
    m.defaultPlaybackRate = this._speed;
    m.playbackRate = this._speed;
    m.preservesPitch = true;
    m.src = r.url;
    if (opts.autoplay) await this.play();
    else this.changed();
  }

  private onMetadata(): void {
    const m = this.deps.media;
    // A new source resets the rate to defaultPlaybackRate; make sure it's ours.
    m.playbackRate = this._speed;
    if (this.pendingSeekMs !== null) {
      const dur = Number.isFinite(m.duration) ? m.duration * 1000 : Infinity;
      m.currentTime = Math.min(this.pendingSeekMs, dur) / 1000;
      this.pendingSeekMs = null;
    }
    this._loading = false;
    const t = this.track;
    if (t && Number.isFinite(m.duration) && m.duration > 0) {
      const ms = Math.round(m.duration * 1000);
      if (t.durationMs == null || Math.abs(t.durationMs - ms) > 1000) this.deps.onDuration?.(t, ms);
    }
    this.changed();
  }

  private onTimeUpdate(): void {
    this.checkLoop();
    const now = Date.now();
    if (now - this.lastSave >= SAVE_POSITION_MS) this.save();
  }

  private async onEnded(): Promise<void> {
    // A loop ending at the track's end: the element stops before checkLoop sees B.
    if (this.loopActive) {
      this.deps.media.currentTime = this._loop.a! / 1000;
      await this.play();
      return;
    }
    // Repeat one: start over without reopening the file (even if it left the list).
    if (this._repeat === "one" && this.loadedId !== null && this.loadedId === this.trackId) {
      this.deps.media.currentTime = 0;
      await this.play();
      return;
    }
    if (!this.queue) return this.stopAtEnd();
    const q = next(this.queue, true);
    if (!q) return this.stopAtEnd();
    this.queue = q;
    await this.load(current(q)!, { autoplay: true });
  }

  private onMediaError(): void {
    if (this.loadedId === null) return; // the src was removed on purpose
    this.fail(this.track, mediaErrorMessage(this.deps.media.error?.code));
  }

  /**
   * The current track can't play. When it was meant to play, the queue moves on to
   * the next track, unless every track of the queue failed in a row.
   */
  private fail(track: LocalTrack | null, message: string): void {
    this._error = message;
    this._loading = false;
    const wanted = this.wantPlay;
    this.wantPlay = false;
    this.deps.onError?.(track, message);
    this.changed();
    this.errorsInARow++;
    if (!wanted || !this.queue) return;
    const q = next(this.queue);
    if (q && this.errorsInARow < this.queue.order.length && current(q) !== this.trackId) {
      this.queue = q;
      void this.load(current(q)!, { autoplay: true });
    }
  }

  // ---- Persistence --------------------------------------------------------------------
  /** Writes the queue, track, position, volume and speed, so the next start picks up here. */
  save(): void {
    this.lastSave = Date.now();
    if (!this.storage) return;
    const s: Saved = {
      queue: this.queue,
      context: this._context,
      trackId: this.trackId,
      positionMs: Math.round(this.positionMs),
      volume: this._volume,
      muted: this._muted,
      speed: this._speed,
      shuffle: this._shuffle,
      repeat: this._repeat,
    };
    try {
      this.storage.setItem(PLAYER_KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable: the queue lasts for this session only */
    }
  }

  /**
   * Picks up where the last session stopped: queue, track and position (paused; the
   * file opens on play), volume, speed, shuffle and repeat. Tracks no longer in the
   * library are dropped.
   */
  restore(): void {
    let raw: Partial<Saved> | null = null;
    try {
      raw = JSON.parse(this.storage?.getItem(PLAYER_KEY) ?? "null");
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== "object") return;
    this._volume = Number.isFinite(raw.volume) ? Math.max(0, Math.min(100, Math.round(raw.volume!))) : this._volume;
    this._muted = raw.muted === true;
    this._speed = clampSpeed(raw.speed ?? 1);
    this._shuffle = raw.shuffle === true;
    this._repeat = raw.repeat === "all" || raw.repeat === "one" ? raw.repeat : "off";
    this.applyVolume();
    this.deps.media.defaultPlaybackRate = this._speed;
    this.deps.media.playbackRate = this._speed;
    const q = parseQueue(raw.queue);
    this.queue = q ? withItems(q, q.items.filter((id) => this.deps.getTrack(id) !== null), this.deps.rng) : null;
    this._context = parseContext(raw.context);
    const id = Number.isInteger(raw.trackId) && this.deps.getTrack(raw.trackId!) ? raw.trackId! : null;
    this.trackId = id;
    this.pendingSeekMs = id != null && Number.isFinite(raw.positionMs) && raw.positionMs! > 0 ? raw.positionMs! : null;
    this.changed();
  }
}

function sameContext(a: QueueContext | null, b: QueueContext | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "library" || (b.kind === "playlist" && a.id === b.id);
}
