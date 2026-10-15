import { describe, expect, it, vi } from "vitest";
import {
  applyDownloadEvent,
  formatProgress,
  installUpdate,
  INITIAL_PROGRESS,
  updateAction,
  updateNotice,
  type DownloadEvent,
  type InstallerDeps,
} from "../src/selfupdate";
import type { UpdateInfo } from "../src/update";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile";

const info: UpdateInfo = { version: "0.4.0", name: "Guitarfish 0.4.0", url: "https://github.com/x/y/releases/tag/v0.4.0" };

describe("updateAction", () => {
  it("installs in place on desktop Tauri", () => {
    expect(updateAction({ tauri: true, userAgent: MAC })).toBe("install");
    expect(updateAction({ tauri: true, userAgent: WINDOWS })).toBe("install");
  });

  it("only links to the release page on Android and in a browser", () => {
    expect(updateAction({ tauri: true, userAgent: ANDROID })).toBe("download");
    expect(updateAction({ tauri: false, userAgent: MAC })).toBe("download");
  });
});

describe("updateNotice", () => {
  it("names the button and the notification after the action", () => {
    expect(updateNotice(info, "install")).toEqual({
      button: "Install and restart",
      title: "Guitarfish update available",
      body: "Version 0.4.0 is ready to install.",
    });
    expect(updateNotice(info, "download")).toEqual({
      button: "Download",
      title: "Guitarfish update available",
      body: "Version 0.4.0 is ready to download.",
    });
  });
});

describe("download progress", () => {
  function run(events: DownloadEvent[]) {
    return events.reduce(applyDownloadEvent, INITIAL_PROGRESS);
  }

  it("starts in the checking phase", () => {
    expect(formatProgress(INITIAL_PROGRESS)).toBe("Checking for the update…");
  });

  it("adds up chunks against the announced size", () => {
    const p = run([
      { event: "Started", data: { contentLength: 1000 } },
      { event: "Progress", data: { chunkLength: 250 } },
      { event: "Progress", data: { chunkLength: 170 } },
    ]);
    expect(p).toEqual({ phase: "downloading", downloaded: 420, total: 1000 });
    expect(formatProgress(p)).toBe("Downloading the update… 42%");
  });

  it("never shows more than 100%", () => {
    const p = run([
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 150 } },
    ]);
    expect(formatProgress(p)).toBe("Downloading the update… 100%");
  });

  it("shows megabytes when the size is unknown", () => {
    const p = run([{ event: "Started", data: {} }, { event: "Progress", data: { chunkLength: 3_250_000 } }]);
    expect(p.total).toBeNull();
    expect(formatProgress(p)).toBe("Downloading the update… 3.3 MB");
    const zero = run([{ event: "Started", data: { contentLength: 0 } }]);
    expect(formatProgress(zero)).toBe("Downloading the update… 0.0 MB");
  });

  it("switches to installing when the download finishes", () => {
    const p = run([{ event: "Started", data: { contentLength: 10 } }, { event: "Progress", data: { chunkLength: 10 } }, { event: "Finished" }]);
    expect(p.phase).toBe("installing");
    expect(formatProgress(p)).toBe("Installing the update…");
  });
});

describe("installUpdate", () => {
  function deps(overrides: Partial<InstallerDeps> = {}) {
    const statuses: string[] = [];
    const d: InstallerDeps & { statuses: string[] } = {
      check: vi.fn(async () => ({
        version: "0.4.0",
        downloadAndInstall: vi.fn(async (onEvent?: (e: DownloadEvent) => void) => {
          onEvent?.({ event: "Started", data: { contentLength: 200 } });
          onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
          onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
          onEvent?.({ event: "Finished" });
        }),
      })),
      relaunch: vi.fn(async () => {}),
      openUrl: vi.fn(async () => {}),
      onStatus: (s: string) => void statuses.push(s),
      statuses,
      ...overrides,
    };
    return d;
  }

  it("downloads, installs and relaunches, reporting progress", async () => {
    const d = deps();
    expect(await installUpdate(info, d)).toBe("relaunched");
    expect(d.relaunch).toHaveBeenCalledOnce();
    expect(d.openUrl).not.toHaveBeenCalled();
    expect(d.statuses).toEqual([
      "Checking for the update…",
      "Downloading the update… 0%",
      "Downloading the update… 50%",
      "Downloading the update… 100%",
      "Installing the update…",
      "Restarting…",
    ]);
  });

  it("opens the release page when the release has no updater manifest", async () => {
    const d = deps({ check: vi.fn(async () => null) });
    expect(await installUpdate(info, d)).toBe("fallback");
    expect(d.openUrl).toHaveBeenCalledWith(info.url);
    expect(d.relaunch).not.toHaveBeenCalled();
  });

  it("opens the release page when the check fails", async () => {
    const d = deps({
      check: vi.fn(async () => {
        throw new Error("signature mismatch");
      }),
    });
    expect(await installUpdate(info, d)).toBe("fallback");
    expect(d.openUrl).toHaveBeenCalledWith(info.url);
  });

  it("opens the release page when the download or install fails", async () => {
    const d = deps({
      check: vi.fn(async () => ({
        version: "0.4.0",
        downloadAndInstall: vi.fn(async () => {
          throw new Error("disk full");
        }),
      })),
    });
    expect(await installUpdate(info, d)).toBe("fallback");
    expect(d.openUrl).toHaveBeenCalledWith(info.url);
    expect(d.relaunch).not.toHaveBeenCalled();
  });

  it("asks for a manual restart when the relaunch fails after installing", async () => {
    const d = deps({
      relaunch: vi.fn(async () => {
        throw new Error("no relaunch");
      }),
    });
    expect(await installUpdate(info, d)).toBe("restart-needed");
    expect(d.openUrl).not.toHaveBeenCalled();
  });
});
