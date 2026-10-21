import type { Track } from "./types";

/**
 * Which player Guitarfish follows: Spotify on this device (through the now-playing
 * plugin) or its own local MP3 player. Only one makes sound: switching pauses the
 * other, and so does starting a local song while Spotify plays.
 */
export type PlaybackMode = "spotify" | "local";

export interface PlaybackDeps {
  /** The now-playing plugin (Spotify). */
  detector: { read(): Promise<Track | null> };
  local: { nowPlaying(): Track | null; pause(): void };
  /** Pauses Spotify; only called when it is playing and its controls work here. */
  pauseSpotify(): Promise<void>;
  canControlSpotify(): boolean;
  mode: PlaybackMode;
  /** The mode changed (persist it, re-render). */
  onMode?(mode: PlaybackMode): void;
}

export class Playback {
  private _mode: PlaybackMode;
  /** A silenceSpotify() under way: the plugin only toggles, so two at once would pause and resume. */
  private silencing: Promise<boolean> | null = null;

  constructor(private deps: PlaybackDeps) {
    this._mode = deps.mode;
  }

  get mode(): PlaybackMode {
    return this._mode;
  }

  /** What the sync loop sees as playing: the source of the current mode only. */
  async read(): Promise<Track | null> {
    return this._mode === "local" ? this.deps.local.nowPlaying() : this.deps.detector.read();
  }

  async setMode(mode: PlaybackMode): Promise<void> {
    if (mode === this._mode) return;
    this._mode = mode;
    if (mode === "spotify") this.deps.local.pause();
    this.deps.onMode?.(mode);
    if (mode === "local") await this.silenceSpotify();
  }

  /** A local song is about to play: switch to local mode, and make sure Spotify is quiet. */
  async beforeLocalPlay(): Promise<void> {
    if (this._mode !== "local") await this.setMode("local");
    else await this.silenceSpotify();
  }

  /**
   * Pauses Spotify if it plays on this device. Returns whether it did. The plugin's
   * command toggles play/pause, so calls made while one runs share its result
   * instead of toggling again.
   */
  silenceSpotify(): Promise<boolean> {
    if (!this.deps.canControlSpotify()) return Promise.resolve(false);
    this.silencing ??= this.pauseIfPlaying().finally(() => (this.silencing = null));
    return this.silencing;
  }

  private async pauseIfPlaying(): Promise<boolean> {
    try {
      const t = await this.deps.detector.read();
      if (!t?.isPlaying || t.source !== "os") return false;
      await this.deps.pauseSpotify();
      return true;
    } catch (e) {
      console.warn("couldn't pause Spotify", e);
      return false;
    }
  }
}
