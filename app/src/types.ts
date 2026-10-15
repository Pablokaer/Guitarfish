/** What the detectors report. Same shape for the OS plugin and the Spotify fallback. */
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
  source: "os" | "spotify-api";
  player: string;
}

export interface TabInfo {
  id: number;
  instrument: string;
  tuning: string | null;
  format: "alphatex" | "gp" | "musicxml";
  version: number;
  rating: number | null;
  isPlaceholder: boolean;
}

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
   * app can poll less often. Missing on older plugins: treat as false.
   */
  events?: boolean;
}
