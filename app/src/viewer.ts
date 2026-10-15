import * as alphaTab from "@coderline/alphatab";
import { describeTuning, type PlayerState, type TuningInfo } from "./practice";
import { scoreTimeline, staffTuning } from "./score";
import { barAt, type TimedBar } from "./timeline";
import type { TabInfo } from "./types";

/** Built-in player status, for the practice controls. `loading`: waiting for the sounds. */
export interface PlayerStatus {
  state: PlayerState;
  loading: boolean;
}

/**
 * Wraps alphaTab: renders a tab, follows a playback position, and runs alphaTab's
 * built-in player for practice (speed, transpose, loop).
 *
 * Following works by converting the song position (ms) into a master bar index using
 * the score's play order and tempo map (see score.ts and timeline.ts), then scrolling
 * that bar into view and highlighting it. While the built-in player plays, alphaTab's
 * own cursor moves instead (main.ts decides, see practice.ts `cursorSource`).
 */
export class TabViewer {
  private api: alphaTab.AlphaTabApi;
  private timeline: TimedBar[] = [];
  private currentBar = -1;
  private highlight: HTMLDivElement;
  private ready = false;
  private playerOn = false;
  private playWhenReady = false;
  private status: PlayerStatus = { state: "stopped", loading: false };
  /** A score was loaded but not drawn yet (alphaTab skips drawing while the view is hidden). */
  private undrawn = false;

  /** Called when the built-in player starts, pauses, stops or finishes loading. */
  onPlayer: (status: PlayerStatus) => void = () => {};
  /** Called after a score is loaded (tuning and timeline are ready). */
  onScore: () => void = () => {};

  constructor(
    private host: HTMLElement,
    private scroller: HTMLElement,
    zoom = 1,
  ) {
    this.api = new alphaTab.AlphaTabApi(host, {
      core: {
        logLevel: alphaTab.LogLevel.Warning,
        // The Vite plugin copies the music font to /font/ and the sounds to
        // /soundfont/; point alphaTab at them explicitly (its auto-detection
        // looks next to the bundled script).
        fontDirectory: new URL("font/", document.baseURI).href,
      },
      display: { layoutMode: alphaTab.LayoutMode.Page, scale: zoom },
      player: {
        // Off until the first Play: the sound font is ~1 MB and needs an audio context.
        playerMode: alphaTab.PlayerMode.Disabled,
        soundFont: new URL("soundfont/sonivox.sf3", document.baseURI).href,
        scrollElement: scroller,
        enableCursor: true,
        enableUserInteraction: true,
      },
    });

    this.highlight = document.createElement("div");
    this.highlight.className = "bar-highlight";
    this.highlight.hidden = true;
    host.style.position = "relative";
    host.dataset.player = "stopped";

    this.api.scoreLoaded.on((score) => {
      this.computeTimeline(score);
      this.onScore();
    });
    this.api.renderStarted.on(() => {
      this.ready = false;
      this.highlight.hidden = true;
    });
    this.api.postRenderFinished.on(() => {
      this.ready = true;
      this.undrawn = false;
      // alphaTab rebuilds its DOM on render; re-attach our overlay.
      if (!this.highlight.isConnected) this.host.appendChild(this.highlight);
      this.currentBar = -1;
    });
    this.api.playerReady.on(() => {
      this.setStatus({ loading: false });
      if (this.playWhenReady) {
        this.playWhenReady = false;
        this.api.play();
      }
    });
    this.api.playerStateChanged.on((e) => {
      const state: PlayerState = e.state === alphaTab.synth.PlayerState.Playing ? "playing" : e.stopped ? "stopped" : "paused";
      this.setStatus({ state });
    });
    this.api.error.on(() => {
      // e.g. the sound font failed to load: don't leave Play waiting forever.
      if (this.status.loading) {
        this.playWhenReady = false;
        this.setStatus({ loading: false });
      }
    });
  }

  load(format: TabInfo["format"], data: ArrayBuffer): void {
    this.stop();
    this.scroller.scrollTop = 0;
    this.undrawn = true;
    if (format === "alphatex") {
      this.api.tex(new TextDecoder().decode(data));
    } else {
      // Guitar Pro (3-7) and MusicXML are detected from the bytes.
      this.api.load(new Uint8Array(data));
    }
  }

  setZoom(scale: number): void {
    this.api.settings.display.scale = scale;
    this.api.updateSettings();
    this.api.render();
  }

