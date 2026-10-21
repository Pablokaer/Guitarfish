import { describe, expect, it, vi } from "vitest";
import { Playback, type PlaybackDeps } from "../src/playback";
import type { Track } from "../src/types";

const spotifyTrack = (isPlaying: boolean): Track => ({ title: "Uprising", artist: "Muse", isPlaying, source: "os", player: "Spotify" });
const localTrack: Track = { title: "Demo", artist: "Me", isPlaying: true, source: "local", player: "Local files" };

function setup(over: Partial<PlaybackDeps> = {}, spotifyPlaying = true) {
  const deps = {
    detector: { read: vi.fn(async () => spotifyTrack(spotifyPlaying)) },
    local: { nowPlaying: vi.fn(() => localTrack), pause: vi.fn() },
    pauseSpotify: vi.fn(async () => {}),
    canControlSpotify: vi.fn(() => true),
    mode: "spotify" as const,
    onMode: vi.fn(),
    ...over,
  } satisfies PlaybackDeps;
  return { playback: new Playback(deps), deps };
}

describe("Playback", () => {
  it("reads Spotify in Spotify mode and the local player in local mode", async () => {
    const { playback, deps } = setup();
    expect(await playback.read()).toMatchObject({ source: "os" });
    await playback.setMode("local");
    deps.detector.read.mockClear();
    expect(await playback.read()).toBe(localTrack);
    expect(deps.detector.read).not.toHaveBeenCalled();
  });

  it("switching to local pauses Spotify when it plays", async () => {
    const { playback, deps } = setup();
    await playback.setMode("local");
    expect(deps.pauseSpotify).toHaveBeenCalledTimes(1);
    expect(deps.onMode).toHaveBeenCalledWith("local");
    expect(playback.mode).toBe("local");
  });

  it("leaves a paused Spotify alone", async () => {
    const { playback, deps } = setup({}, false);
    await playback.setMode("local");
    expect(deps.pauseSpotify).not.toHaveBeenCalled();
  });

  it("can't pause Spotify without its controls (and doesn't try to read it)", async () => {
    const { playback, deps } = setup({ canControlSpotify: () => false });
    expect(await playback.silenceSpotify()).toBe(false);
    expect(deps.detector.read).not.toHaveBeenCalled();
  });

  it("switching to Spotify pauses the local player", async () => {
    const { playback, deps } = setup({ mode: "local" });
    await playback.setMode("spotify");
    expect(deps.local.pause).toHaveBeenCalled();
    expect(deps.pauseSpotify).not.toHaveBeenCalled();
  });

  it("does nothing when the mode doesn't change", async () => {
    const { playback, deps } = setup();
    await playback.setMode("spotify");
    expect(deps.onMode).not.toHaveBeenCalled();
    expect(deps.local.pause).not.toHaveBeenCalled();
  });

  it("playing a local song switches to local mode, or silences Spotify again", async () => {
    const { playback, deps } = setup();
    await playback.beforeLocalPlay();
    expect(playback.mode).toBe("local");
    expect(deps.pauseSpotify).toHaveBeenCalledTimes(1);
    // Spotify was started again by hand meanwhile.
    await playback.beforeLocalPlay();
    expect(deps.pauseSpotify).toHaveBeenCalledTimes(2);
  });

  it("quick local actions toggle Spotify only once (it would otherwise resume)", async () => {
    let release!: () => void;
    const pauseSpotify = vi.fn(() => new Promise<void>((r) => (release = r)));
    const { playback } = setup({ mode: "local", pauseSpotify });
    const a = playback.beforeLocalPlay();
    const b = playback.beforeLocalPlay();
    await vi.waitFor(() => expect(pauseSpotify).toHaveBeenCalled());
    release();
    await Promise.all([a, b]);
    expect(pauseSpotify).toHaveBeenCalledTimes(1);
    // Later, a new local play checks again.
    const c = playback.beforeLocalPlay();
    await vi.waitFor(() => expect(pauseSpotify).toHaveBeenCalledTimes(2));
    release();
    await c;
  });

  it("survives a failing Spotify read or command", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { playback } = setup({ pauseSpotify: async () => Promise.reject(new Error("no Spotify")) });
    expect(await playback.silenceSpotify()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
