import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PlaybackCapabilities, Track } from "./types";

export type DetectorStatus =
  | { kind: "ok" }
  | { kind: "needs-permission" } // Android: notification access not granted
  | { kind: "error"; message: string };

/**
 * Reads what Spotify plays on this device, through the now-playing plugin. Outside
 * the app (a plain browser) nothing is detected.
 */
export class Detector {
  status: DetectorStatus = { kind: "ok" };

  /** Null when nothing is playing, the player can't be read, or outside Tauri. */
  async read(): Promise<Track | null> {
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
