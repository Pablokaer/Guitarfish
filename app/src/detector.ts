import { invoke, isTauri } from "@tauri-apps/api/core";
import type { TabApi } from "./api";
import type { PlaybackCapabilities, Track } from "./types";

export type DetectorStatus =
  | { kind: "ok" }
  | { kind: "needs-permission" } // Android: notification access not granted
  | { kind: "error"; message: string };

/**
 * Combines the on-device detector (Tauri plugin) with the optional Spotify Web API
 * fallback served by the Guitarfish server.
 */
export class Detector {
  private lastFallbackAt = 0;
  private lastFallback: Track | null = null;
  status: DetectorStatus = { kind: "ok" };

  constructor(
    private api: TabApi,
    private opts: { fallbackEnabled: () => boolean; fallbackIntervalMs?: number },
  ) {}

  /** Read from the device. Null when nothing is playing or outside Tauri. */
  private async readDevice(): Promise<Track | null> {
    if (!isTauri()) return null;
    try {
      const r = await invoke<{ track?: Track | null }>("plugin:nowplaying|get_now_playing");
      this.status = { kind: "ok" };
      return r.track ?? null;
    } catch (e) {
      this.status = { kind: "error", message: String(e) };
      return null;
    }
  }

  private async readFallback(): Promise<Track | null> {
    if (!this.opts.fallbackEnabled()) return null;
    const interval = this.opts.fallbackIntervalMs ?? 3000;
    const now = Date.now();
    if (now - this.lastFallbackAt < interval) {
      // Between API calls, advance the last known position locally.
      if (this.lastFallback?.isPlaying && this.lastFallback.positionMs != null) {
        return { ...this.lastFallback, positionMs: this.lastFallback.positionMs + (now - this.lastFallbackAt) };
      }
      return this.lastFallback;
    }
    this.lastFallbackAt = now;
    try {
      this.lastFallback = await this.api.spotifyNowPlaying();
    } catch {
      this.lastFallback = null;
    }
    return this.lastFallback;
  }

  /** Device first; Spotify Web API only when the device reports nothing. */
  async read(): Promise<Track | null> {
    const device = await this.readDevice();
    if (device) return device;
    return this.readFallback();
  }

  async checkPermission(): Promise<boolean> {
    if (!isTauri()) return true;
    try {
      const r = await invoke<{ granted: boolean }>("plugin:nowplaying|check_permission");
      if (!r.granted) this.status = { kind: "needs-permission" };
      return r.granted;
    } catch {
      return true;
    }
  }

  async requestPermission(): Promise<void> {
    if (isTauri()) await invoke("plugin:nowplaying|request_permission");
  }

  /**
   * Which playback controls the device detector supports, and whether it emits
   * `nowplaying://changed`. Fields an older plugin doesn't send count as false.
   */
  async capabilities(): Promise<PlaybackCapabilities> {
    let raw: Partial<Record<keyof PlaybackCapabilities, unknown>> | null = null;
    if (isTauri()) {
      try {
        raw = await invoke("plugin:nowplaying|get_capabilities");
      } catch {
        /* older plugin: no controls */
      }
    }
    const flag = (v: unknown) => v === true;
    return { transport: flag(raw?.transport), seek: flag(raw?.seek), volume: flag(raw?.volume), events: flag(raw?.events) };
  }

  /**
   * Android: until Notification access is granted, calls `onNeeded` (to explain and
   * offer the settings) and waits for the user to come back with it granted. Returns
   * whether it had to wait, so the caller can reload what depends on the access
   * (capabilities).
   */
  async waitForPermission(
    onNeeded: () => void,
    doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
  ): Promise<boolean> {
    if (await this.checkPermission()) return false;
    onNeeded();
    await new Promise<void>((resolve) => {
      const check = async () => {
        if (doc.visibilityState === "visible" && (await this.checkPermission())) {
          doc.removeEventListener("visibilitychange", check);
          resolve();
        }
      };
      doc.addEventListener("visibilitychange", check);
    });
    return true;
  }
}
