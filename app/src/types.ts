/**
 * What is playing: the Spotify app on this device, as the now-playing plugin reports
 * it (`source: "os"`), or Guitarfish's own local MP3 player (`source: "local"`).
 */
export interface Track {
  title: string;
  artist: string;
  album?: string | null;
  durationMs?: number | null;
  positionMs?: number | null;
  isPlaying: boolean;
  spotifyId?: string | null;
  /** Spotify volume 0–100 (macOS only). */
  volume?: number | null;
  artworkUrl?: string | null;
  source: "os" | "local";
  player: string;
}

/** How a tab file is stored: alphaTab reads alphaTex as text, the others as bytes. */
export type TabFormat = "alphatex" | "gp" | "musicxml";

/** A tab file imported into the local catalogue (without its content). */
export interface TabInfo {
  id: number;
  format: TabFormat;
  /** The imported file's name, which tells several tabs of a song apart. */
  name: string;
}

/** A song in the local catalogue, with its tabs. */
export interface Song {
  id: number;
  title: string;
  artist: string;
  durationMs: number | null;
  tabs: TabInfo[];
  score?: number;
}

/** A song in Songsterr's catalogue. Only a link: the tab itself stays on Songsterr. */
export interface SongsterrResult {
  songId: number;
  title: string;
  artist: string;
  instruments: string[];
  url: string;
}

export interface LookupResponse {
  match: Song | null;
  confidence: number;
  method: "external-id" | "exact" | "fuzzy" | "none";
  candidates: Song[];
}

/** Which playback controls the device detector can drive (see the nowplaying plugin). */
export interface PlaybackCapabilities {
  transport: boolean;
  seek: boolean;
  volume: boolean;
  /**
   * The plugin emits `nowplaying://changed` when the player reports a change, so the
   * app can poll less often. Older plugins don't send it: Detector.capabilities()
   * reads it as false.
   */
  events: boolean;
}
