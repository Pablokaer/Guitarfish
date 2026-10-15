import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../src/types";

const core = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => core);

const { Detector } = await import("../src/detector");

const track = (title: string, extra: Partial<Track> = {}): Track => ({ title, artist: "Muse", isPlaying: true, source: "os", player: "Spotify", ...extra });

function setup() {
  return { detector: new Detector() };
}

/** Device reports `t` (null: nothing playing). */
const device = (t: Track | null) => core.invoke.mockResolvedValue({ track: t });

beforeEach(() => {
  vi.useFakeTimers();
  core.invoke.mockReset();
  core.isTauri.mockReturnValue(true);
});
afterEach(() => vi.useRealTimers());

describe("read", () => {
  it("reads the track from the device", async () => {
    const s = setup();
    const t = track("Uprising");
    device(t);
    expect(await s.detector.read()).toEqual(t);
    expect(core.invoke).toHaveBeenCalledWith("plugin:nowplaying|get_now_playing");
    expect(s.detector.status).toEqual({ kind: "ok" });
  });

  it("treats a missing track field as nothing playing", async () => {
    const s = setup();
    core.invoke.mockResolvedValue({});
    expect(await s.detector.read()).toBeNull();
    device(null);
    expect(await s.detector.read()).toBeNull();
  });

  it("sees nothing outside Tauri", async () => {
    const s = setup();
    core.isTauri.mockReturnValue(false);
    expect(await s.detector.read()).toBeNull();
    expect(core.invoke).not.toHaveBeenCalled();
    expect(s.detector.status).toEqual({ kind: "ok" });
  });

  it("reports a device error as nothing playing, until a read works again", async () => {
    const s = setup();
    core.invoke.mockRejectedValue("no player");
    expect(await s.detector.read()).toBeNull();
    expect(s.detector.status).toEqual({ kind: "error", message: "no player" });

    device(track("Uprising"));
    await s.detector.read();
    expect(s.detector.status).toEqual({ kind: "ok" });
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