  /**
   * The viewer became visible. alphaTab skips rendering into a hidden (zero-width)
   * container and only waits for its very first appearance, so a score loaded
   * behind the Songsterr view is drawn here.
   */
  whenShown(): void {
    if (this.undrawn && this.api.score) this.api.render();
  }

  clear(): void {
    this.undrawn = false;
    this.stop();
    this.timeline = [];
    this.host.querySelectorAll(".at-surface").forEach((el) => ((el as HTMLElement).innerHTML = ""));
    this.highlight.hidden = true;
  }

  /** Bar times in play order (repeats, endings and jumps expanded), with exact tempo changes. */
  private computeTimeline(score: alphaTab.model.Score): void {
    try {
      this.timeline = scoreTimeline(score);
    } catch (e) {
      console.warn("could not build the bar timeline", e);
      this.timeline = [];
    }
    this.currentBar = -1;
  }

  /** Scroll to and highlight the bar playing at `positionMs`. */
  follow(positionMs: number): void {
    if (!this.ready || this.timeline.length === 0) return;
    const bar = barAt(this.timeline, positionMs);
    if (bar === this.currentBar) return;
    this.currentBar = bar;

    const bounds = this.api.renderer.boundsLookup?.findMasterBarByIndex(bar);
    if (!bounds) return;
    const b = bounds.visualBounds; // already in CSS pixels relative to the host
    Object.assign(this.highlight.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
    this.highlight.hidden = false;

    // Keep the current line in the upper third of the viewport.
    const lineTop = bounds.realBounds.y + this.host.offsetTop;
    const target = lineTop - this.scroller.clientHeight / 3;
    if (Math.abs(this.scroller.scrollTop - target) > 40) {
      this.scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }

  hideHighlight(): void {
    this.highlight.hidden = true;
    this.currentBar = -1;
  }

  // ---- Practice ------------------------------------------------------------------

  get player(): PlayerStatus {
    return this.status;
  }

  private setStatus(patch: Partial<PlayerStatus>): void {
    this.status = { ...this.status, ...patch };
    this.host.dataset.player = this.status.state;
    if (this.status.state === "playing") this.hideHighlight();
    this.onPlayer(this.status);
  }

  /** Plays or pauses the built-in player; the first call loads the sounds, then plays. */
  playPause(): void {
    if (!this.api.score) return;
    if (!this.playerOn) {
      this.playerOn = true;
      this.playWhenReady = true;
      this.setStatus({ loading: true });
      this.api.settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
      this.api.updateSettings(); // creates the player; it loads the sound font and the song
      return;
    }
    if (this.status.loading) {
      this.playWhenReady = !this.playWhenReady;
      return;
    }
    this.api.playPause();
  }

  /** Stops the built-in player and rewinds; Spotify follow takes over again. */
  stop(): void {
    this.playWhenReady = false;
    if (this.playerOn && this.status.state !== "stopped") this.api.stop();
    if (this.status.state !== "stopped") this.setStatus({ state: "stopped" });
  }

  setSpeed(speed: number): void {
    this.api.playbackSpeed = speed;
  }

  setLooping(on: boolean): void {
    this.api.isLooping = on;
  }

  /** True when bars are selected (drag over them); a loop then repeats only those. */
  get hasSelection(): boolean {
    return !!this.api.playbackRange;
  }

  clearSelection(): void {
    this.api.playbackRange = null;
  }

  /**
   * Shifts every track by `semitones`, for notation and playback. Tab fret numbers
   * stay as written (like playing with a capo). Applies to the next load as well.
   */
  setTranspose(semitones: number): void {
    // [] keeps each track's own transposition from the file.
    this.api.settings.notation.transpositionPitches = semitones ? new Array(64).fill(semitones) : [];
    if (!this.api.score) return;
    this.api.updateSettings();
    this.api.render();
    if (this.playerOn && !this.status.loading) {
      this.api.loadMidiForScore(); // the synth picks up the new pitches; this stops playback
      this.setStatus({ state: "stopped" });
    }
  }

  /** Tuning and capo of the first shown track, or null when it has no strings. */
  tuning(): TuningInfo | null {
    const score = this.api.score;
    const track = this.api.tracks[0] ?? score?.tracks[0];
    if (!score || !track) return null;
    const t = staffTuning(score, track.index);
    return t ? describeTuning(t.pitches, t.capo) : null;
  }
}
