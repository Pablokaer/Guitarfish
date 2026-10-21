/** Where the player → Songsterr pipeline stands for the current track. */
export type SearchPhase =
  | "idle" // nothing searched yet for this track
  | "paused" // automatic search is off
  | "searching"
  | "found" // Songsterr result that matches title and artist
  | "picked" // the user chose this tab for the track earlier
  | "uncertain" // results, but none clearly the same song
  | "none" // Songsterr returned nothing
  | "offline"; // the Songsterr search failed (no connection, or Songsterr isn't answering); retried

export type Tone = "ok" | "busy" | "idle" | "warn" | "error";

export interface SyncStatus {
  tone: Tone;
  label: string;
  detail?: string;
}

export interface StatusInput {
  /** Which player is followed: this device's (YouTube, Spotify) when not given, or the local one. */
  mode?: "spotify" | "local";
  /** The service of the current track, e.g. "YouTube". */
  playerName?: string | null;
  detectorError: string | null;
  hasTrack: boolean;
  isPlaying: boolean;
  phase: SearchPhase;
}

/**
 * One status for the whole pipeline, most important problem first. In local mode
 * Spotify isn't read, so its errors don't count.
 */
export function syncStatus({ mode = "spotify", playerName, detectorError, hasTrack, isPlaying, phase }: StatusInput): SyncStatus {
  const local = mode === "local";
  if (detectorError && !local) return { tone: "error", label: "Player connection error", detail: detectorError };
  if (!hasTrack) return local ? { tone: "idle", label: "Nothing playing", detail: "Play a song from Music" } : { tone: "idle", label: "Waiting for playback", detail: "Play a song on YouTube or Spotify" };
  const connected = local ? "Local player" : `Connected to ${playerName || "the player"}`;
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
    case "offline":
      return { tone: "error", label: "Songsterr unreachable", detail: "You may be offline, or Songsterr isn't answering. Retrying…" };
    case "paused":
      return { tone: "idle", label: connected, detail: "Automatic tab search is off" };
    case "idle":
      return { tone: "ok", label: connected, detail: isPlaying ? undefined : "Paused" };
  }
}
