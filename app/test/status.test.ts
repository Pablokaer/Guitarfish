import { describe, expect, it } from "vitest";
import { syncStatus, type SearchPhase } from "../src/status";

const base = { detectorError: null, hasTrack: true, isPlaying: true, phase: "idle" as SearchPhase };

describe("syncStatus", () => {
  it("reports Spotify errors first", () => {
    expect(syncStatus({ ...base, detectorError: "denied", phase: "found" })).toMatchObject({ tone: "error", label: "Spotify connection error", detail: "denied" });
  });

  it("waits for playback without a track", () => {
    expect(syncStatus({ ...base, hasTrack: false, phase: "found" }).label).toBe("Waiting for playback");
  });

  it("maps each search phase", () => {
    const label = (phase: SearchPhase) => syncStatus({ ...base, phase }).label;
    expect(label("idle")).toBe("Connected to Spotify");
    expect(label("searching")).toBe("Searching Songsterr…");
    expect(label("found")).toBe("Tablature found");
    expect(label("picked")).toBe("Tablature found");
    expect(label("uncertain")).toBe("No confident match");
    expect(label("none")).toBe("No confident match");
    expect(label("offline")).toBe("Songsterr unreachable");
  });

  it("explains a failed Songsterr search and that it is retried", () => {
    expect(syncStatus({ ...base, phase: "offline" })).toEqual({
      tone: "error",
      label: "Songsterr unreachable",
      detail: "You may be offline, or Songsterr isn't answering. Retrying…",
    });
  });

  it("only claims a match for confident or user-picked results", () => {
    for (const phase of ["idle", "paused", "searching", "uncertain", "none", "offline"] as SearchPhase[]) {
      expect(syncStatus({ ...base, phase }).label).not.toBe("Tablature found");
    }
  });
});
