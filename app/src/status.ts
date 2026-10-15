/** Where the Spotify → Songsterr pipeline stands for the current track. */
export type SearchPhase =
  | "idle" // nothing searched yet for this track
  | "paused" // automatic search is off
  | "searching"
  | "found" // Songsterr result that matches title and artist
  | "picked" // the user chose this tab for the track earlier
  | "uncertain" // results, but none clearly the same song
  | "none" // Songsterr returned nothing
  | "server-error"; // the Guitarfish server (which proxies the search) is unreachable

export type Tone = "ok" | "busy" | "idle" | "warn" | "error";

export interface SyncStatus {
  tone: Tone;
  label: string;
  detail?: string;
}

export interface StatusInput {
  detectorError: string | null;
  hasTrack: boolean;
  isPlaying: boolean;
  phase: SearchPhase;
}

/** One status for the whole pipeline, most important problem first. */
export function syncStatus({ detectorError, hasTrack, isPlaying, phase }: StatusInput): SyncStatus {
  if (detectorError) return { tone: "error", label: "Spotify connection error", detail: detectorError };
  if (!hasTrack) return { tone: "idle", label: "Waiting for playback", detail: "Play a song in Spotify" };
  switch (phase) {
    case "searching":
      return { tone: "busy", label: "Searching Songsterr…" };
    case "found":
      return { tone: "ok", label: "Tablature found" };
    case "picked":
      return { tone: "ok", label: "Tablature found", detail: "Your pick for this song" };
    case "uncertain":
      return { tone: "warn", label: "No confident match", detail: "Showing the closest result. Pick another if it's wrong." };
    case "none":
      return { tone: "warn", label: "No confident match", detail: "Songsterr has no result for this song" };
    case "server-error":
      return { tone: "error", label: "Tab server unreachable", detail: "Songsterr search goes through the Guitarfish server" };
    case "paused":
      return { tone: "idle", label: "Connected to Spotify", detail: "Automatic tab search is off" };
    case "idle":
      return { tone: "ok", label: "Connected to Spotify", detail: isPlaying ? undefined : "Paused" };
  }
}
