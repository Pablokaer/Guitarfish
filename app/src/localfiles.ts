import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import type { Resolved } from "./localplayer";
import type { LocalTrack, MusicLibrary } from "./music";
import type { ImportFile } from "./musicimport";

/**
 * Where the music player's files come from. On desktop the library keeps paths and
 * the app shell opens them (src-tauri/src/localaudio.rs); elsewhere (Android, a
 * plain browser) a picked file can't be reopened by path after a restart, so its
 * audio is copied into the library instead.
 */

/** A file the shell checked: its size, or why it can't be used. Mirrors `OpenedFile` in localaudio.rs. */
export interface OpenedFile {
  path: string;
  name: string;
  size: number | null;
  error: string | null;
}

/** Desktop app: files are kept by path and streamed from disk. */
export function usesPaths(userAgent = navigator.userAgent): boolean {
  return isTauri() && !/android/i.test(userAgent);
}

/** Paths per local_audio_open call, below the shell's limit (MAX_PATHS in localaudio.rs). */
export const OPEN_BATCH = 500;

/** Lets the player and the importer use these files, a batch at a time. */
export async function openPaths(paths: string[]): Promise<OpenedFile[]> {
  const out: OpenedFile[] = [];
  for (let i = 0; i < paths.length; i += OPEN_BATCH) {
    out.push(...(await invoke<OpenedFile[]>("local_audio_open", { paths: paths.slice(i, i + OPEN_BATCH) })));
  }
  return out;
}

/** Part of a file opened with openPaths. */
export async function readPath(path: string, offset: number, len: number): Promise<Uint8Array> {
  const data = await invoke<ArrayBuffer | number[]>("local_audio_read", { path, offset, len });
  return new Uint8Array(data);
}

/** Files on disk to import, and those the shell refused (not found, not .mp3…). */
export async function filesFromPaths(paths: string[]): Promise<{ files: ImportFile[]; failed: { name: string; reason: string }[] }> {
  const files: ImportFile[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const f of await openPaths(paths)) {
    if (f.error || f.size == null) failed.push({ name: f.name || f.path, reason: f.error ?? "can't read the file" });
    else files.push({ name: f.name, size: f.size, path: f.path, read: (offset, len) => readPath(f.path, offset, len) });
  }
  return { files, failed };
}

/** The system file picker (desktop): the MP3 files chosen, or none if it was cancelled. */
export async function pickPaths(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: true, directory: false, title: "Import MP3 files", filters: [{ name: "MP3 audio", extensions: ["mp3", "MP3"] }] });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

/**
 * A playable URL for a track: the file on disk through the asset protocol (checked
 * first, so a moved or deleted file is reported as such), or the library's copy as
 * an object URL, revoked on release.
 */
export async function resolveTrack(track: LocalTrack, lib: Pick<MusicLibrary, "blob">): Promise<Resolved> {
  if (track.path) {
    const [opened] = await openPaths([track.path]);
    if (!opened || opened.error) throw new Error(`Can't play “${track.title}”: ${opened?.error ?? "the file can't be opened"} (${track.path}).`);
    return { url: convertFileSrc(track.path), release: () => {} };
  }
  const blob = await lib.blob(track.id);
  if (!blob) throw new Error(`Can't play “${track.title}”: its copy is missing from the library. Import the file again.`);
  const url = URL.createObjectURL(blob);
  return { url, release: () => URL.revokeObjectURL(url) };
}
