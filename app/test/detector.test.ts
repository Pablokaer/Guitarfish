import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabApi } from "../src/api";
import type { Track } from "../src/types";

const core = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => core);

const { Detector } = await import("../src/detector");

const track = (title: string, extra: Partial<Track> = {}): Track => ({ title, artist: "Muse", isPlaying: true, source: "os", player: "Spotify", ...extra });

function setup(opts: { fallback?: boolean; intervalMs?: number } = {}) {
  let fallback = opts.fallback ?? true;
  const api = { spotifyNowPlaying: vi.fn(async (): Promise<Track | null> => null) };
  const detector = new Detector(api as unknown as TabApi, {
    fallbackEnabled: () => fallback,
    ...(opts.intervalMs ? { fallbackIntervalMs: opts.intervalMs } : {}),
  });
  return { detector, api, setFallback: (on: boolean) => (fallback = on) };
}

/** Device reports `t` (null: nothing playing). */
const device = (t: Track | null) => core.invoke.mockResolvedValue({ track: t });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  core.invoke.mockReset();
  core.isTauri.mockReturnValue(true);
});
afterEach(() => vi.useRealTimers());

describe("read", () => {
  it("prefers the device and does not call the fallback", async () => {
    const s = setup();
    const t = track("Uprising");
    device(t);
    expect(await s.detector.read()).toEqual(t);
    expect(core.invoke).toHaveBeenCalledWith("plugin:nowplaying|get_now_playing");
    expect(s.api.spotifyNowPlaying).not.toHaveBeenCalled();
    expect(s.detector.status).toEqual({ kind: "ok" });
  });

  it("uses the Spotify Web API only when the device reports nothing", async () => {
    const s = setup();
    const t = track("Hysteria", { source: "spotify-api" });
    device(null);
    s.api.spotifyNowPlaying.mockResolvedValueOnce(t);
    expect(await s.detector.read()).toEqual(t);
    expect(s.api.spotifyNowPlaying).toHaveBeenCalledTimes(1);
  });

  it("treats a missing track field as nothing playing", async () => {
    const s = setup({ fallback: false });
    core.invoke.mockResolvedValue({});
    expect(await s.detector.read()).toBeNull();
  });

  it("returns null without asking the server when the fallback is off", async () => {
    const s = setup({ fallback: false });
    device(null);
    expect(await s.detector.read()).toBeNull();
    expect(s.api.spotifyNowPlaying).not.toHaveBeenCalled();
  });

  it("outside Tauri, skips the device and uses the fallback", async () => {
    const s = setup();
    core.isTauri.mockReturnValue(false);
    const t = track("Hysteria", { source: "spotify-api" });
    s.api.spotifyNowPlaying.mockResolvedValueOnce(t);
    expect(await s.detector.read()).toEqual(t);
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("reports a device error and falls back", async () => {
    const s = setup();
    core.invoke.mockRejectedValue("no player");
    const t = track("Hysteria", { source: "spotify-api" });
    s.api.spotifyNowPlaying.mockResolvedValueOnce(t);
    expect(await s.detector.read()).toEqual(t);
    expect(s.detector.status).toEqual({ kind: "error", message: "no player" });

    device(track("Uprising"));
    await s.detector.read();
    expect(s.detector.status).toEqual({ kind: "ok" });
  });

  it("treats a failing fallback as nothing playing", async () => {
    const s = setup();
    device(null);
    s.api.spotifyNowPlaying.mockRejectedValueOnce(new Error("offline"));
    expect(await s.detector.read()).toBeNull();
  });
});

describe("fallback interval", () => {
  it("asks the server at most every 3 s by default, extrapolating the position in between", async () => {
    const s = setup();
    device(null);
    s.api.spotifyNowPlaying.mockResolvedValue(track("Hysteria", { source: "spotify-api", positionMs: 10_000 }));
    expect((await s.detector.read())?.positionMs).toBe(10_000);

    vi.advanceTimersByTime(1200);
    expect((await s.detector.read())?.positionMs).toBe(11_200);
    vi.advanceTimersByTime(1799);
    expect((await s.detector.read())?.positionMs).toBe(12_999);
    expect(s.api.spotifyNowPlaying).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect((await s.detector.read())?.positionMs).toBe(10_000); // fresh reading from the server
    expect(s.api.spotifyNowPlaying).toHaveBeenCalledTimes(2);
  });

  it("honours a custom interval", async () => {
    const s = setup({ intervalMs: 500 });
    device(null);
    await s.detector.read();
    vi.advanceTimersByTime(499);
    await s.detector.read();
    expect(s.api.spotifyNowPlaying).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await s.detector.read();
    expect(s.api.spotifyNowPlaying).toHaveBeenCalledTimes(2);
  });

  it("does not advance a paused track or one without a position", async () => {
    const s = setup();
    device(null);
    const paused = track("Hysteria", { source: "spotify-api", positionMs: 10_000, isPlaying: false });
    s.api.spotifyNowPlaying.mockResolvedValueOnce(paused);
    await s.detector.read();
    vi.advanceTimersByTime(1000);
    expect(await s.detector.read()).toEqual(paused);

    vi.advanceTimersByTime(2000);
    const noPos = track("Uprising", { source: "spotify-api", positionMs: null });
    s.api.spotifyNowPlaying.mockResolvedValueOnce(noPos);
    await s.detector.read();
    vi.advanceTimersByTime(1000);
    expect(await s.detector.read()).toEqual(noPos);
  });

  it("keeps reporting nothing between calls when the server had nothing", async () => {
    const s = setup();
    device(null);
    await s.detector.read();
    vi.advanceTimersByTime(1000);
    expect(await s.detector.read()).toBeNull();
    expect(s.api.spotifyNowPlaying).toHaveBeenCalledTimes(1);
  });
});

describe("permission", () => {
  it("is granted outside Tauri", async () => {
    core.isTauri.mockReturnValue(false);
    expect(await setup().detector.checkPermission()).toBe(true);
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("reports needs-permission when not granted", async () => {
    const s = setup();
    core.invoke.mockResolvedValue({ granted: false });
    expect(await s.detector.checkPermission()).toBe(false);
    expect(core.invoke).toHaveBeenCalledWith("plugin:nowplaying|check_permission");
    expect(s.detector.status).toEqual({ kind: "needs-permission" });
  });

  it("leaves the status alone when granted", async () => {
    const s = setup();
    core.invoke.mockResolvedValue({ granted: true });
    expect(await s.detector.checkPermission()).toBe(true);
    expect(s.detector.status).toEqual({ kind: "ok" });
  });

  it("assumes granted when the platform has no such command (desktop)", async () => {
    core.invoke.mockRejectedValue(new Error("unknown command"));
    expect(await setup().detector.checkPermission()).toBe(true);
  });

  it("requests the permission through the plugin, only inside Tauri", async () => {
    const s = setup();
    core.invoke.mockResolvedValue(undefined);
    await s.detector.requestPermission();
    expect(core.invoke).toHaveBeenCalledWith("plugin:nowplaying|request_permission");
    core.invoke.mockClear();
    core.isTauri.mockReturnValue(false);
    await s.detector.requestPermission();
    expect(core.invoke).not.toHaveBeenCalled();
  });
});

describe("capabilities", () => {
  it("reads them from the plugin", async () => {
    core.invoke.mockResolvedValue({ transport: true, seek: true, volume: false, events: true });
    expect(await setup().detector.capabilities()).toEqual({ transport: true, seek: true, volume: false, events: true });
    expect(core.invoke).toHaveBeenCalledWith("plugin:nowplaying|get_capabilities");
  });

  it("treats fields an older plugin doesn't send as false", async () => {
    core.invoke.mockResolvedValue({ transport: true, seek: true, volume: true });
    expect(await setup().detector.capabilities()).toEqual({ transport: true, seek: true, volume: true, events: false });
    core.invoke.mockResolvedValue({ transport: "yes" });
    expect(await setup().detector.capabilities()).toEqual({ transport: false, seek: false, volume: false, events: false });
  });

  it("has none outside Tauri or when the command fails", async () => {
    const none = { transport: false, seek: false, volume: false, events: false };
    core.invoke.mockRejectedValue(new Error("unknown command"));
    expect(await setup().detector.capabilities()).toEqual(none);
    core.isTauri.mockReturnValue(false);
    expect(await setup().detector.capabilities()).toEqual(none);
  });
});

describe("waitForPermission", () => {
  /** A document whose visibility the test controls. */
  function fakeDocument() {
    return Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  }

  it("returns false at once when access is already granted", async () => {
    core.invoke.mockResolvedValue({ granted: true });
    const onNeeded = vi.fn();
    expect(await setup().detector.waitForPermission(onNeeded, fakeDocument())).toBe(false);
    expect(onNeeded).not.toHaveBeenCalled();
  });

  it("asks, waits until the user returns with access granted, then returns true", async () => {
    const s = setup();
    const doc = fakeDocument();
    const onNeeded = vi.fn();
    core.invoke.mockResolvedValue({ granted: false });
    let done = false;
    const waiting = s.detector.waitForPermission(onNeeded, doc).then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(0);
    expect(onNeeded).toHaveBeenCalledTimes(1);
    // Back without granting it: keep waiting.
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    // Hidden: not checked.
    core.invoke.mockResolvedValue({ granted: true });
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    // True tells the caller to reload capabilities: Android's controls need the access.
    expect(await waiting).toBe(true);
  });
});
