/**
 * Installing an update from inside the app (desktop). update.ts decides *whether*
 * there is a new release; this module decides *what to offer* and runs the
 * install through injected updater calls, so the rules are testable without
 * Tauri. Any failure falls back to the release page.
 */
import type { UpdateInfo } from "./update";

/** "install": download, install and relaunch in place. "download": open the release page. */
export type UpdateAction = "install" | "download";

/** The Tauri updater runs on desktop only; Android and a plain browser get the release page. */
export function updateAction(env: { tauri: boolean; userAgent: string }): UpdateAction {
  return env.tauri && !/android/i.test(env.userAgent) ? "install" : "download";
}

/** Banner button and system notification text for an update. */
export function updateNotice(u: UpdateInfo, action: UpdateAction): { button: string; title: string; body: string } {
  return {
    button: action === "install" ? "Install and restart" : "Download",
    title: "Guitarfish update available",
    body: `Version ${u.version} is ready to ${action}.`,
  };
}

/** The events `Update.downloadAndInstall` reports (tauri-plugin-updater). */
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface DownloadProgress {
  phase: "checking" | "downloading" | "installing";
  downloaded: number;
  /** Bytes announced by the server, or null when unknown. */
  total: number | null;
}

export const INITIAL_PROGRESS: DownloadProgress = { phase: "checking", downloaded: 0, total: null };

export function applyDownloadEvent(p: DownloadProgress, e: DownloadEvent): DownloadProgress {
  switch (e.event) {
    case "Started":
      return { phase: "downloading", downloaded: 0, total: e.data.contentLength ?? null };
    case "Progress":
      return { ...p, phase: "downloading", downloaded: p.downloaded + e.data.chunkLength };
    case "Finished":
      return { ...p, phase: "installing" };
  }
}

export function formatProgress(p: DownloadProgress): string {
  if (p.phase === "checking") return "Checking for the update…";
  if (p.phase === "installing") return "Installing the update…";
  const amount = p.total ? `${Math.min(100, Math.floor((p.downloaded / p.total) * 100))}%` : `${(p.downloaded / 1e6).toFixed(1)} MB`;
  return `Downloading the update… ${amount}`;
}

/** The parts of tauri-plugin-updater / -process / -opener the install needs. */
export interface InstallerDeps {
  check(): Promise<{ version: string; downloadAndInstall(onEvent?: (e: DownloadEvent) => void): Promise<void> } | null>;
  relaunch(): Promise<void>;
  openUrl(url: string): Promise<void>;
  onStatus(text: string): void;
}

/**
 * Downloads, installs and relaunches. When the updater can't do it (no
 * latest.json on that release, a bad signature, a network error), opens the
 * release page instead. "restart-needed": installed, but the relaunch failed.
 */
export async function installUpdate(u: UpdateInfo, deps: InstallerDeps): Promise<"relaunched" | "fallback" | "restart-needed"> {
  let progress = INITIAL_PROGRESS;
  deps.onStatus(formatProgress(progress));
  try {
    const update = await deps.check();
    if (!update) throw new Error("no updater manifest for this release");
    await update.downloadAndInstall((e) => {
      progress = applyDownloadEvent(progress, e);
      deps.onStatus(formatProgress(progress));
    });
  } catch (e) {
    console.warn(`in-app update to ${u.version} failed, opening the release page`, e);
    await deps.openUrl(u.url);
    return "fallback";
  }
  try {
    deps.onStatus("Restarting…");
    await deps.relaunch();
    return "relaunched";
  } catch (e) {
    console.warn("relaunch after update failed", e);
    return "restart-needed";
  }
}
